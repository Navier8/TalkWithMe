/**
 * test_tts_streaming.js — Regression tests for the streaming TTS pipeline
 * (the chunking and fetch/playback queues in static/tts.js).
 *
 * Run with plain Node (Node 20+, no npm packages, no network):
 *
 *     node tests/test_tts_streaming.js
 *
 * What it locks in:
 *   - the first chunk of each reply is cut EARLY (clause break past the
 *     minimum, hard flush past the cap) so audio starts sooner, while
 *     every later chunk keeps sentence granularity;
 *   - the aggressive split re-arms per reply, not per turn — in a
 *     multi-persona room every persona's reply gets its own fast start;
 *   - fetches run concurrently up to the cap, but PLAYBACK STAYS IN
 *     ORDER: a chunk whose synthesis finishes early does not jump the
 *     queue, and a chunk that yields no audio is skipped rather than
 *     stalling the player behind it forever;
 *   - the pipeline drains to a fully idle state, which is what
 *     latency.maybeFinish() gates the round-trip report on.
 *
 * How it works: the frontend scripts are browser globals (no ES modules),
 * so each test evaluates state.js + latency.js + tts.js in a fresh
 * vm.Context against a minimal DOM stub — the same technique as
 * test_persona_form.js and test_tts_settings.js. fetchTTS is replaced
 * wholesale (it is the network + Web Audio boundary); everything above it
 * is the real code.
 *
 * NOTE: this file is intentionally NOT part of the pytest suite (which
 * must run with nothing but Python installed). Run it alongside:
 *     python -m pytest
 *     node tests/test_persona_form.js
 *     node tests/test_tts_settings.js
 *     node tests/test_tts_streaming.js
 */

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const STATIC_DIR = path.join(__dirname, "..", "static");
// Load order mirrors templates/index.html for the scripts that matter here.
const APP_SCRIPTS = ["state.js", "latency.js", "tts.js"];

/* ==========================================================================
   Environment
   ========================================================================== */

/** Minimal element stub: state.js only stores these, it never drives them. */
function makeElement() {
    return {
        classList: { add() {}, remove() {}, contains() { return false; } },
        addEventListener() {},
        textContent: "",
        value: "",
        checked: false,
        disabled: false,
        style: {},
    };
}

/**
 * A fresh context with the app scripts evaluated in it.
 *
 * `let`/`const` at the top level of a script are LEXICAL bindings, not
 * properties of the global object, so the frontend's state globals
 * (ttsRequestQueue, ttsFirstChunkPending, ...) cannot be reached as
 * `sandbox.x`. Everything that touches them goes through get()/run(),
 * which evaluate inside the context — the same helper shape as
 * test_tts_settings.js. Function declarations DO land on the global
 * object, which is what makes stubbing fetchTTS/playAudio work.
 */
function loadApp() {
    const sandbox = {
        document: { getElementById: () => makeElement(), createElement: () => makeElement() },
        window: {},
        console,
        setTimeout,
        clearTimeout,
        performance,
        // Silence the persistence hop; the pipeline under test does not
        // depend on it and it is covered elsewhere.
        uploadAudio: async () => null,
        addAudioButtonToAssistantMessage: () => {},
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);

    for (const name of APP_SCRIPTS) {
        const code = fs.readFileSync(path.join(STATIC_DIR, name), "utf8");
        vm.runInContext(code, sandbox, { filename: name });
    }

    return {
        sandbox,
        /** Evaluate an expression inside the app context (reaches let/const globals). */
        get(expression) {
            return vm.runInContext(`(() => (${expression}))()`, sandbox);
        },
        /** Run a statement inside the app context (assigns to let globals). */
        run(statement) {
            return vm.runInContext(statement, sandbox);
        },
        /** Replace a top-level function declaration (these ARE global props). */
        stub(name, fn) {
            sandbox[name] = fn;
        },
    };
}

/** Feed a reply through the real accumulator one token at a time. */
function streamTokens(ctx, text, tokenSize = 3) {
    for (let i = 0; i < text.length; i += tokenSize) {
        ctx.sandbox.accumulateForTTS(text.slice(i, i + tokenSize), "Kirk");
    }
}

