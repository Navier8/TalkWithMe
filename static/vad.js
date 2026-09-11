/**
 * vad.js — voice activation: hands-free start/stop of the microphone.
 *
 * The push-to-talk path (stt.js) is unchanged; this module is the thing
 * that presses the button for you. It watches the *already cached* mic
 * stream through a Web Audio AnalyserNode and drives the same recorder
 * start/stop that a click would.
 *
 * Three decisions shape everything below:
 *
 *  - Thresholds are MULTIPLES OF A MEASURED NOISE FLOOR, never absolute
 *    levels. A fixed dB threshold works in exactly one room; the same
 *    number is deaf in a kitchen and trigger-happy in a padded study. The
 *    floor is an asymmetric EMA — it falls fast (the fan stopped) and
 *    rises slowly (that was speech, not the room) — and it only adapts
 *    while idle, so the user's own voice can never drag the floor up
 *    behind the release threshold mid-sentence.
 *
 *  - Recording starts EARLY, on a low "something is happening" threshold,
 *    and the utterance is thrown away if the real speech threshold is not
 *    reached shortly after. Waiting for confidence before hitting record
 *    costs the first ~200 ms of audio — usually the leading consonant —
 *    and Whisper transcribes a clipped word badly. The alternative (a
 *    rolling buffer of encoded chunks spliced onto the container header)
 *    is container-specific and brittle across browsers; a cheap discarded
 *    blob is not.
 *
 *  - Detection is HALF-DUPLEX by default: it is suspended while the app is
 *    generating or speaking a reply (see vadOutputBusy). MIC_CONSTRAINTS
 *    asks for echo cancellation, but browser AEC only reliably cancels
 *    browser-rendered audio at moderate volume — on external speakers the
 *    assistant hears itself and answers itself, forever. Barge-in belongs
 *    on top of an AEC you can trust, which is not something this can
 *    assume.
 *
 * The state machine (everything above vadStep) is pure: no Web Audio, no
 * DOM, no timers. That is what tests/test_vad.js drives with synthetic
 * frame sequences.
 */

/* ==========================================================================
   Tuning constants (pure core)
   ========================================================================== */

/**
 * Sensitivity (general.vad_sensitivity, 1-5) -> threshold multipliers.
 *
 *   arm     start recording — deliberately close to the floor
 *   speech  confirm a real utterance; below this the blob is discarded
 *   release hysteresis: frames under this count toward end-of-utterance
 *
 * `release` sits BETWEEN arm and speech on purpose. A single threshold
 * chatters: the same trailing syllable that opens the gate falls back
 * under it a frame later and ends the turn mid-sentence.
 */
const VAD_SENSITIVITY = {
    1: { arm: 2.6, speech: 4.5, release: 3.0 },
    2: { arm: 2.2, speech: 3.8, release: 2.6 },
    3: { arm: 1.8, speech: 3.0, release: 2.2 },
    4: { arm: 1.5, speech: 2.4, release: 1.8 },
    5: { arm: 1.3, speech: 2.0, release: 1.5 },
};

const VAD_DEFAULT_SENSITIVITY = 3;
const VAD_DEFAULT_SILENCE_MS = 900;

/** Speech time (cumulative, not consecutive) needed to confirm an utterance. */
const VAD_CONFIRM_MS = 160;
/** How long an armed-but-unconfirmed recording is allowed to run. */
const VAD_ARM_TIMEOUT_MS = 500;
/** Utterances shorter than this are coughs, clicks and chair creaks. */
const VAD_MIN_UTTERANCE_MS = 350;
/** Hard cap, so a stuck detector cannot upload a ten-minute blob. */
const VAD_MAX_UTTERANCE_MS = 30000;
/** Quiet period after an utterance before the detector may arm again. */
const VAD_HOLDOFF_MS = 300;
/**
 * Time spent learning the room before the detector may arm at all.
 *
 * A cold detector starts at the minimum floor, and the slow rising EMA
 * needs seconds to reach a real room — during which every threshold is
 * far below the ambient level and the first frame of anything at all
 * reads as speech. So the floor adapts FAST and arms on nothing until
 * the room is known. The same fast adaptation runs during the hold-off
 * after an utterance, which is what stops a newly-started fan from
 * arming, discarding and re-arming for the seconds the slow EMA takes.
 */
const VAD_WARMUP_MS = 400;

/**
 * Floor below which the noise floor is not allowed to fall.
 *
 * A digitally silent stream (muted device, virtual cable) has an RMS of
 * ~0, and a multiple of ~0 is still ~0 — every threshold collapses and
 * the first sample of anything at all reads as speech. This is roughly
 * -62 dBFS: below any real room, above true silence.
 */
const VAD_MIN_NOISE_FLOOR = 0.0008;

