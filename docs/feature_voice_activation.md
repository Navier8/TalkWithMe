# Voice activation (hands-free microphone)

This document describes an addition to the TalkWithMe app.
The goal is to let the user speak to a persona without pressing anything: the
browser listens, notices when the user starts and stops talking, and runs the
existing speech-to-text round trip on its own.

## Current state

Speech input is push-to-talk. The user clicks the microphone button (or presses
`Ctrl+Space`), speaks, and clicks again to stop; `static/stt.js` then uploads the
recording to `POST /api/stt`, appends the transcript to the input box, and sends
the message. The microphone stream itself is already acquired once and cached,
with its tracks disabled between turns and the device released after a minute of
inactivity.

That is two clicks per sentence — which is two clicks too many for the thing this
app is for, a spoken conversation with a persona whose reply is spoken back.

## Desired state

A second control beside the microphone button turns on **hands-free listening**.
While it is on:

- the microphone stays open and a voice activity detector (VAD) watches it;
- when the user starts speaking, recording starts by itself;
- when the user stops, recording stops, the audio is transcribed and the message
  is sent — the same path a click would have taken;
- while the app is writing or speaking a reply, listening is suspended, so the
  assistant cannot hear (and answer) itself.

Push-to-talk is unchanged and still works while hands-free is on: a click during
a hands-free capture ends it immediately instead of waiting out the silence.

Hands-free is **off by default**. An always-open microphone is not something an
app should switch on for you; `general.voice_activation` in `settings.yaml` (and
the General settings dialog) is how it becomes the default for future page loads.

## Configuration changes

Three new fields in the `general:` section of `settings.yaml`, all with a UI in
the General settings dialog under a new "Voice" section:

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `voice_activation` | bool | `false` | Start listening automatically when the page loads |
| `vad_sensitivity` | int 1–5 | `3` | How far above the room's own noise your voice must be |
| `vad_silence_ms` | int 300–3000 | `900` | Quiet time that ends your turn |

The `general:` section is a partial update (`PUT /api/settings`), so the new
fields need no per-field wiring in the router — they are merged like every other
general field.

The two integers are bounded on both sides of the API, but differently:

- from the **UI**, an out-of-range value is a `422` — there is a form to report
  the error on;
- from a **hand-edited `settings.yaml`**, it is clamped (or, if it is not an
  integer at all, dropped for the default) with a warning. These are numbers
  people tweak by feel, and a `ValidationError` at startup would take down the
  very UI the mistake would have been fixed from. `_clamp_int()` in
  `app/config.py` does this, in the spirit of the other degradations there.

## How detection works

`static/vad.js` holds the whole feature: a pure state machine plus a thin Web
Audio wrapper. The mic stream — the cached one, not a second capture — is fed
through a `MediaStreamAudioSourceNode` into an `AnalyserNode`, polled every
25 ms; each poll takes the RMS of the time-domain frame and advances the state
machine by the **wall-clock** delta (a background tab throttles `setInterval` to
once a second, and a nominal 25 ms would stretch that gap into a 40-frame
"utterance").

### Thresholds are relative, never absolute

Every threshold is a multiple of a measured noise floor, because a fixed dB
threshold works in exactly one room: the same number is deaf in a kitchen and
trigger-happy in a padded study. The floor is an exponential moving average that

- **falls fast** (the fan stopped — believe it) and **rises slowly** (that was
  speech, not the room);
- adapts **only while idle**, so the user's own voice cannot drag the floor up
  behind the release threshold mid-sentence;
- skips the frame that arms the recorder — that frame is by definition not the
  room, and folding it in would raise the bar for the utterance about to start;
- never falls below `VAD_MIN_NOISE_FLOOR`, because a multiple of the ~0 RMS of a
  muted device is still ~0 and every threshold would collapse;
- adapts **fast during the deaf windows** — warm-up, the hold-off after an
  utterance, and the cool-down after the assistant speaks — where believing the
  room quickly costs nothing because nothing can trigger.

A cold detector therefore spends `VAD_WARMUP_MS` learning the room before it can
arm at all. Without that, the first frame of any real room reads as speech.

