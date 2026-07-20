"""Resilient polling for stack-scoped chaos fault flags."""

from __future__ import annotations

import logging
import os
import threading

from supabase import Client, ClientOptions, create_client


LOGGER = logging.getLogger(__name__)
POLL_INTERVAL_SECONDS = 2.0
_REQUEST_TIMEOUT_SECONDS = 1.0

_active_flags: frozenset[str] = frozenset()
_flags_lock = threading.Lock()
_start_lock = threading.Lock()
_started = False
_client: Client | None = None


def _get_client() -> Client:
    global _client

    if _client is None:
        _client = create_client(
            os.environ["SUPABASE_URL"],
            os.environ["SUPABASE_SERVICE_KEY"],
            options=ClientOptions(
                postgrest_client_timeout=_REQUEST_TIMEOUT_SECONDS,
                storage_client_timeout=_REQUEST_TIMEOUT_SECONDS,
                schema="public",
            ),
        )
    return _client


def _refresh_flags() -> None:
    global _active_flags

    stack_id = os.environ["STACK_ID"]
    response = (
        _get_client()
        .table("active_faults")
        .select("fault")
        .eq("stack_id", stack_id)
        .is_("cleared_at", "null")
        .execute()
    )
    flags = frozenset(str(row["fault"]) for row in response.data)
    with _flags_lock:
        previous = _active_flags
        _active_flags = flags
    if flags != previous:
        LOGGER.info("Polled active faults for %s: %s", stack_id, sorted(flags))


def _poll() -> None:
    while True:
        try:
            _refresh_flags()
        except Exception:
            LOGGER.exception("Fault poll failed; retaining last known flags")
        threading.Event().wait(POLL_INTERVAL_SECONDS)


def start_fault_poller() -> None:
    """Start the process-wide poller exactly once."""
    global _started

    with _start_lock:
        if _started:
            return
        thread = threading.Thread(
            target=_poll,
            name="fault-poller",
            daemon=True,
        )
        thread.start()
        _started = True


def is_active(name: str) -> bool:
    """Return whether a fault was present in the latest successful poll."""
    with _flags_lock:
        return name in _active_flags


start_fault_poller()
