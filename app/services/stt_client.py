"""STT client — talks to an OpenAI-compatible STT server.

Sends raw audio as a multipart form POST to /v1/audio/transcriptions.
The STT server is optional. If it's down or misconfigured, the app logs
a warning and returns None to the caller.
"""

import logging
import mimetypes
import time
from typing import Optional

import httpx

from app.config import get_settings
from app.services import http_pool

logger = logging.getLogger(__name__)

# /health is a liveness probe, not a transcription: it gets its own short
# budget rather than stt.timeout. Named because it keys a pooled client.
_HEALTH_TIMEOUT_S = 3.0


def _mime_to_extension(mime_type: str) -> str:
    """Derive a file extension from a MIME type, falling back to 'bin'."""
    base = (mime_type or "").split(";", 1)[0].strip()
    if "/" not in base:
        return "bin"
    if base == "audio/webm":
        return "webm"
    ext = mimetypes.guess_extension(base)
    if ext and ext.startswith("."):
        return ext[1:]  # strip leading dot
    # Fallback: use the subtype (e.g. "audio/webm" -> "webm")
    subtype = base.split("/", 1)[1]
    return subtype or "bin"


async def check_stt_health() -> bool:
    """Return True if the STT server is reachable.

    Accepts both 200 (endpoint exists) and 404 (server is up but lacks /health).
    Any other outcome — connection error, timeout, 5xx — means the server is down.
    """
    settings = get_settings()
    if not settings.stt.is_active:
        return False
    try:
        client = http_pool.get_client("stt", _HEALTH_TIMEOUT_S)
        resp = await client.get(f"{settings.stt.base_url}/health")
        return resp.status_code in (200, 404)
    except Exception:
        return False


async def transcribe_audio(audio_bytes: bytes, mime_type: str = "audio/webm") -> Optional[dict]:
    """Call the STT server's /v1/audio/transcriptions endpoint.

    Sends raw audio as multipart form data with response_format=json.
    Returns dict with keys: text, language, language_probability.
    Returns None on any failure.
    """
    settings = get_settings()
    if not settings.stt.is_active:
        logger.warning("STT transcribe skipped: feature not active (no base_url or disabled)")
        return None
    if not audio_bytes:
        logger.warning("STT transcribe skipped: no audio data provided")
        return None
    url = f"{settings.stt.base_url}/v1/audio/transcriptions"

    # Derive a sensible filename from the MIME type so the STT server
    # can identify the format. E.g. "audio/ogg" -> "audio.ogg"
    mime_type = (mime_type or "audio/webm").split(";", 1)[0].strip() or "audio/webm"
    ext = _mime_to_extension(mime_type)
    files = {
        "file": (f"audio.{ext}", audio_bytes, mime_type),
    }
    data = {
        "response_format": "json",
    }

    started = time.monotonic()
    try:
        client = http_pool.get_client("stt", settings.stt.timeout)
        resp = await client.post(url, files=files, data=data)
        resp.raise_for_status()
        json_response = resp.json()
        if settings.general.debug_latency:
            logger.info(
                "[latency] STT transcription: %.0f ms (%d bytes of %s audio)",
                (time.monotonic() - started) * 1000, len(audio_bytes), mime_type,
            )
        text = json_response.get("text") or "No response received from STT server"
        return {
            "text": text,
            # "language" is optional in the response; default to "en" if absent
            "language": json_response.get("language") or "en",
            # "language_probability" is optional; None if the server doesn't provide it
            "language_probability": json_response.get("language_probability"),
        }
    except httpx.ConnectError as exc:
        logger.error("STT connect error (server unreachable at %s): %s", url, exc)
    except httpx.TimeoutException as exc:
        logger.error("STT timeout after %.0fs: %s", settings.stt.timeout, exc)
    except httpx.HTTPStatusError as exc:
        logger.error("STT HTTP %d from %s: %s", exc.response.status_code, url, exc)
    except Exception as exc:
        logger.warning("STT transcribe failed: %s", exc)
    return None