Sensitivity picks the multipliers (`VAD_SENSITIVITY` in `static/vad.js`):

| Level | arm | speech | release |
|-------|-----|--------|---------|
| 1 | 2.6× | 4.5× | 3.0× |
| 2 | 2.2× | 3.8× | 2.6× |
| 3 (default) | 1.8× | 3.0× | 2.2× |
| 4 | 1.5× | 2.4× | 1.8× |
| 5 | 1.3× | 2.0× | 1.5× |

`release` sits **between** arm and speech deliberately. A single threshold
chatters: the trailing syllable that opened the gate falls back under it a frame
later and ends the turn mid-sentence.

### Recording starts early, on purpose

The detector starts recording at the low `arm` threshold and only *confirms* the
utterance once `speech` has been exceeded for `VAD_CONFIRM_MS` (cumulative, not
consecutive). If confirmation does not arrive within `VAD_ARM_TIMEOUT_MS`, the
recording is stopped and the blob **discarded** — never uploaded.

This two-stage shape exists to preserve the first ~200 ms of the utterance.
Waiting for confidence before hitting record clips the leading consonant, and
Whisper transcribes a clipped word badly. The obvious alternative — keeping a
rolling buffer of encoded chunks and splicing them onto the container header —
is container-specific and brittle across browsers; a discarded blob costs
nothing.

A false start (door, cough, keyboard) therefore ends as a discard, as does an
utterance whose speech portion is shorter than `VAD_MIN_UTTERANCE_MS`. After any
utterance the detector holds off for `VAD_HOLDOFF_MS`, which is also what stops a
newly-started fan from arming, discarding and re-arming for as long as the slow
EMA needs to catch up.

An utterance is capped at `VAD_MAX_UTTERANCE_MS` (30 s) so that a stuck detector
cannot upload a ten-minute blob; a capture that hits the cap is **kept**, not
discarded — it was confirmed speech.

### Half-duplex: the app must not hear itself

While the app is producing or speaking a reply, detection is suspended and any
in-progress capture is stopped and transcribed. `vadOutputBusy()` is the single
predicate: `isStreaming`, `sttInFlight`, `isFetchingTTS`, `isPlayingAudio`,
`isPlayingAudioBuffer`, or anything still queued in `ttsRequestQueue` /
`ttsReadyBuffers`. Once all of that clears, listening resumes after
`VAD_RESUME_DELAY_MS` — speakers ring and rooms reverb, and the tail of the last
chunk is still in the air when the audio graph reports idle.

`sttInFlight` is in that list for a different reason: `/api/stt` is a round trip,
and a second capture started during it would overwrite `mediaRecorder` and
`recordedChunks` out from under the first.

`MIC_CONSTRAINTS` already requests `echoCancellation`, but browser AEC only
reliably cancels browser-rendered audio at moderate volume — on external speakers
the assistant hears itself and answers itself, forever. Barge-in (interrupting a
reply by talking over it) belongs on top of an AEC that can be trusted, and is
deliberately **not** part of this change; see "Not included" below.

### Hallucinated transcripts

Whisper answers near-silence with caption boilerplate: "Thank you.", "Thanks for
watching", "Subtitles by …". Push-to-talk puts that in the input box where the
user can see and delete it; hands-free would **send** it. So a hands-free capture
whose transcript matches `isProbablyNoiseTranscript()` is dropped silently.

The list is deliberately short and exact-match (plus a couple of caption
prefixes): anything that could plausibly be a real one-word answer — "yes", "no",
"stop", "okay" — must never be on it. Dropping a real answer is worse than
sending one stray "thank you".

## UI changes

- A new button (👂) beside the microphone button, with three visible states:
  **listening** (armed, with a ring that scales with the live input level),
  **capturing** (recording now, pulsing), and **suspended** (dimmed — the app is
  talking, and it should read as "paused on purpose", not "broken").
- `Ctrl+Shift+Space` toggles hands-free; `Ctrl+Space` still records one message.
- A "Voice" section in the General settings dialog for the three settings.
  Saving it applies immediately — including turning hands-free on or off, since
  the Save click is itself the user gesture an `AudioContext` needs.