/**
 * Copy a value out of the vm realm into this one.
 *
 * Arrays built inside the context have that realm's Array.prototype, so
 * assert/strict's deepStrictEqual rejects them as "same structure but not
 * reference-equal" no matter what they contain. Array.from rebuilds them
 * with the host prototype.
 */
function hostArray(value) {
    return Array.from(value);
}

/** Let queued microtasks and timers settle. */
function settle(ms = 30) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/* ==========================================================================
   Chunking
   ========================================================================== */

test("first chunk cuts at a sentence terminal whenever one exists", () => {
    const ctx = loadApp();
    const { chunks, remaining } = ctx.get('extractTTSChunks("Hi there. And then some more")');

    assert.deepEqual(hostArray(chunks), ["Hi there."]);
    assert.equal(remaining, " And then some more");
});

test("first chunk cuts at a clause break once past the minimum", () => {
    const ctx = loadApp();
    // The comma sits past TTS_FIRST_CHUNK_MIN (40) and there is no terminal,
    // so the clause break is the cut — this is the whole point of the
    // aggressive first split.
    const text = "Well now that is a genuinely interesting question, and I have thoughts";
    const { chunks } = ctx.get(`extractTTSChunks(${JSON.stringify(text)})`);

    assert.equal(chunks.length, 1);
    assert.ok(chunks[0].endsWith(","), `expected a clause cut, got: ${chunks[0]}`);
    assert.ok(chunks[0].length >= ctx.get("TTS_FIRST_CHUNK_MIN"));
});

test("a clause break BEFORE the minimum is not a cut point", () => {
    const ctx = loadApp();
    // "Well, " would be a terrible first chunk: too short to be worth a
    // request, and audibly clipped.
    const { chunks, remaining } = ctx.get('extractTTSChunks("Well, yes")');

    assert.deepEqual(hostArray(chunks), []);
    assert.equal(remaining, "Well, yes");
});

test("first chunk hard-flushes at a word boundary past the cap", () => {
    const ctx = loadApp();
    const text = "a".repeat(70) + " tail and then rather more text besides";
    const { chunks } = ctx.get(`extractTTSChunks(${JSON.stringify(text)})`);

    assert.equal(chunks.length, 1);
    assert.equal(chunks[0], "a".repeat(70));
    // Never mid-word: the cut landed on the space, not at index 60.
    assert.ok(!chunks[0].endsWith("a".repeat(60) + "a") || chunks[0].length === 70);
});

test("nothing is emitted while the buffer is short and unpunctuated", () => {
    const ctx = loadApp();
    const { chunks, remaining } = ctx.get('extractTTSChunks("still typing")');

    assert.deepEqual(hostArray(chunks), []);
    assert.equal(remaining, "still typing");
});

test("after the first chunk, granularity falls back to whole sentences", () => {
    const ctx = loadApp();
    const queued = [];
    ctx.stub("enqueueStreamingTTS", (persona, text) => queued.push(text));

    streamTokens(ctx, "Sure. This is the second sentence, with a comma in it. And a third one.");

    assert.deepEqual(queued, [
        "Sure.",
        "This is the second sentence, with a comma in it.",
        "And a third one.",
    ]);
    // The comma in sentence two did NOT split it: only the first chunk
    // is allowed to cut on a clause break.
});

test("the aggressive split re-arms for each reply", () => {
    const ctx = loadApp();
    const queued = [];
    ctx.stub("enqueueStreamingTTS", (persona, text) => queued.push(text));

    streamTokens(ctx, "First reply. Tail of it.");
    assert.equal(ctx.get("ttsFirstChunkPending"), false);

    // Exactly what chat.js does on the next "start" event.
    ctx.run('sentenceBuffer = ""; ttsFirstChunkPending = true;');

    queued.length = 0;
    // A comma past the 40-char minimum and no terminal before it: only a
    // re-armed first-chunk split can cut here.
    streamTokens(ctx, "Second persona speaking at considerable length now, and on it goes");

    assert.ok(queued.length >= 1);
    assert.ok(queued[0].endsWith(","), `second reply got no early cut: ${queued[0]}`);
});

/* ==========================================================================
   Fetch concurrency and playback order
   ========================================================================== */

