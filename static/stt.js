/**
 * stt.js — Speech-to-Text: microphone recording and transcription.
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
   ========================================================================== */

async function toggleMicrophone() {
    if (mediaRecorder && mediaRecorder.state === "recording") {
        micBtn.disabled = true; // prevent re-entry until onstop finishes
        mediaRecorder.stop();
        return;
    }

    cancelMicRelease();
    const stream = await getMicStream();
    if (!stream) {
        appendErrorBubble("Microphone access was denied.");
        return;
    }

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

    mediaRecorder.onstop = async () => {
        // Stop capturing, but KEEP the device: the next press reuses this
        // stream instead of paying getUserMedia's negotiation again.
        setMicTracksEnabled(false);
        scheduleMicRelease();
        micBtn.classList.remove("recording");
        micBtn.disabled = true;

        const blob = new Blob(recordedChunks, { type: audioMimeType });

        let sttFailed = false;
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
            if (!sttFailed) micBtn.disabled = false;
        }
    };

    setMicTracksEnabled(true);
    mediaRecorder.start();
    micBtn.classList.add("recording");
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
