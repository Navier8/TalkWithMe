/**
 * stt.js — Speech-to-Text: microphone recording and transcription.
 *
 * Recordings start in one of two ways: the mic button (push to talk) or
 * the voice detector in vad.js (hands-free). Both run through
 * startRecording()/handleRecordingStopped() below; see
 * docs/feature_voice_activation.md for the hands-free half.
 *
 * Two latency notes, because both shape the code below:
 *
 *  - The mic stream is acquired once and REUSED. getUserMedia negotiates
 *    with the audio device every time it is called (100-300 ms), and the
 *    old code called it on every press and stopped the tracks on release,
 *    so that cost landed between the user pressing record and the recorder
 *    actually capturing. The stream is now cached in `micStream` and its
 *    tracks are disabled while idle — nothing is captured between turns.
 *
 *  - The recorded blob is POSTed as multipart/form-data, not base64 JSON.
 *    Base64 meant a FileReader pass over the whole blob in the browser and
 *    a 33 % larger request, both to deliver bytes the server had to decode
 *    again. /api/stt still accepts the JSON shape (see app/routers/stt.py).
 */

/* ==========================================================================
   Microphone acquisition
   ========================================================================== */

/**
 * Constraints for the capture stream.
 *
 * Whisper resamples everything to 16 kHz mono internally, so asking for
 * more than that only makes a bigger blob to upload and encode. Both are
 * REQUESTS, not guarantees: browsers routinely ignore sampleRate (the
 * WebM/Opus pipeline is usually pinned to 48 kHz) and simply hand back
 * what the device offers. Nothing here depends on getting what it asked
 * for — a stream that ignores every hint still records and transcribes.
 */
const MIC_CONSTRAINTS = {
    audio: {
        channelCount: 1,
        sampleRate: 16000,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
    },
};

/** Opus bitrate for speech. Well above transparent for a single voice, and
 *  small enough that the upload is never the slow part of the round-trip. */
const MIC_BITS_PER_SECOND = 32000;

/**
 * How long the mic stream is held after a recording ends.
 *
 * Holding the device is what buys the saved getUserMedia round-trip, but
 * holding it FOREVER leaves the browser's in-use indicator lit on an idle
 * tab, which reads as "this page is listening to me" — and the tracks
 * being disabled is not something the user can see. A minute covers the
 * gaps inside a back-and-forth conversation (where the saving is worth
 * something) and releases the device once the conversation stops.
 */
const MIC_IDLE_RELEASE_MS = 60000;

let micIdleTimer = null;

/** (Re)start the countdown to releasing the microphone. */
function scheduleMicRelease() {
    cancelMicRelease();
    // Hands-free mode holds the device on purpose: the detector listens
    // through this stream, so releasing it after a minute of quiet would
    // switch voice activation off without saying so. The lit in-use
    // indicator is honest here — the page really is listening.
    if (handsFreeEnabled) return;
    micIdleTimer = setTimeout(() => {
        micIdleTimer = null;
        // Never yank the device out from under an in-progress recording.
        if (mediaRecorder && mediaRecorder.state === "recording") {
            scheduleMicRelease();
            return;
        }
        releaseMicStream();
    }, MIC_IDLE_RELEASE_MS);
}

function cancelMicRelease() {
    if (micIdleTimer !== null) {
        clearTimeout(micIdleTimer);
        micIdleTimer = null;
    }
}

function updateMicButtonUI() {
    micBtn.disabled = !sttAvailable;
    updateVoiceButtonUI();
}

/** True when the cached stream is still usable (not ended, not revoked). */
function micStreamIsLive() {
    return (
        micStream !== null &&
        micStream.getAudioTracks().some(t => t.readyState === "live")
    );
}

/**
 * The shared mic stream, acquiring it on first use.
 *
 * Re-acquires when the cached stream has died — the device was unplugged,
 * the user revoked permission, or the browser reclaimed it. Returns null
 * if permission is refused; the caller reports that to the user.
 */
