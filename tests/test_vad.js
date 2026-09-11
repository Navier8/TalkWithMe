/**
 * test_vad.js — Regression tests for the voice-activation detector
 * (the pure state machine in static/vad.js).
 *
 * Run with plain Node (Node 20+, no npm packages, no network):
 *
 *     node tests/test_vad.js
 *
 * What it locks in:
 *   - the room's own noise never arms the microphone, however loud the
 *     room is, because every threshold is a multiple of a MEASURED floor —
 *     and that floor stops adapting the moment recording starts, so the
 *     speaker's own voice cannot drag the release threshold up behind it;
 *   - a false start (a door, a cough, a fan spinning up) is DISCARDED, not
 *     transcribed: recording begins early, on purpose, so the leading
 *     consonant survives, and the blob is thrown away if real speech never
 *     follows;
 *   - a pause inside a sentence does not end the turn, and the silence
 *     that does end it is the configured one;
 *   - transcripts Whisper hallucinates on near-silence never reach the
 *     auto-send path.
 *
 * How it works: the frontend scripts are browser globals (no ES modules),
 * so each test evaluates state.js + vad.js in a fresh vm.Context against a
 * minimal DOM stub — the same technique as test_persona_form.js,
 * test_tts_settings.js and test_tts_streaming.js. Nothing here touches Web
 * Audio: the detector's state machine takes RMS numbers and a frame
 * duration, which is exactly what these tests feed it.
 *
 * NOTE: this file is intentionally NOT part of the pytest suite (which
 * must run with nothing but Python installed). Run it alongside:
 *     python -m pytest
 *     node tests/test_persona_form.js
 *     node tests/test_tts_settings.js
 *     node tests/test_tts_streaming.js
 *     node tests/test_vad.js
 */

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const STATIC_DIR = path.join(__dirname, "..", "static");
// Load order mirrors templates/index.html for the scripts that matter here.
const APP_SCRIPTS = ["state.js", "vad.js"];

/* ==========================================================================
   Environment
   ========================================================================== */

/** Minimal element stub: state.js only stores these, it never drives them. */
function makeElement() {
    return {
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        addEventListener() {},
        setAttribute() {},
        style: { setProperty() {} },
        textContent: "",
        value: "",
        checked: false,
        disabled: false,
    };
}

/**
 * A fresh context with the app scripts evaluated in it.
 *
 * `let`/`const` at the top level of a script are LEXICAL bindings, not
 * properties of the global object, so the constants and state globals
 * cannot be reached as `sandbox.x`; get()/run() evaluate inside the
 * context instead. Function declarations DO land on the global object,
 * which is what makes calling vadStep() (and stubbing) work.
 */
function loadApp() {
    const sandbox = {
        document: { getElementById: () => makeElement(), createElement: () => makeElement() },
        window: {},
        console,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        performance,
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
    };
}

/* ==========================================================================
   Frame helpers
   ========================================================================== */

const FRAME_MS = 25;

/**
 * Feed a constant level for a duration, collecting the events emitted.
 *
 * @returns {{state: object, events: string[]}}
 */
function feed(ctx, state, rms, durationMs, frameMs = FRAME_MS) {
    const events = [];
    let current = state;
    for (let elapsed = 0; elapsed < durationMs; elapsed += frameMs) {
        const stepped = ctx.sandbox.vadStep(current, rms, frameMs);
        current = stepped.state;
        if (stepped.event) events.push(stepped.event);
    }
    return { state: current, events };
}

/** A state whose floor has already settled on a room at `roomLevel`. */
function settledState(ctx, roomLevel, options = {}) {
    let state = ctx.sandbox.createVadState({ sensitivity: 3, silenceMs: 900, ...options });
    // Long enough for the slow (rising) EMA to converge on the room.
    ({ state } = feed(ctx, state, roomLevel, 4000));
    return state;
}

/* ==========================================================================
   Noise floor
   ========================================================================== */

test("a steady room never arms the microphone, quiet or loud", () => {
    const ctx = loadApp();
    for (const roomLevel of [0.001, 0.01, 0.05]) {
        const state = ctx.sandbox.createVadState({ sensitivity: 3, silenceMs: 900 });
        const { state: after, events } = feed(ctx, state, roomLevel, 10000);
        assert.deepEqual(events, [], `room at ${roomLevel} triggered ${events}`);
        assert.equal(after.phase, "idle");
        // The floor tracked the room rather than sitting at the minimum.
        assert.ok(Math.abs(after.floor - roomLevel) < roomLevel * 0.1);
    }
});

test("digital silence does not collapse the thresholds to zero", () => {
    const ctx = loadApp();
    const minFloor = ctx.get("VAD_MIN_NOISE_FLOOR");
    let state = ctx.sandbox.createVadState({});
    ({ state } = feed(ctx, state, 0, 5000));
    assert.equal(state.floor, minFloor);
    // A hiss well under a real voice must still not read as speech.
    const { events } = feed(ctx, state, minFloor, 2000);
    assert.deepEqual(events, []);
});