/** EMA weights for the noise floor: quick down, slow up (see the header). */
const VAD_FLOOR_FALL = 0.25;
const VAD_FLOOR_RISE = 0.02;

/** EMA weight for the level fed to the UI meter (smoother than detection). */
const VAD_LEVEL_SMOOTHING = 0.3;

/* ==========================================================================
   Pure core: noise floor + utterance state machine
   ========================================================================== */

/** Multipliers for a sensitivity setting, falling back to the default. */
function vadThresholds(sensitivity) {
    return VAD_SENSITIVITY[sensitivity] || VAD_SENSITIVITY[VAD_DEFAULT_SENSITIVITY];
}

/**
 * Fold one frame into the noise floor.
 *
 * Called for idle frames only — while the mic is capturing, or while the
 * app is talking, the signal is not the room.
 *
 * @param {boolean} [fast] converge quickly in both directions, for the
 *   windows where the detector is deliberately deaf (warm-up, hold-off,
 *   the cool-down after the assistant speaks) and can afford to believe
 *   what it hears without risking a trigger.
 */
function adaptNoiseFloor(floor, rms, fast) {
    const alpha = fast || rms < floor ? VAD_FLOOR_FALL : VAD_FLOOR_RISE;
    return Math.max(VAD_MIN_NOISE_FLOOR, floor + alpha * (rms - floor));
}

/**
 * A fresh detector state.
 *
 * @param {object} [options]
 * @param {number} [options.sensitivity] general.vad_sensitivity (1-5)
 * @param {number} [options.silenceMs]   general.vad_silence_ms
 * @param {number} [options.floor]       carry a measured floor across a
 *   suspend/resume instead of re-learning the room from scratch
 */
function createVadState(options = {}) {
    return {
        phase: "idle",          // idle | armed | speech
        floor: options.floor != null ? options.floor : VAD_MIN_NOISE_FLOOR,
        sensitivity: options.sensitivity || VAD_DEFAULT_SENSITIVITY,
        silenceMs: options.silenceMs || VAD_DEFAULT_SILENCE_MS,
        warmupMs: VAD_WARMUP_MS,  // learn the room before arming on it
        armedMs: 0,             // time since the recorder was started
        confirmedMs: 0,         // cumulative time above the speech threshold
        utteranceMs: 0,         // total recorded time, silence tail included
        quietMs: 0,             // consecutive time under the release threshold
        holdoffMs: 0,           // cool-down before the next arm
        level: 0,               // smoothed RMS, for the UI meter only
    };
}

/**
 * Advance the detector by one frame.
 *
 * Pure: returns a new state plus the event the caller should act on. The
 * caller owns the recorder — this function never touches it.
 *
 * Events:
 *   "arm"     start recording (may still be discarded)
 *   "speech"  utterance confirmed; this is real speech
 *   "discard" stop recording and throw the blob away
 *   "end"     stop recording and transcribe
 *
 * @param {object} state  from createVadState()
 * @param {number} rms    RMS amplitude of this frame, 0..1
 * @param {number} dtMs   elapsed time since the previous frame
 * @returns {{state: object, event: (string|null)}}
 */
function vadStep(state, rms, dtMs) {
    const next = { ...state };
    const t = vadThresholds(next.sensitivity);
    next.level = next.level + VAD_LEVEL_SMOOTHING * (rms - next.level);

    if (next.phase === "idle") {
        // Deaf windows: learn the room quickly, trigger on nothing.
        if (next.warmupMs > 0) {
            next.floor = adaptNoiseFloor(next.floor, rms, true);
            next.warmupMs = Math.max(0, next.warmupMs - dtMs);
            return { state: next, event: null };
        }
        if (next.holdoffMs > 0) {
            next.floor = adaptNoiseFloor(next.floor, rms, true);
            next.holdoffMs = Math.max(0, next.holdoffMs - dtMs);
            return { state: next, event: null };
        }
        if (rms >= next.floor * t.arm) {
            next.phase = "armed";
            next.armedMs = 0;
            next.confirmedMs = 0;
            next.utteranceMs = 0;
            next.quietMs = 0;
            return { state: next, event: "arm" };
        }
        // Adapt only on frames that did NOT arm: the one that did is by
        // definition not the room, and folding it in would raise the bar
        // for the utterance that is about to start.
        next.floor = adaptNoiseFloor(next.floor, rms);
        return { state: next, event: null };
    }

    // Armed and speech both hold the floor still: adapting it here would
    // mean the speaker's own voice raising the bar they have to clear.
    next.armedMs += dtMs;
    next.utteranceMs += dtMs;

    if (next.phase === "armed") {
        if (rms >= next.floor * t.speech) {
            next.confirmedMs += dtMs;
            if (next.confirmedMs >= VAD_CONFIRM_MS) {
                next.phase = "speech";
                next.quietMs = 0;
                return { state: next, event: "speech" };
            }
            return { state: next, event: null };
        }
        // Sustained noise just under the speech threshold (a fan spinning
        // up, a truck outside) would otherwise hold the recorder open
        // forever: give up, and hold off long enough for the floor to
        // re-learn the room instead of re-arming on the same noise.
        if (next.armedMs >= VAD_ARM_TIMEOUT_MS) {
            return { state: vadToIdle(next), event: "discard" };
        }
        return { state: next, event: null };
    }

    // phase === "speech"
    if (rms < next.floor * t.release) {
        next.quietMs += dtMs;
        if (next.quietMs >= next.silenceMs) {
            // The silence tail is not speech: judge the length without it.
            const spoken = next.utteranceMs - next.quietMs;
            const event = spoken >= VAD_MIN_UTTERANCE_MS ? "end" : "discard";
            return { state: vadToIdle(next), event };
        }
    } else {
        next.quietMs = 0;
    }

    if (next.utteranceMs >= VAD_MAX_UTTERANCE_MS) {
        // Confirmed speech that ran long: keep it rather than discard it.
        return { state: vadToIdle(next), event: "end" };
    }
    return { state: next, event: null };
}