async function getMicStream() {
    if (micStreamIsLive()) return micStream;

    // A dead stream still holds its tracks; drop them before replacing it.
    releaseMicStream();
    try {
        micStream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
    } catch (err) {
        console.error("Microphone access denied:", err);
        micStream = null;
        return null;
    }
    // Idle by default: acquiring the stream must not start capturing.
    setMicTracksEnabled(false);
    return micStream;
}

/** Enable/disable capture without releasing the device. */
function setMicTracksEnabled(enabled) {
    if (!micStream) return;
    micStream.getAudioTracks().forEach(t => { t.enabled = enabled; });
}

/** Fully release the microphone (stops the browser's in-use indicator). */
function releaseMicStream() {
    cancelMicRelease();
    if (!micStream) return;
    micStream.getTracks().forEach(t => t.stop());
    micStream = null;
}

/* ==========================================================================
   Recording

   Two things start a recording — the mic button and the voice detector
   (vad.js) — so the recorder is built, and its blob handled, in exactly
   one place. The detector's extra concerns (a capture it wants thrown
   away, a stream that must stay open between utterances) ride along as
   the vadCaptureActive / vadDiscardCapture flags rather than as a second
   copy of this code.
   ========================================================================== */

/**
 * Build and start a MediaRecorder on the shared mic stream.
 *
 * @returns {Promise<boolean>} false when the microphone is unavailable.
 */
async function startRecording() {
    cancelMicRelease();
    const stream = await getMicStream();
    if (!stream) return false;

    recordedChunks = [];
    let recorder;
    try {
        recorder = new MediaRecorder(stream, { audioBitsPerSecond: MIC_BITS_PER_SECOND });
    } catch (err) {
        // A browser that rejects the bitrate hint still records at its own.
        console.warn("MediaRecorder rejected the bitrate hint; using defaults:", err);
        recorder = new MediaRecorder(stream);
    }
    mediaRecorder = recorder;

    // Capture the actual MIME type the browser chose. Different browsers/platforms
    // may produce webm, ogg, mp4, or other containers.
    const audioMimeType = mediaRecorder.mimeType || "audio/webm";
    mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordedChunks.push(e.data);
    };
    mediaRecorder.onstop = () => {
        handleRecordingStopped(new Blob(recordedChunks, { type: audioMimeType }), audioMimeType);
    };

    setMicTracksEnabled(true);
    mediaRecorder.start();
    micBtn.classList.add("recording");
    updateVoiceButtonUI();
    return true;
}

/** Stop the active recording, if any; its blob lands in handleRecordingStopped. */
function stopRecording() {
    if (mediaRecorder && mediaRecorder.state === "recording") mediaRecorder.stop();
}

async function toggleMicrophone() {
    if (mediaRecorder && mediaRecorder.state === "recording") {
        micBtn.disabled = true; // prevent re-entry until onstop finishes
        // A click during a hands-free capture ends that capture normally:
        // the user said their piece and wants it sent now, without waiting
        // out the silence timeout.
        stopRecording();
        return;
    }

    if (!await startRecording()) {
        appendErrorBubble("Microphone access was denied.");
    }
}

/**
 * Transcribe a finished recording and send it as a message.
 *
 * Reached from every stop path: the mic button, the detector's
 * end-of-utterance, and the detector discarding a false start (which
 * bails out early — there is nothing to transcribe and nothing worth
 * telling the user about).
 */