test("the floor falls faster than it rises", () => {
    const ctx = loadApp();
    const adapt = ctx.sandbox.adaptNoiseFloor;
    const rise = adapt(0.01, 0.02) - 0.01;   // room got louder
    const fall = 0.01 - adapt(0.01, 0.0);    // room went quiet
    assert.ok(fall > rise * 5, `fall ${fall} should outpace rise ${rise}`);
});

/* ==========================================================================
   Utterance detection
   ========================================================================== */

test("speech arms, confirms, and ends after the configured silence", () => {
    const ctx = loadApp();
    const room = 0.004;
    let state = settledState(ctx, room);

    let events;
    ({ state, events } = feed(ctx, state, room * 6, 1500));
    assert.deepEqual(events, ["arm", "speech"]);

    // A pause shorter than silence_ms must NOT end the turn.
    ({ state, events } = feed(ctx, state, room, 500));
    assert.deepEqual(events, []);
    assert.equal(state.phase, "speech");

    // ...and speech resumes on the same utterance.
    ({ state, events } = feed(ctx, state, room * 6, 500));
    assert.deepEqual(events, []);

    ({ state, events } = feed(ctx, state, room, 1000));
    assert.deepEqual(events, ["end"]);
    assert.equal(state.phase, "idle");
});

test("a click or cough arms but is discarded, never transcribed", () => {
    const ctx = loadApp();
    const room = 0.004;
    let state = settledState(ctx, room);

    // Loud, but far shorter than the confirmation window.
    let events;
    ({ state, events } = feed(ctx, state, room * 8, 50));
    assert.deepEqual(events, ["arm"]);
    ({ state, events } = feed(ctx, state, room, 1500));
    assert.deepEqual(events, ["discard"]);
    assert.equal(state.phase, "idle");
});

test("confirmed speech that is over almost at once is still discarded", () => {
    const ctx = loadApp();
    const room = 0.004;
    let state = settledState(ctx, room);

    // Long enough to confirm, short enough to be a bark rather than a word.
    let events;
    ({ state, events } = feed(ctx, state, room * 8, ctx.get("VAD_CONFIRM_MS") + 25));
    assert.deepEqual(events, ["arm", "speech"]);
    ({ state, events } = feed(ctx, state, room, 1500));
    assert.deepEqual(events, ["discard"]);
});

test("sustained noise under the speech threshold gives up and holds off", () => {
    const ctx = loadApp();
    const room = 0.004;
    const thresholds = ctx.get("VAD_SENSITIVITY")[3];
    let state = settledState(ctx, room);

    // Between arm and speech: the fan spinning up, the truck outside.
    const midLevel = room * (thresholds.arm + thresholds.speech) / 2;
    let events;
    ({ state, events } = feed(ctx, state, midLevel, ctx.get("VAD_ARM_TIMEOUT_MS") + 50));
    assert.deepEqual(events, ["arm", "discard"]);

    // The hold-off keeps it from immediately re-arming on the same noise;
    // by the time it expires the floor has begun following the room up.
    ({ state, events } = feed(ctx, state, midLevel, ctx.get("VAD_HOLDOFF_MS") - 50));
    assert.deepEqual(events, []);
});

test("a long utterance is capped, and kept rather than discarded", () => {
    const ctx = loadApp();
    const room = 0.004;
    let state = settledState(ctx, room);
    const maxMs = ctx.get("VAD_MAX_UTTERANCE_MS");

    const { state: after, events } = feed(ctx, state, room * 6, maxMs + 500);
    assert.deepEqual(events, ["arm", "speech", "end"]);
    assert.equal(after.phase, "idle");
});

test("the floor is frozen while recording, so loud speech still ends", () => {
    const ctx = loadApp();
    const room = 0.004;
    let state = settledState(ctx, room);
    const floorBefore = state.floor;

    // Shouting for a while: if the floor chased this, the release
    // threshold would climb past the room and the turn would never end.
    let events;
    ({ state, events } = feed(ctx, state, room * 40, 3000));
    assert.deepEqual(events, ["arm", "speech"]);
    assert.equal(state.floor, floorBefore);

    ({ state, events } = feed(ctx, state, room, 1000));
    assert.deepEqual(events, ["end"]);
});

test("one long frame (a throttled background tab) ends the turn", () => {
    const ctx = loadApp();
    const room = 0.004;
    let state = settledState(ctx, room);
    let events;
    ({ state, events } = feed(ctx, state, room * 6, 1000));
    assert.deepEqual(events, ["arm", "speech"]);

    // A single second-long quiet frame counts as a second of silence — the
    // detector reads wall-clock deltas, not a nominal frame duration.
    const stepped = ctx.sandbox.vadStep(state, room, 1000);
    assert.equal(stepped.event, "end");
});

