/**
 * tts.js — Text-to-Speech: toggle, audio queues, streaming, playback.
 *
 * Supports two modes:
 *  - Non-streaming: enqueue full text after LLM finishes responding.
 *  - Streaming: split response into sentences, fetch and play in a pipeline.
 *
 * Audio persistence: each TTS item is stamped with its message ID at
 * enqueue time (the ID is issued by the server in the "start" event), so
 * audio is always associated with the correct message regardless of when
 * the fetch resolves — no shared-state lookup at resolution time.
 */

/* ==========================================================================
   Toggle UI
   ========================================================================== */

function updateTTSToggleUI() {
    if (ttsEnabled) {
        ttsIcon.textContent = "\u{1F50A}";  // 🔊
        ttsIcon.classList.remove("muted");
    } else {
        ttsIcon.textContent = "\u{1F507}";  // 🔇
        ttsIcon.classList.add("muted");
    }
}

function toggleTTS() {
    if (!ttsAvailable) return;
    ttsEnabled = !ttsEnabled;
    updateTTSToggleUI();
}

/* ==========================================================================
   Non-streaming TTS (enqueue full text after LLM finishes)
   ========================================================================== */

function enqueueTTS(personaName, text) {
    // Capture the current assistant message ID so this audio request
    // knows which message it belongs to, even if the global ID changes
    // before the async fetch completes.
    audioQueue.push({ personaName, text, messageId: currentAssistantMessageId });
    processAudioQueue();
}

async function processAudioQueue() {
    if (isPlayingAudio || audioQueue.length === 0) return;
    isPlayingAudio = true;

    const item = audioQueue.shift();
    try {
        const audioBuffer = await fetchTTS(item.personaName, item.text, item.messageId);
        if (audioBuffer) {
            latency.mark("ttsFirstAudio");
            await playAudio(audioBuffer);
        }
    } catch (err) {
        console.warn("TTS playback error:", err);
    } finally {
        isPlayingAudio = false;
        latency.maybeFinish();
        setTimeout(() => processAudioQueue(), 100);
    }
}

/* ==========================================================================
   Streaming TTS (chunk-by-chunk: fetch and play are pipelined)
   ========================================================================== */

/**
 * How many /api/tts fetches may be in flight at once.
 *
 * Two, not one: with a single fetch the pipeline alternates
 * synthesize-then-play, so every chunk's synthesis is dead air. With two,
 * the next chunk is synthesized WHILE the current one plays, and playback
 * runs gapless as long as synthesis is faster than real time.
 *
 * Not higher than two on purpose. The synthesis it overlaps runs on the
 * same GPU the LLM is generating on; more concurrency past the point where
 * audio is ready before it is needed just steals throughput from token
 * generation, which delays the chunks that have not been queued yet.
 */
const TTS_MAX_CONCURRENT_FETCHES = 2;

/**
 * Minimum characters before the FIRST chunk may be cut at a soft break.
 * Below this a clause is too short to be worth a whole synthesis request
 * (per-request overhead would dominate) and sounds clipped.
 */
const TTS_FIRST_CHUNK_MIN = 40;

/**
 * Hard flush point for the first chunk: cut at the next word boundary past
 * this many characters even with no punctuation in sight. Bounds the wait
 * when a reply opens with a long unpunctuated clause.
 */
const TTS_FIRST_CHUNK_MAX = 60;

/** Soft break characters — clause boundaries the first chunk may cut on. */
const TTS_SOFT_BREAKS = ",;:\u2014\u2013-";

/**
 * Split accumulated text into complete sentences (ending with . ! ?)
 * Returns the sentences found and any remaining fragment without a terminal.
 */
function extractSentences(text) {
    const sentences = [];
    const regex = /[^.!?]*[.!?]+/g;
    let lastIndex = 0;
    let match;
    while ((match = regex.exec(text)) !== null) {
        const s = match[0].trim();
        if (s) sentences.push(s);
        lastIndex = regex.lastIndex;
    }
    return { sentences, remaining: text.slice(lastIndex) };
}