async function handleRecordingStopped(blob, audioMimeType) {
    const fromVad = vadCaptureActive;
    const discarded = vadDiscardCapture;
    vadCaptureActive = false;
    vadDiscardCapture = false;

    // Hands-free keeps the device open AND capturing: the detector listens
    // through this same stream, and disabled tracks would leave it staring
    // at digital silence, waiting for speech that can never arrive.
    if (!handsFreeEnabled) {
        // Stop capturing, but KEEP the device: the next press reuses this
        // stream instead of paying getUserMedia's negotiation again.
        setMicTracksEnabled(false);
        scheduleMicRelease();
    }
    micBtn.classList.remove("recording");
    updateVoiceButtonUI();

    if (discarded) {
        micBtn.disabled = !sttAvailable;
        return;
    }

    micBtn.disabled = true;

    let sttFailed = false;
    sttInFlight = true;
    // Start of the voice round-trip: mic just stopped, transcription begins now.
    latency.begin("voice");
    try {
        // The blob goes up as-is: no FileReader pass, no base64 inflation,
        // no decode on the server. `audio_mime_type` rides along because
        // some browsers label the part application/octet-stream.
        const form = new FormData();
        form.append("file", blob, "audio." + mimeToExtension(audioMimeType));
        form.append("audio_mime_type", audioMimeType);

        const resp = await fetch("/api/stt", { method: "POST", body: form });

        if (!resp.ok) {
            console.error("STT request failed:", resp.status);
            appendErrorBubble("Unable to process STT data.");
            sttFailed = true;
            latency.cancel();
            return;
        }

        const data = await resp.json();
        latency.mark("sttDone");

        // Whisper answers near-silence with caption boilerplate ("thank
        // you", "Subtitles by ..."). Push-to-talk shows it and lets the
        // user delete it; hands-free would SEND it, so it stops here.
        if (fromVad && isProbablyNoiseTranscript(data.text)) {
            latency.cancel();
            return;
        }

        if (data.text) {
            // Append transcribed text (never replace existing content)
            const existing = inputEl.value;
            inputEl.value = existing ? existing + " " + data.text : data.text;
            inputEl.dispatchEvent(new Event("input")); // trigger auto-resize

            // Persist the recorded audio before sending the message.
            // pendingUserMessageId is set by sendMessage() right before the
            // message is sent, but we need it here *before* sendMessage().
            // So we generate it now if it's not already set.
            if (!pendingUserMessageId) {
                pendingUserMessageId = crypto.randomUUID();
            }

            try {
                const result = await uploadAudioBlob(currentChatRoom, pendingUserMessageId, blob, audioMimeType);
                if (result && result.filename) {
                    // Inject a playback button into the live user bubble
                    addAudioButtonToUserMessage(pendingUserMessageId, result.filename);
                }
            } catch (err) {
                console.warn("Failed to persist STT audio:", err);
            }
            sendMessage();
        } else {
            latency.cancel();
        }
    } catch (err) {
        console.error("STT error:", err);
        appendErrorBubble("Unable to process STT data.");
        sttFailed = true;
        latency.cancel();
    } finally {
        sttInFlight = false;
        if (!sttFailed) micBtn.disabled = false;
        // A broken STT server plus hands-free is an error loop: every
        // utterance fails the same way and posts the same bubble. Drop
        // back to push-to-talk and let the user decide when to retry.
        if (sttFailed && handsFreeEnabled) {
            disableHandsFree();
            appendErrorBubble("Hands-free listening was turned off after a transcription failure.");
        }
    }
}

/* ==========================================================================
   Hands-free mode (voice activation)

   The switch itself; the detection behind it lives in vad.js.
   ========================================================================== */

/**
 * Turn hands-free listening on.
 *
 * Must be reachable from a user gesture the first time: getUserMedia may
 * prompt, and an AudioContext created without a gesture can come up
 * suspended (startVad reports that as a failure rather than listening to
 * a silent graph forever).
 */
async function enableHandsFree() {
    if (handsFreeEnabled) return true;
    if (!sttAvailable) return false;

    // Set first: scheduleMicRelease() and handleRecordingStopped() both
    // read this to decide whether the device may be let go.
    handsFreeEnabled = true;
    updateVoiceButtonUI();

    if (!await startVad()) {
        handsFreeEnabled = false;
        setMicTracksEnabled(false);
        scheduleMicRelease();
        updateVoiceButtonUI();
        return false;
    }
    return true;
}

