"""Best-effort, non-blocking event telemetry."""

from __future__ import annotations

import logging
import queue
import threading
from typing import TypeAlias

from supabase import Client, ClientOptions, create_client


LOGGER = logging.getLogger(__name__)
WRITE_TIMEOUT_SECONDS = 1.0
_QUEUE_CAPACITY = 1024

Payload: TypeAlias = dict[str, object]
Event: TypeAlias = tuple[str, str, str, str | None, Payload]

_events: queue.Queue[Event] = queue.Queue(maxsize=_QUEUE_CAPACITY)
_client: Client | None = None
_client_lock = threading.Lock()


def _get_client() -> Client:
    global _client

    with _client_lock:
        if _client is None:
            import os

            url = os.environ["SUPABASE_URL"]
            key = os.environ["SUPABASE_SERVICE_KEY"]
            _client = create_client(
                url,
                key,
                options=ClientOptions(
                    postgrest_client_timeout=WRITE_TIMEOUT_SECONDS,
                    storage_client_timeout=WRITE_TIMEOUT_SECONDS,
                    schema="public",
                ),
            )
        return _client


def _write_event(event: Event) -> None:
    stack_id, service, kind, trace_id, payload = event
    _get_client().table("events").insert(
        {
            "stack_id": stack_id,
            "service": service,
            "kind": kind,
            "trace_id": trace_id,
            "payload": payload,
        }
    ).execute()


def _worker() -> None:
    while True:
        event = _events.get()
        try:
            _write_event(event)
        except Exception:
            LOGGER.exception("Telemetry write failed")
        finally:
            _events.task_done()


_worker_thread = threading.Thread(
    target=_worker,
    name="telemetry-writer",
    daemon=True,
)
_worker_thread.start()


def emit(
    stack_id: str,
    service: str,
    kind: str,
    trace_id: str | None,
    payload: Payload,
) -> None:
    """Queue an event without blocking or raising into the caller."""
    try:
        _events.put_nowait((stack_id, service, kind, trace_id, payload))
    except Exception:
        LOGGER.exception("Telemetry event dropped")
