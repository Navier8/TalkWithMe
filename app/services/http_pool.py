"""Shared httpx.AsyncClient pool — keep-alive across calls.

Every outbound call used to build its own ``httpx.AsyncClient`` inside an
``async with``, which closes the connection when the block exits. Streaming
TTS issues one /synthesize per sentence and the chat loop issues one
completion per persona, so a single voice turn paid for a fresh TCP
handshake (and, for https, a TLS handshake) a few dozen times. Pooling is
worth only single-digit milliseconds each on loopback, but it is free and
it removes the jitter.

Clients are keyed by ``(name, timeout)``: httpx binds its timeout to the
client, and the app uses a small fixed set of timeouts per service (a long
one for synthesis/streaming, a short one for health and discovery probes),
so the pool stays at a handful of entries for the life of the process.

Headers are resolved ONCE, when a client is first built for a key. That is
correct for the only header the app sends — the LLM API key, which
llm_auth resolves once per process and which cannot drift mid-run — but it
means a header that *can* change needs a ``reset()`` to take effect.

Lifecycle: built lazily on first use, closed by ``aclose_all()`` from the
FastAPI lifespan. ``reset()`` drops the pool without closing anything; it
exists for the test suite, whose clients are fakes with no sockets to
release (see tests/conftest.py).
"""

import logging
from typing import Dict, Optional, Tuple

import httpx

logger = logging.getLogger(__name__)

# (name, timeout) -> client. `name` keeps the services' pools separate so
# one service's reset or base_url change can never hand another service a
# client built with the wrong headers.
_clients: Dict[Tuple[str, float], httpx.AsyncClient] = {}


def get_client(
    name: str,
    timeout: float,
    headers: Optional[dict] = None,
) -> httpx.AsyncClient:
    """The pooled client for (name, timeout), building it on first use.

    The returned client is SHARED: callers must not close it and must not
    use it as a context manager (``async with`` would close the pool's
    client on exit and leave every later caller with a closed client).
    """
    key = (name, timeout)
    client = _clients.get(key)
    # A client closed out from under the pool (an aclose_all() racing a
    # request in flight) would fail every subsequent call with
    # "client has been closed"; rebuild instead. getattr, because the test
    # suite's fake clients do not carry httpx's is_closed flag.
    if client is None or getattr(client, "is_closed", False):
        client = httpx.AsyncClient(timeout=timeout, headers=headers)
        _clients[key] = client
    return client


def reset() -> None:
    """Drop every pooled client WITHOUT closing it (test hook).

    Tests monkeypatch ``httpx.AsyncClient`` with fakes that hold no
    sockets, so there is nothing to release — and awaiting an aclose() on
    a fake is not possible from a synchronous fixture anyway. Production
    shutdown uses aclose_all().
    """
    _clients.clear()


async def aclose_all() -> None:
    """Close every pooled client. Called from the FastAPI lifespan.

    Best-effort: a client that fails to close is logged and skipped, so a
    single bad connection cannot stall or crash shutdown.
    """
    clients = list(_clients.values())
    _clients.clear()
    for client in clients:
        try:
            await client.aclose()
        except Exception as exc:  # pragma: no cover - shutdown best effort
            logger.debug("Error closing pooled HTTP client: %s", exc)