/** Reset the per-utterance counters, keeping the learned floor. */
function vadToIdle(state) {
    return {
        ...state,
        phase: "idle",
        armedMs: 0,
        confirmedMs: 0,
        utteranceMs: 0,
        quietMs: 0,
        holdoffMs: VAD_HOLDOFF_MS,
    };
}

/** RMS amplitude of a block of float PCM samples. */
function vadFrameRms(samples) {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    return samples.length ? Math.sqrt(sum / samples.length) : 0;
}

/* ==========================================================================
   Pure core: transcript sanity
   ========================================================================== */

/**
 * Transcripts Whisper produces from near-silence.
 *
 * These are artifacts of the training data (YouTube captions), not things
 * a user says to an assistant, and in hands-free mode they would be
 * auto-sent. The list is deliberately short: anything that could plausibly
 * be a real one-word answer ("yes", "no", "stop", "okay") must NOT be here
 * — dropping a real answer is worse than sending one stray "thank you".
 */
const VAD_NOISE_TRANSCRIPTS = new Set([
    "you", "thank you", "thanks for watching", "thank you for watching",
    "uh", "um", "mm", "hmm", "ah",
]);

/** Prefixes of the caption boilerplate Whisper hallucinates on silence. */
const VAD_NOISE_PREFIXES = ["subtitles by", "subtitles created by", "transcription by"];

