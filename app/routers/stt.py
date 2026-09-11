"""STT router — proxy to an OpenAI-compatible STT server.

Handles speech-to-text transcription requests. The STT server is optional;
the app degrades gracefully if it's unavailable or disabled.
"""

import base64
import logging

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
# Starlette's UploadFile, not FastAPI's: request.form() yields the
# former, and fastapi.UploadFile is a SUBCLASS of it — so an isinstance
# check against the FastAPI class silently fails on every upload.
from starlette.datastructures import UploadFile

from app.config import get_settings
from app.models import STTRequest, STTResponse, STTHealthResponse
from app.services.stt_client import check_stt_health, transcribe_audio

logger = logging.getLogger(__name__)
router = APIRouter(tags=["stt"])


@router.get("/api/stt/health", response_model=STTHealthResponse)
async def stt_health():
    """Report STT availability status to the frontend."""
    settings = get_settings()
    available = await check_stt_health() if settings.stt.is_active else False
    return STTHealthResponse(
        enabled=settings.stt.is_active,
        available=available,
    )


async def _audio_from_multipart(request: Request) -> tuple[bytes, str]:
    """Pull (bytes, mime_type) out of a multipart/form-data upload.

    The recorded blob arrives as the `file` part. Its MIME type comes from
    the part's own Content-Type, with an explicit `audio_mime_type` field
    as an override for browsers that attach a bare
    application/octet-stream. Raises ValueError when no usable part is
    present, which the caller turns into a 400.
    """
    form = await request.form()
    upload = form.get("file")
    if not isinstance(upload, UploadFile):
        raise ValueError("multipart body has no 'file' part")
    audio_bytes = await upload.read()
    mime_type = (
        form.get("audio_mime_type")
        or upload.content_type
        or "audio/webm"
    )
    return audio_bytes, str(mime_type)


async def _audio_from_json(request: Request) -> tuple[bytes, str]:
    """Pull (bytes, mime_type) out of the legacy base64 JSON body.

    Kept for compatibility: the browser now POSTs the blob directly (one
    fewer copy, and no 33 % base64 inflation), but the JSON shape is this
    endpoint's published contract and other callers may still use it.
    Raises ValueError on a malformed body or undecodable base64.
    """
    try:
        body = await request.json()
    except Exception:
        raise ValueError("body is not valid JSON")
    if not isinstance(body, dict):
        raise ValueError("body is not a JSON object")
    try:
        req = STTRequest(**body)
    except Exception:
        raise ValueError("body does not match the STT request schema")
    try:
        # validate=True: without it, base64 silently DISCARDS characters
        # outside the alphabet, so junk decodes to junk audio and the
        # failure surfaces as a confusing 502 from the STT server.
        # Whitespace is stripped first rather than rejected — line-wrapped
        # base64 is legal in every encoder that emits it, and validate=True
        # would otherwise refuse it.
        audio_bytes = base64.b64decode(
            "".join(req.audio_base64.split()), validate=True,
        )
    except Exception:
        raise ValueError("audio_base64 is not valid base64")
    return audio_bytes, req.audio_mime_type or "audio/webm"


@router.post("/api/stt", response_model=STTResponse)
async def stt_proxy(request: Request):
    """Proxy a speech-to-text request to the STT server.

    Takes the recorded audio in either of two shapes and forwards the raw
    bytes as multipart form data to the OpenAI-compatible
    /v1/audio/transcriptions endpoint:

    - multipart/form-data with a `file` part — what the frontend sends.
      The blob goes over the wire as-is.
    - application/json with `audio_base64` — the original contract, kept
      working. It costs a FileReader pass in the browser, a 33 % larger
      request, and a decode here, all to deliver the same bytes.

    The content type picks the branch; anything unparseable is a 400,
    because the alternative (guessing) turns a client bug into a
    mysterious 502 from the STT server.
    """
    settings = get_settings()
    if not settings.stt.is_active:
        return JSONResponse(status_code=503, content={"detail": "STT is disabled in settings"})

    content_type = (request.headers.get("content-type") or "").split(";", 1)[0].strip().lower()
    try:
        if content_type == "multipart/form-data":
            audio_bytes, mime_type = await _audio_from_multipart(request)
        else:
            audio_bytes, mime_type = await _audio_from_json(request)
    except ValueError:
        return JSONResponse(status_code=400, content={"detail": "Invalid audio data"})

    if not audio_bytes:
        return JSONResponse(status_code=400, content={"detail": "Invalid audio data"})

    try:
        result = await transcribe_audio(audio_bytes, mime_type=mime_type)
    except Exception:
        return JSONResponse(status_code=502, content={"detail": "Unable to process STT data"})

    if not result:
        return JSONResponse(status_code=502, content={"detail": "Unable to process STT data"})
    return result