/**
 * Replace fetchTTS with a controllable fake.
 *
 * Returns a handle whose `resolve(text)` settles the fetch for that chunk,
 * so a test can finish them deliberately out of order. `played` records
 * playback order; `peak` records the highest observed concurrency.
 */
function installFakeTTS(ctx) {
    const pending = new Map();   // text -> resolve fn
    const played = [];
    const state = { inFlight: 0, peak: 0 };

    ctx.stub("fetchTTS", (personaName, text) => {
        state.inFlight++;
        state.peak = Math.max(state.peak, state.inFlight);
        return new Promise(resolve => {
            pending.set(text, (value) => {
                state.inFlight--;
                resolve(value);
            });
        });
    });
    ctx.stub("playAudio", async (buffer) => { played.push(buffer); });

    return {
        played,
        state,
        // `audio` is the stand-in AudioBuffer; null means "no audio".
        settleChunk(text, audio) {
            const resolve = pending.get(text);
            assert.ok(resolve, `no in-flight fetch for chunk: ${text}`);
            pending.delete(text);
            resolve(audio === undefined ? { id: text } : audio);
        },
        isPending(text) { return pending.has(text); },
    };
}

test("fetches run concurrently, but only up to the cap", async () => {
    const ctx = loadApp();
    const fake = installFakeTTS(ctx);

    ctx.sandbox.enqueueStreamingTTS("Kirk", "one.");
    ctx.sandbox.enqueueStreamingTTS("Kirk", "two.");
    ctx.sandbox.enqueueStreamingTTS("Kirk", "three.");
    await settle();

    assert.equal(ctx.get("TTS_MAX_CONCURRENT_FETCHES"), 2);
    assert.equal(fake.state.inFlight, 2, "two fetches should be in flight");
    assert.ok(!fake.isPending("three."), "the third must wait for a free slot");
    assert.equal(ctx.get("ttsRequestQueue.length"), 1);

    fake.settleChunk("one.");
    await settle();
    assert.ok(fake.isPending("three."), "freeing a slot must start the next fetch");
});

test("playback stays in order when a later fetch finishes first", async () => {
    const ctx = loadApp();
    const fake = installFakeTTS(ctx);

    ctx.sandbox.enqueueStreamingTTS("Kirk", "first.");
    ctx.sandbox.enqueueStreamingTTS("Kirk", "second.");
    await settle();

    // The SECOND chunk's synthesis comes back first.
    fake.settleChunk("second.");
    await settle();
    assert.deepEqual(fake.played, [], "nothing may play before chunk one");

    fake.settleChunk("first.");
    // Long enough to clear the 80 ms inter-chunk gap between the two.
    await settle(300);
    assert.deepEqual(
        fake.played.map(b => b.id),
        ["first.", "second."],
        "playback order must follow the queue, not completion order",
    );
});

test("a chunk that yields no audio is skipped, not waited on", async () => {
    const ctx = loadApp();
    const fake = installFakeTTS(ctx);

    ctx.sandbox.enqueueStreamingTTS("Kirk", "silent.");
    ctx.sandbox.enqueueStreamingTTS("Kirk", "audible.");
    await settle();

    fake.settleChunk("audible.");
    fake.settleChunk("silent.", null);   // synthesis produced nothing
    await settle(300);

    assert.deepEqual(fake.played.map(b => b.id), ["audible."],
        "the failed chunk must not block the one behind it");
});

test("the pipeline drains to a fully idle state", async () => {
    const ctx = loadApp();
    const fake = installFakeTTS(ctx);

    ctx.sandbox.enqueueStreamingTTS("Kirk", "alpha.");
    ctx.sandbox.enqueueStreamingTTS("Kirk", "beta.");
    await settle();
    fake.settleChunk("alpha.");
    fake.settleChunk("beta.");
    await settle(200);   // playback inserts an 80 ms gap per chunk

    // Exactly the conditions latency.maybeFinish() gates the report on.
    assert.equal(ctx.get("ttsRequestQueue.length"), 0);
    assert.equal(ctx.get("ttsReadyBuffers.size"), 0);
    assert.equal(ctx.get("isFetchingTTS"), false);
    assert.equal(ctx.get("isPlayingAudioBuffer"), false);
    assert.equal(fake.state.inFlight, 0);
});