test("sensitivity decides how far above the room speech must be", () => {
    const ctx = loadApp();
    const room = 0.004;
    // Above sensitivity 5's speech threshold (2.0x), below sensitivity 1's
    // arm threshold (2.6x): a soft voice in a quiet room.
    const softVoice = room * 2.2;

    const quiet = feed(ctx, settledState(ctx, room, { sensitivity: 1 }), softVoice, 1000);
    assert.deepEqual(quiet.events, [], "sensitivity 1 should ignore a murmur");

    const keen = feed(ctx, settledState(ctx, room, { sensitivity: 5 }), softVoice, 1000);
    assert.deepEqual(keen.events, ["arm", "speech"], "sensitivity 5 should hear it");
});

test("silence_ms is honoured as configured", () => {
    const ctx = loadApp();
    const room = 0.004;
    for (const silenceMs of [400, 2000]) {
        let state = settledState(ctx, room, { silenceMs });
        ({ state } = feed(ctx, state, room * 6, 1000));

        // Just short of the configured silence: still the same turn.
        let events;
        ({ state, events } = feed(ctx, state, room, silenceMs - 100));
        assert.deepEqual(events, [], `ended early at silenceMs=${silenceMs}`);
        ({ events } = feed(ctx, state, room, 200));
        assert.deepEqual(events, ["end"], `did not end at silenceMs=${silenceMs}`);
    }
});

test("an unknown sensitivity falls back to the default instead of throwing", () => {
    const ctx = loadApp();
    const fallback = ctx.sandbox.vadThresholds(99);
    assert.deepEqual(fallback, ctx.get("VAD_SENSITIVITY")[ctx.get("VAD_DEFAULT_SENSITIVITY")]);
});

/* ==========================================================================
   Frame measurement and the UI meter
   ========================================================================== */

test("frame RMS measures amplitude, and survives an empty frame", () => {
    const ctx = loadApp();
    assert.equal(ctx.sandbox.vadFrameRms(new Float32Array([1, -1, 1, -1])), 1);
    assert.equal(ctx.sandbox.vadFrameRms(new Float32Array([0, 0])), 0);
    assert.equal(ctx.sandbox.vadFrameRms(new Float32Array([])), 0);
    assert.ok(Math.abs(ctx.sandbox.vadFrameRms(new Float32Array([0.5, -0.5])) - 0.5) < 1e-9);
});

test("the meter level is 0 while idle and clamps at 1 while speaking", () => {
    const ctx = loadApp();
    assert.equal(ctx.sandbox.vadMeterLevel(), 0, "no detector running");

    const room = 0.004;
    ctx.run("vadState = null;");
    ctx.sandbox.__state = settledState(ctx, room);
    ctx.run("vadState = __state;");
    assert.ok(ctx.sandbox.vadMeterLevel() < 0.5);

    ctx.sandbox.__state = feed(ctx, ctx.sandbox.__state, room * 40, 1000).state;
    ctx.run("vadState = __state;");
    assert.equal(ctx.sandbox.vadMeterLevel(), 1);
});

/* ==========================================================================
   Half-duplex gating
   ========================================================================== */

test("every reply-side activity counts as busy", () => {
    const ctx = loadApp();
    assert.equal(ctx.sandbox.vadOutputBusy(), false);

    const flags = ["isStreaming", "sttInFlight", "isFetchingTTS", "isPlayingAudio", "isPlayingAudioBuffer"];
    for (const flag of flags) {
        ctx.run(`${flag} = true;`);
        assert.equal(ctx.sandbox.vadOutputBusy(), true, `${flag} should suspend detection`);
        ctx.run(`${flag} = false;`);
    }

    // Queued work counts too: audio that has not started playing yet is
    // still audio the microphone must not hear.
    ctx.run("ttsRequestQueue.push({});");
    assert.equal(ctx.sandbox.vadOutputBusy(), true);
    ctx.run("ttsRequestQueue.length = 0;");
    ctx.run("ttsReadyBuffers.set(0, null);");
    assert.equal(ctx.sandbox.vadOutputBusy(), true);
    ctx.run("ttsReadyBuffers.clear();");
    assert.equal(ctx.sandbox.vadOutputBusy(), false);
});

/* ==========================================================================
   Transcript sanity
   ========================================================================== */

test("hallucinated silence transcripts are recognised", () => {
    const ctx = loadApp();
    const noise = [
        "", "   ", ".", "...", "♪♪♪", "you", "You.", "  THANK YOU! ",
        "Thanks for watching", "Subtitles by the Amara.org community", "uh", "Hmm.",
    ];
    for (const text of noise) {
        assert.equal(ctx.sandbox.isProbablyNoiseTranscript(text), true, `${JSON.stringify(text)} should read as noise`);
    }
});

test("short real answers are never mistaken for noise", () => {
    const ctx = loadApp();
    const speech = [
        "yes", "No.", "stop", "okay", "thank you very much", "what time is it?",
        "you should try the other one", "42",
    ];
    for (const text of speech) {
        assert.equal(ctx.sandbox.isProbablyNoiseTranscript(text), false, `${JSON.stringify(text)} should read as speech`);
    }
});

test("a null or undefined transcript is noise, not a crash", () => {
    const ctx = loadApp();
    assert.equal(ctx.sandbox.isProbablyNoiseTranscript(null), true);
    assert.equal(ctx.sandbox.isProbablyNoiseTranscript(undefined), true);
});
