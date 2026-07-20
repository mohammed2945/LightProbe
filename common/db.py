"""Shared lazy Supabase client construction."""

from __future__ import annotations

import os
import threading

from supabase import Client, ClientOptions, create_client


_client: Client | None = None
_client_lock = threading.Lock()


def get_client() -> Client:
    """Return the process-wide service-role Supabase client."""
    global _client

    with _client_lock:
        if _client is None:
            _client = create_client(
                os.environ["SUPABASE_URL"],
                os.environ["SUPABASE_SERVICE_KEY"],
                options=ClientOptions(
                    postgrest_client_timeout=5.0,
                    storage_client_timeout=5.0,
                    schema="public",
                ),
            )
        return _client