/**
 * Find where to cut the first chunk of a reply, or -1 to keep waiting.
 *
 * Nothing can play until the first chunk has been synthesized, and
 * synthesis time scales with chunk length — so the opening chunk is cut as
 * early as it can be without sounding clipped, and only the opening one.
 * Preference order:
 *   1. a sentence terminal (. ! ?)  — always the best cut, at any length
 *   2. a clause break (, ; : — –)   — once past TTS_FIRST_CHUNK_MIN
 *   3. a word boundary              — once past TTS_FIRST_CHUNK_MAX
 *
 * Returns the index one PAST the last character of the chunk.
 */
function findFirstChunkEnd(text) {
    const terminal = text.search(/[.!?]/);
    if (terminal !== -1) return terminal + 1;

    for (let i = TTS_FIRST_CHUNK_MIN; i < text.length; i++) {
        if (TTS_SOFT_BREAKS.includes(text[i])) return i + 1;
    }

    if (text.length > TTS_FIRST_CHUNK_MAX) {
        // Cut at the first space past the cap so a word is never split in
        // half — a half word is audibly wrong in a way a long chunk is not.
        const space = text.indexOf(" ", TTS_FIRST_CHUNK_MAX);
        if (space !== -1) return space;
    }
    return -1;
}

/**
 * Pull the chunks ready to synthesize out of the accumulated text.
 *
 * The first chunk of a reply uses findFirstChunkEnd (cut early, to start
 * audio sooner); everything after it uses sentence granularity, which
 * gives the engine whole sentences to work with and sounds better.
 */
function extractTTSChunks(text) {
    const chunks = [];
    let rest = text;

    if (ttsFirstChunkPending) {
        const end = findFirstChunkEnd(rest);
        if (end === -1) return { chunks, remaining: rest };
        const first = rest.slice(0, end).trim();
        rest = rest.slice(end);
        if (first) {
            chunks.push(first);
            ttsFirstChunkPending = false;
        }
    }

    const { sentences, remaining } = extractSentences(rest);
    return { chunks: chunks.concat(sentences), remaining };
}

/**
 * Append a token to the sentence buffer and queue any newly complete chunks.
 */
function accumulateForTTS(token, personaName) {
    sentenceBuffer += token;
    const { chunks, remaining } = extractTTSChunks(sentenceBuffer);
    sentenceBuffer = remaining;
    for (const chunk of chunks) {
        enqueueStreamingTTS(personaName, chunk);
    }
}

/** Push a chunk into the fetch queue and kick off the fetch pipeline. */
function enqueueStreamingTTS(personaName, text) {
    // Stamp the current message ID at enqueue time. It was issued by the
    // server in the "start" event, so it is already correct for this
    // response — no backfilling needed when "done" arrives.
    //
    // The sequence number is stamped here too, and it is what keeps
    // playback in order once fetches are allowed to finish out of order.
    ttsRequestQueue.push({
        personaName,
        text,
        messageId: currentAssistantMessageId,
        seq: ttsNextSeq++,
    });
    processTTSRequests();
}

/**
 * Start fetches for queued chunks, up to TTS_MAX_CONCURRENT_FETCHES at once.
 *
 * Each completed fetch files its decoded buffer under its sequence number
 * and pokes the player; the player is what enforces order, so a fetch
 * finishing early or late changes nothing about what the user hears.
 */
function processTTSRequests() {
    while (ttsInFlight < TTS_MAX_CONCURRENT_FETCHES && ttsRequestQueue.length > 0) {
        runTTSFetch(ttsRequestQueue.shift());
    }
}

