# Local changelog — `local-config` branch

Changes made on this branch, which is **not** intended to merge upstream.
`master` is kept clean and synced with origin; everything here lives on
`local-config` only.

This file exists because a meaningful part of the local setup is **not in
git at all** — `run.bat` is gitignored (`.gitignore:25`) and the CUDA
runtime libraries live in the `whisper-fastapi` checkout's virtualenv. If
this machine is rebuilt, the "Not in version control" sections below are
what would otherwise be lost.

Newest first.

---

## 2026-09-11 — Voice round-trip latency

### Committed — `304031f`

Reduced end-to-end "press mic → hear the reply" latency across all three
legs of the pipeline. Every change is behaviour-preserving.

**Bug fix: `latency.js` was never loaded.** `static/latency.js` had been
committed since `744d351`, but its `<script>` tag was dropped from
`templates/index.html` in the v7 merge (`21d706a`). Because `chat.js`,
`stt.js` and `tts.js` call `latency` unconditionally (each method no-ops
when `debug_latency` is off), `latency` being undefined meant
`sendMessage()` threw `ReferenceError` on its first line, and the
`try/catch` around `handleSSEEvent` swallowed the per-token failures as
`"Failed to parse SSE event"` — so the real cause was invisible. Tag
restored, with a comment recording the load-order constraint.

| # | Change | Files |
|---|--------|-------|
| 1 | Reference audio + transcript memoized on `(path, mtime_ns, size)`; no longer re-read and re-base64'd once per synthesized sentence | `app/services/tts_client.py` |
| 2 | `cache_prompt: true` on the streaming and router payloads, offered optimistically and withdrawn on a 400 (strict OpenAI-compatible servers reject unknown fields) | `app/services/llm.py` |
| 3 | First chunk of each reply cut aggressively (terminal → clause break past 40 chars → word boundary past 60); sentence granularity after that | `static/tts.js` |
| 4 | Up to 2 concurrent `/api/tts` fetches, with sequence-ordered playback so out-of-order completions cannot reorder audio | `static/tts.js`, `static/state.js` |
| 5 | STT posts the blob as `multipart/form-data` instead of base64 JSON (the JSON shape still works); mic stream acquired once and reused; 16 kHz mono @ 32 kbit/s | `static/stt.js`, `app/routers/stt.py` |
| 6 | Pooled outbound `httpx.AsyncClient`s for LLM/TTS/STT, closed in the lifespan | `app/services/http_pool.py` (new) |

Tests: 790 pytest (up from 775) + 112 Node, all green. New
`tests/test_tts_streaming.js` covers the chunking and queueing logic.
`AGENTS.md` documents all of the above.

Deliberately **not** changed: `settings.yaml` (`max_persona_replies`,
`tts.num_steps`) — those trade behaviour, and are the operator's call.

---

### Not in version control — STT moved to GPU

`run.bat` is gitignored, so none of this is captured by a commit.

**Problem.** STT ran `--model small --device cpu --compute_type int8`,
costing ~3.4 s per utterance — larger than every other latency cost in
the pipeline combined.

**Why cuda did not "just work".** `faster-whisper` / CTranslate2 do not
ship the CUDA runtime. CTranslate2 4.8.2 needs cuBLAS (CUDA 12) and
cuDNN 9. Neither was installed. The failure is misleading: CTranslate2
reports the GPU correctly (`get_cuda_device_count()` → 1) and the model
**loads**, then the first transcription fails with

```
RuntimeError: Library cublas64_12.dll is not found or cannot be loaded
```

The wheel does bundle `cudnn64_9.dll`, but at 266 KB that is only the
cuDNN 9 *loader stub* — the real sub-libraries (`cudnn_ops64_9.dll`,
`cudnn_cnn64_9.dll`, `cudnn_graph64_9.dll`, …) were absent too. cuBLAS
simply failed first.

**Fix — to reproduce on a fresh machine:**

