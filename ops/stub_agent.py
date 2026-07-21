"""Audience-facing placeholder agent that narrates and clears faults."""

from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager, suppress
from datetime import datetime, timezone
from typing import Any

from fastapi import FastAPI

from common.db import get_client
from common.http import install_request_telemetry
from common.telemetry import emit


SERVICE = "agent"
LOGGER = logging.getLogger(__name__)
POLL_SECONDS = 1.0

FAULT_DELAYS = {
    "db_kill": 8,
    "bad_deploy": 9,
    "mem_leak": 10,
    "surge_poison": 11,
    "fare_corrupt": 12,
    "double_dispatch": 13,
}

FAULT_SCRIPTS = {
    "db_kill": (
        "Database calls are failing across matching and trips.",
        "Isolating the fault flag and restoring the shared connection path.",
        "Database access restored — resuming dispatch.",
    ),
    "bad_deploy": (
        "Gateway errors started immediately after the latest deployment.",
        "Rolling the request handler back to the last known-good path.",
        "Gateway recovered — ride requests are flowing again.",
    ),
    "mem_leak": (
        "Location latency is climbing with retained memory.",
        "Stopping further allocation at the configured safety cap.",
        "Memory fault contained — response latency is back to normal.",
    ),
    "surge_poison": (
        "Quotes are spiking far beyond the expected fare range.",
        "Restoring the seeded surge multiplier.",
        "Pricing normalized — new quotes are back within bounds.",
    ),
    "fare_corrupt": (
        "Payments are failing on a malformed per-mile rate.",
        "Tracing the bad value back to pricing's refresh write.",
        "Restoring numeric rate 2.45 — captures can resume.",
    ),
    "double_dispatch": (
        "Two rides were assigned to the same driver.",
        "Closing the read/write race and reconciling active trips.",
        "Reassigning rider to nearest driver — reconciling duplicate dispatch.",
    ),
}


@asynccontextmanager
async def lifespan(_: FastAPI):
    task = asyncio.create_task(_agent_loop())
    yield
    task.cancel()
    with suppress(asyncio.CancelledError):
        await task


app = FastAPI(title="RideRush Stub Agent", lifespan=lifespan)
install_request_telemetry(app, SERVICE)


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


async def _agent_loop() -> None:
    while True:
        try:
            fault = await asyncio.to_thread(_active_fault)
            if fault is not None and await asyncio.to_thread(_has_signal, fault):
                await _narrate_and_clear(fault)
        except Exception:
            LOGGER.exception("Stub agent iteration failed")
        await asyncio.sleep(POLL_SECONDS)


def _active_fault() -> dict[str, Any] | None:
    stack_id = os.environ["STACK_ID"]
    rows = (
        get_client()
        .table("active_faults")
        .select("id,ts,fault")
        .eq("stack_id", stack_id)
        .is_("cleared_at", "null")
        .order("ts")
        .limit(1)
        .execute()
        .data
    )
    return dict(rows[0]) if rows else None


def _has_signal(fault: dict[str, Any]) -> bool:
    stack_id = os.environ["STACK_ID"]
    rows = (
        get_client()
        .table("events")
        .select("service,kind,payload")
        .eq("stack_id", stack_id)
        .gte("ts", fault["ts"])
        .in_("kind", ["error", "invariant_breach", "request"])
        .execute()
        .data
    )
    errors = sum(1 for row in rows if row["kind"] == "error")
    has_breach = any(row["kind"] == "invariant_breach" for row in rows)
    has_mem_signal = (
        fault["fault"] == "mem_leak"
        and any(
            row["kind"] == "request"
            and row["service"] == "location"
            and float(row["payload"].get("latency_ms", 0)) >= 6
            for row in rows
        )
    )
    return errors >= 2 or has_breach or has_mem_signal


async def _narrate_and_clear(fault: dict[str, Any]) -> None:
    fault_name = str(fault["fault"])
    await asyncio.sleep(FAULT_DELAYS[fault_name])
    if not await asyncio.to_thread(_still_active, int(fault["id"])):
        return

    stack_id = os.environ["STACK_ID"]
    for message in FAULT_SCRIPTS[fault_name]:
        print(f"[agent] {message}", flush=True)
        emit(
            stack_id,
            SERVICE,
            "agent_action",
            None,
            {"message": message},
        )
        await asyncio.sleep(0.5)

    await asyncio.to_thread(_clear_fault, int(fault["id"]))
    emit(
        stack_id,
        SERVICE,
        "fault_cleared",
        None,
        {"fault": fault_name, "source": "stub_agent"},
    )


def _still_active(fault_id: int) -> bool:
    stack_id = os.environ["STACK_ID"]
    rows = (
        get_client()
        .table("active_faults")
        .select("id")
        .eq("stack_id", stack_id)
        .eq("id", fault_id)
        .is_("cleared_at", "null")
        .execute()
        .data
    )
    return bool(rows)


def _clear_fault(fault_id: int) -> None:
    stack_id = os.environ["STACK_ID"]
    (
        get_client()
        .table("active_faults")
        .update({"cleared_at": datetime.now(timezone.utc).isoformat()})
        .eq("stack_id", stack_id)
        .eq("id", fault_id)
        .execute()
    )