/** Fetch one queued chunk and file the result under its sequence number. */
async function runTTSFetch(item) {
    ttsInFlight++;
    isFetchingTTS = true;
    try {
        const audioBuffer = await fetchTTS(item.personaName, item.text, item.messageId);
        // null is filed too: the player must know this sequence is settled
        // and skip it, rather than stalling forever waiting for audio that
        // is never coming.
        ttsReadyBuffers.set(item.seq, audioBuffer || null);
    } catch (err) {
        console.warn("TTS streaming fetch error:", err);
        ttsReadyBuffers.set(item.seq, null);
    } finally {
        ttsInFlight--;
        isFetchingTTS = ttsInFlight > 0;
        processAudioBufferQueue();
        // Backfill the slot this fetch just freed.
        processTTSRequests();
        latency.maybeFinish();  // covers a fetch that produced no audio to play
    }
}

/**
 * Play decoded audio buffers in sequence order, with a small gap between
 * chunks. Runs independently of the fetch pipeline, so playback starts as
 * soon as the first buffer is ready — but it will not skip ahead: if
 * sequence N is still fetching, N+1 waits even though it is ready.
 */
async function processAudioBufferQueue() {
    if (isPlayingAudioBuffer) return;
    if (!ttsReadyBuffers.has(ttsNextPlaySeq)) return;
    isPlayingAudioBuffer = true;

    try {
        // Drain every consecutive ready sequence in one pass, so a buffer
        // that arrived while the previous one was playing starts with no
        // extra round through the event loop.
        while (ttsReadyBuffers.has(ttsNextPlaySeq)) {
            const buffer = ttsReadyBuffers.get(ttsNextPlaySeq);
            ttsReadyBuffers.delete(ttsNextPlaySeq);
            ttsNextPlaySeq++;
            if (!buffer) continue;  // settled-but-empty: skip, do not stall
            try {
                latency.mark("ttsFirstAudio");
                await playAudio(buffer);
                await new Promise(resolve => setTimeout(resolve, 80)); // brief inter-chunk gap
            } catch (err) {
                console.warn("Audio buffer playback error:", err);
            }
        }
    } finally {
        isPlayingAudioBuffer = false;
        latency.maybeFinish();
    }
}

/* ==========================================================================
   Shared TTS helpers
   ========================================================================== */

/**
 * Fetch TTS audio from the server and persist it to disk.
 *
 * @param {string} personaName - Which persona to synthesize for.
 * @param {string} text - Text to synthesize.
 * @param {string|null} messageId - The message ID this audio belongs to.
 *   Stamped at enqueue time from the "start" event, so it is correct
 *   regardless of when this fetch resolves.
 */
async function fetchTTS(personaName, text, messageId) {
    latency.mark("ttsFirstReq");
    const resp = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, persona_name: personaName }),
    });

    if (!resp.ok) {
        console.warn("TTS request failed:", resp.status);
        return null;
    }

    const data = await resp.json();
    if (!data.audio_base64) return null;

    // Persist the audio against the message it was enqueued for.
    if (messageId) {
        uploadAudio(currentChatRoom, messageId, data.audio_base64, "audio/wav")
            .then(result => {
                if (result && result.filename) {
                    // Inject a playback button into the live chat bubble
                    addAudioButtonToAssistantMessage(messageId, result.filename);
                }
            })
            .catch(err => console.warn("Failed to persist TTS audio:", err));
    } else {
        // Should not happen with the current protocol (the "start" event
        // always carries a message_id). Warn loudly so a server/frontend
        // version mismatch is visible instead of silently dropping audio.
        console.warn("fetchTTS: no message ID available; audio will play but not be persisted");
    }

    // Decode base64 to ArrayBuffer for playback
    const binary = atob(data.audio_base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }

    // Initialize AudioContext lazily (requires user gesture, which we have from the chat flow)
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === "suspended") {
        await audioCtx.resume();
    }

    return await audioCtx.decodeAudioData(bytes.buffer);
}

async function playAudio(buffer) {
    if (audioCtx.state === "suspended") {
        await audioCtx.resume();
    }
    return new Promise((resolve) => {
        const source = audioCtx.createBufferSource();
        source.buffer = buffer;
        source.connect(audioCtx.destination);
        source.onended = resolve;
        source.start();
    });
}