```bash
cd ..\whisper-fastapi          REM sibling of this repo, as run.bat expects
.venv\Scripts\python.exe -m pip install nvidia-cublas-cu12 "nvidia-cudnn-cu12>=9,<10"
```

(~1.4 GB: `nvidia-cublas-cu12` 12.9.2.10, `nvidia-cudnn-cu12` 9.26.0.51,
plus `nvidia-cuda-nvrtc-cu12` as a dependency.)

On Windows these land in `site-packages/nvidia/{cublas,cudnn,cuda_nvrtc}/bin`,
which is **not** on the DLL search path. `run.bat` now prepends those three
directories to `PATH` for the STT process only, restoring the original
`PATH` before launching TTS and the app. It warns by name if any directory
is missing, rather than letting it fail later as an opaque CUDA error.

Note `whisper-fastapi/requirements.txt` does not list these packages, so
rebuilding that venv silently drops them. The `run.bat` warning is the
safety net.

**Model choice — benchmarked on a real recording, not assumed:**

| config | load | steady state |
|--------|------|--------------|
| `small` / cpu / int8 *(previous)* | 1.8 s | **3.33 s** |
| `small` / cuda / float16 | 0.9 s | 0.28 s |
| `medium` / cuda / float16 | 33.6 s | 0.45 s |
| **`large-v3-turbo` / cuda / float16** *(chosen)* | 34.6 s | **0.32 s** |

`large-v3-turbo` is both the fastest and the most accurate — faster than
`medium`, so there was no accuracy-vs-latency tradeoff. Load time is a
one-off per server start. Measured through the full app stack afterwards:
**~370 ms** steady state, down from ~3.4 s, i.e. **~3 s saved per
utterance**.

**Also added:** `-W ignore::UserWarning` to the STT launch, suppressing
Pydantic serializer warnings emitted on every transcription. Their cause
is a genuine bug in whisper-fastapi, not in this app:
`build_json_result()` uses `dataclasses.asdict(info)`, which recurses and
turns the `transcription_options` field into a plain `dict` while the
annotation still says `TranscriptionOptions`. Output is unaffected — the
`text`, `language` and `language_probability` fields this app reads are
all intact. The upstream one-line fix would be
`{f.name: getattr(info, f.name) for f in dataclasses.fields(info)}`;
not applied, because `whisper-fastapi` is a third-party checkout and
patching it risks conflicts on its next `git pull`.

Caveat: `-W ignore::UserWarning` is process-wide, so it also hides any
future genuine `UserWarning` from the STT server. `DeprecationWarning`,
`RuntimeWarning` and all errors still surface.

**Current STT launch line** (in the gitignored `run.bat`):

```
python.exe -W ignore::UserWarning whisper_fastapi.py
    --host 127.0.0.1 --port 5000
    --model large-v3-turbo --device cuda --compute_type float16
```

---

### Not a problem — `GET /health 404` in the whisper log

whisper-fastapi exposes no `/health` route, so the probe can only 404.
`check_stt_health()` accepts **both 200 and 404** on purpose
(`app/services/stt_client.py:43`): a 404 proves something is listening and
speaking HTTP, which is all the mic button needs. A dead server produces a
connection error instead, and that is what disables the button. Fires once
per page load and once per settings save — there is no polling.

---

## Still open — operator levers not applied

Roughly in order of expected remaining impact:

1. **`--parallel N` on llama-server** (one slot per persona in the room,
   plus one for the router). `cache_prompt` only pays off fully with it.
   `run.bat` does not launch llama-server, so this belongs wherever the
   LLM is started.
2. **`max_persona_replies: 4` → 1–2** in `settings.yaml`. Four
   generate-and-synthesize cycles per utterance is the largest single
   wall-clock cost in a room. Changes behaviour.
3. **`tts.num_steps: 14` → 8–10**. Near-linear in synthesis time.
4. **Server-side speaker-embedding cache in `tts-serve`.** The app no
   longer re-sends the reference clip's bytes per sentence, but OmniVoice
   still re-extracts the speaker embedding on every request. That is the
   larger remaining cost on the cloning path.