/** Lowercase, drop punctuation and musical notes, collapse whitespace. */
function normalizeTranscript(text) {
    return (text || "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * True when a transcript looks like a hallucination rather than speech.
 *
 * Only consulted for hands-free captures. A push-to-talk recording is an
 * explicit user action: whatever comes back goes in the box.
 */
function isProbablyNoiseTranscript(text) {
    const normalized = normalizeTranscript(text);
    if (!normalized) return true;
    if (VAD_NOISE_TRANSCRIPTS.has(normalized)) return true;
    return VAD_NOISE_PREFIXES.some(prefix => normalized.startsWith(prefix));
}

/* ==========================================================================
   Web Audio wrapper
   ========================================================================== */

/** Detector poll interval. ~25 ms is well under the shortest phoneme. */
const VAD_TICK_MS = 25;
/** Analyser window. 1024 samples is ~21 ms at 48 kHz — one tick's worth. */
const VAD_FFT_SIZE = 1024;
/**
 * How long detection stays suspended after the app stops talking.
 *
 * Speakers ring, rooms reverb, and the tail of the last TTS chunk is
 * still in the air when the audio graph reports idle. Arming on it would
 * make the assistant answer its own echo.
 */
const VAD_RESUME_DELAY_MS = 350;

/**
 * True while the app is producing or speaking a reply.
 *
 * Also true while a capture is being transcribed: /api/stt is a round
 * trip, and a second recording started during it would overwrite
 * recordedChunks and mediaRecorder out from under the first.
 */
function vadOutputBusy() {
    return (
        isStreaming ||
        sttInFlight ||
        isFetchingTTS ||
        isPlayingAudio ||
        isPlayingAudioBuffer ||
        ttsRequestQueue.length > 0 ||
        ttsReadyBuffers.size > 0
    );
}

/**
 * Attach the detector to the shared mic stream and start polling.
 *
 * Returns false if the mic or the AudioContext is unavailable — an
 * AudioContext created outside a user gesture can stay suspended, and a
 * suspended context's analyser reports digital silence forever, which
 * would look exactly like a detector that never triggers.
 */
async function startVad() {
    if (vadTimer !== null) return true;

    const stream = await getMicStream();
    if (!stream) return false;
    setMicTracksEnabled(true);

    try {
        vadAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (vadAudioCtx.state === "suspended") await vadAudioCtx.resume();
        if (vadAudioCtx.state !== "running") {
            console.warn("Voice activation: AudioContext did not start (needs a user gesture).");
            stopVad();
            return false;
        }
        vadSource = vadAudioCtx.createMediaStreamSource(stream);
        vadAnalyser = vadAudioCtx.createAnalyser();
        vadAnalyser.fftSize = VAD_FFT_SIZE;
        // Detection does its own smoothing; the analyser's would just add
        // lag between the user speaking and the recorder starting.
        vadAnalyser.smoothingTimeConstant = 0;
        vadSource.connect(vadAnalyser);
        // Deliberately NOT connected to the destination: routing the mic
        // to the speakers is a feedback loop, not a monitor.
    } catch (err) {
        console.error("Voice activation: failed to build the audio graph:", err);
        stopVad();
        return false;
    }

    vadFrame = new Float32Array(vadAnalyser.fftSize);
    vadState = createVadState({ sensitivity: vadSensitivity, silenceMs: vadSilenceMs });
    vadLastTickAt = performance.now();
    // Start suspended: whatever was playing when the user flipped the
    // switch gets its cool-down like any other reply.
    vadBusyUntil = vadLastTickAt + VAD_RESUME_DELAY_MS;
    vadTimer = setInterval(vadTick, VAD_TICK_MS);
    return true;
}

/** Tear the detector down and release the audio graph. */
function stopVad() {
    if (vadTimer !== null) {
        clearInterval(vadTimer);
        vadTimer = null;
    }
    if (vadSource) {
        try { vadSource.disconnect(); } catch (err) { /* already gone */ }
        vadSource = null;
    }
    vadAnalyser = null;
    if (vadAudioCtx) {
        // close() returns a promise nobody waits on: the context is dead to
        // us either way, and a failed close must not block turning off.
        vadAudioCtx.close().catch(() => {});
        vadAudioCtx = null;
    }
    vadFrame = null;
    vadState = null;
}

/**
 * One detector frame: measure, step the machine, act on the event.
 *
 * Uses wall-clock deltas rather than the nominal interval — a background
 * tab throttles setInterval to once a second, and feeding the machine a
 * fictional 25 ms would stretch a one-second gap into a 40-frame
 * "utterance".
 */
function vadTick() {
    if (!vadAnalyser || !vadState) return;

    const now = performance.now();
    const dtMs = Math.min(now - vadLastTickAt, VAD_MAX_UTTERANCE_MS);
    vadLastTickAt = now;

    vadAnalyser.getFloatTimeDomainData(vadFrame);
    const rms = vadFrameRms(vadFrame);

    if (vadOutputBusy()) {
        // Keep pushing the resume moment forward for as long as we are
        // talking; the countdown only starts once the app falls silent.
        vadBusyUntil = now + VAD_RESUME_DELAY_MS;
        if (vadCaptureActive) {
            // A reply started while the user was mid-sentence (a late TTS
            // chunk, an echo-chamber turn). Keep what was said — stop and
            // transcribe it rather than throwing it away.
            stopVadCapture(false);
        }
        vadState = { ...vadToIdle(vadState), level: 0 };
        updateVoiceButtonUI();
        return;
    }

    if (now < vadBusyUntil) {
        // Cooling down: learn the room, trigger on nothing.
        vadState = { ...vadState, floor: adaptNoiseFloor(vadState.floor, rms, true), level: 0 };
        updateVoiceButtonUI();
        return;
    }

    const { state, event } = vadStep(vadState, rms, dtMs);
    vadState = state;

    switch (event) {
        case "arm":
            startVadCapture();
            break;
        case "discard":
            stopVadCapture(true);
            break;
        case "end":
            stopVadCapture(false);
            break;
        default:
            break;  // "speech" only changes how the button looks
    }
    updateVoiceButtonUI();
}

/** Re-arm the detector against the current room (after a settings change). */
function resetVadState() {
    if (!vadState) return;
    vadState = createVadState({
        sensitivity: vadSensitivity,
        silenceMs: vadSilenceMs,
        floor: vadState.floor,
    });
}

/** The meter value the button renders: 0 at the floor, 1 at "speaking". */
function vadMeterLevel() {
    if (!vadState) return 0;
    const speechLevel = vadState.floor * vadThresholds(vadState.sensitivity).speech;
    if (!(speechLevel > 0)) return 0;
    return Math.max(0, Math.min(1, vadState.level / speechLevel));
}