Turning hands-free on from a *user gesture* matters: `getUserMedia` may prompt,
and an `AudioContext` created without a gesture can come up suspended — and a
suspended context's analyser reports digital silence forever, which looks exactly
like a detector that never triggers. `startVad()` treats that as a failure rather
than listening to a silent graph. On page load, `general.voice_activation` is
therefore honoured **best-effort**: if it cannot start, the setting stays on, a
line goes to the console, and the button is one click away. An error bubble on
every page load would be worse than nothing.

Two cases switch hands-free off by themselves, because leaving it on would be a
lie or a loop:

- the STT server going away (a health check failure, or STT disabled in
  Settings) — listening with nowhere to send the audio is just an open
  microphone;
- a transcription failure while hands-free — otherwise every utterance fails the
  same way and posts the same error bubble.

## Implementation notes

| File | Change |
|------|--------|
| `static/vad.js` | **New.** Pure detector core (noise floor, utterance state machine, transcript sanity) + the Web Audio wrapper and tick loop |
| `static/stt.js` | Recorder lifecycle split out of `toggleMicrophone()` into `startRecording()` / `handleRecordingStopped()`, shared by both entry points; hands-free on/off; the button's state and level meter |
| `static/state.js` | `handsFreeEnabled`, `sttInFlight`, the detector's globals, the mirrored settings, the `#btn-voice` reference |
| `static/app.js` | Settings load, button + shortcut wiring, best-effort auto-start, STT health check turning listening off |
| `static/gen-settings.js` | The three fields: load, validate, save, apply live |
| `templates/index.html`, `static/style.css` | The button, its states, the "Voice" settings section |
| `app/config.py` | `voice_activation` / `vad_sensitivity` / `vad_silence_ms` on `GeneralConfig`, plus `_clamp_int()` |
| `app/models.py`, `app/routers/settings.py` | The same three fields on the request (optional, bounded) and response models |

The microphone's idle-release timer is suspended while hands-free is on: the
detector listens through that stream, so releasing the device after a minute of
quiet would switch voice activation off without saying so. The browser's lit
in-use indicator is honest here — the page really is listening.

No backend changes beyond configuration. Detection runs entirely in the browser;
`POST /api/stt` still receives one blob per utterance, exactly as before.

## Testing

`tests/test_vad.js` (plain Node, like the other frontend suites — **not** part of
pytest) drives the pure state machine with synthetic frame sequences:

```bash
node tests/test_vad.js
```

It locks in that a steady room never arms however loud it is, that digital
silence does not collapse the thresholds, that a click or cough is discarded
rather than transcribed, that a mid-sentence pause does not end the turn while
the configured silence does, that the floor is frozen while recording (so loud
speech still ends), that a throttled tab's one-second frame is read as a second,
that sensitivity does what it says, and that hallucinated transcripts are caught
while short real answers are not.

Backend coverage lives in `tests/test_config.py`
(`TestGeneralConfigVoiceActivation`: defaults, clamping, non-integer fallback,
YAML round trip) and `tests/test_routers_settings.py` (round trip through
`PUT`/`GET`, `422` on out-of-range values, and the partial-update tests which now
assert the new fields are preserved).

## Not included (possible follow-ups)

- **Barge-in.** Interrupting a spoken reply by talking over it. Needs an AEC that
  can be trusted plus cancellation of the TTS fetch and playback queues; the
  half-duplex gate is the honest version until then.
- **Wake word** ("hey …"). Energy detection triggers on *any* voice, so a room
  with other people talking in it needs a wake word. The usual options
  (openWakeWord, Porcupine) mean shipping a wasm model, which breaks this
  project's no-build-step rule.
- **Server-side VAD.** Streaming audio to the backend and running silero or
  webrtcvad there would be more accurate than an energy gate, but needs a
  WebSocket endpoint and a new dependency; `/api/stt` takes one blob per
  utterance today.
- **Web Speech API `continuous` mode.** A few lines of code, but Chrome ships the
  audio to Google's servers and bypasses the configured Whisper endpoint
  entirely. Wrong for a local-first app.