/** Turn hands-free listening off and let the microphone go. */
function disableHandsFree() {
    if (!handsFreeEnabled) return;
    handsFreeEnabled = false;
    if (vadCaptureActive) stopVadCapture(true);
    stopVad();
    setMicTracksEnabled(false);
    scheduleMicRelease();
    updateVoiceButtonUI();
}

async function toggleHandsFree() {
    if (handsFreeEnabled) {
        disableHandsFree();
        return;
    }
    if (!await enableHandsFree()) {
        appendErrorBubble("Hands-free listening could not start — check microphone access.");
    }
}

/** The detector heard something: record it. */
async function startVadCapture() {
    if (vadCaptureActive) return;
    vadCaptureActive = true;
    vadDiscardCapture = false;

    if (!await startRecording()) {
        vadCaptureActive = false;
        // No microphone means no detector either; say so once instead of
        // failing silently on every utterance.
        disableHandsFree();
        appendErrorBubble("Microphone access was denied.");
        return;
    }
    // The mic stream is normally already live, so the await above resolves
    // within the same task. When it did NOT (the device had to be
    // re-acquired), the detector may have asked to stop meanwhile; that
    // request is honoured here, now that there is a recorder to stop.
    if (vadDiscardCapture || !handsFreeEnabled) stopRecording();
}

/**
 * The detector decided the utterance is over.
 *
 * @param {boolean} discard true for a false start (armed on a noise that
 *   never became speech): stop, and throw the blob away untranscribed.
 */
function stopVadCapture(discard) {
    if (!vadCaptureActive) return;
    vadDiscardCapture = discard;
    if (mediaRecorder && mediaRecorder.state === "recording") {
        mediaRecorder.stop();  // handleRecordingStopped clears both flags
    }
    // Otherwise the recorder is still being created: startVadCapture picks
    // the pending discard up as soon as it exists.
}

/** Reflect detector state on the hands-free button (state, level meter). */
function updateVoiceButtonUI() {
    if (!voiceBtn) return;
    voiceBtn.disabled = !sttAvailable;

    const suspended = handsFreeEnabled && vadTimer !== null && performance.now() < vadBusyUntil;
    voiceBtn.classList.toggle("listening", handsFreeEnabled);
    voiceBtn.classList.toggle("capturing", handsFreeEnabled && vadCaptureActive);
    voiceBtn.classList.toggle("suspended", suspended);
    voiceBtn.setAttribute("aria-pressed", handsFreeEnabled ? "true" : "false");
    // Drives the ring around the button: a visible "I can hear you" that
    // costs nothing, since the detector already measures the level.
    const level = handsFreeEnabled && !suspended ? vadMeterLevel() : 0;
    voiceBtn.style.setProperty("--vad-level", level.toFixed(3));

    voiceBtn.title = !handsFreeEnabled
        ? "Hands-free listening (voice activation)"
        : suspended
            ? "Hands-free listening — paused while the assistant speaks"
            : "Hands-free listening — click to stop";
}

/**
 * Apply changed voice settings to a running detector.
 *
 * Called after a settings save. The learned noise floor is kept: the room
 * did not change just because the thresholds did.
 */
function applyVoiceSettings() {
    resetVadState();
    updateVoiceButtonUI();
}

/**
 * File extension for a recorded MIME type, so the STT server can identify
 * the container from the part's filename. Mirrors _mime_to_extension() in
 * app/services/stt_client.py; the server re-derives it either way, this
 * just keeps the uploaded part honestly named.
 */
function mimeToExtension(mimeType) {
    const base = (mimeType || "").split(";", 1)[0].trim().toLowerCase();
    const subtype = base.includes("/") ? base.split("/")[1] : "";
    return subtype || "webm";
}
