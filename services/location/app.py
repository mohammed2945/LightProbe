"""Driver position reads and writes."""

from __future__ import annotations

import asyncio
import os
import threading
from typing import Literal

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, Field

from common.db import get_client
from common.faults import is_active
from common.http import install_request_telemetry


SERVICE = "location"
_LEAK_CHUNK_BYTES = 1024 * 1024
_LEAK_CAP_MB = 150
_LEAK_SECONDS_PER_MB = 0.006
_leak_chunks: list[bytearray] = []
_leak_lock = threading.Lock()

app = FastAPI(title="RideRush Location")


def _leak_mb() -> int:
    with _leak_lock:
        return len(_leak_chunks)


def clear_leak() -> int:
    """Drop process-local leak buffers so demos can re-run without redeploy."""
    with _leak_lock:
        freed = len(_leak_chunks)
        _leak_chunks.clear()
        return freed


@app.middleware("http")
async def apply_mem_leak(request: Request, call_next):
    allocated_mb = 0
    if is_active("mem_leak"):
        with _leak_lock:
            if len(_leak_chunks) < _LEAK_CAP_MB:
                _leak_chunks.append(bytearray(_LEAK_CHUNK_BYTES))
            allocated_mb = len(_leak_chunks)
        await asyncio.sleep(min(allocated_mb * _LEAK_SECONDS_PER_MB, 0.9))
    elif _leak_mb():
        # Fault cleared — free memory so the next injection starts clean.
        clear_leak()

    response = await call_next(request)
    if allocated_mb:
        response.headers["X-RideRush-Mem-MB"] = str(allocated_mb)
    return response


install_request_telemetry(app, SERVICE)


class PositionUpdate(BaseModel):
    x: int = Field(ge=0, le=100)
    y: int = Field(ge=0, le=100)
    status: Literal["idle", "enroute", "ontrip"] | None = None


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/reset_leak")
def reset_leak() -> dict[str, int]:
    return {"freed_mb": clear_leak()}


@app.get("/drivers")
def list_drivers(
    status: Literal["idle", "enroute", "ontrip"] | None = None,
) -> list[dict[str, object]]:
    stack_id = os.environ["STACK_ID"]
    query = (
        get_client()
        .table("drivers")
        .select("id,x,y,status")
        .eq("stack_id", stack_id)
    )
    if status is not None:
        query = query.eq("status", status)
    return list(query.order("id").execute().data)


@app.get("/drivers/{driver_id}")
def get_driver(driver_id: str) -> dict[str, object]:
    stack_id = os.environ["STACK_ID"]
    response = (
        get_client()
        .table("drivers")
        .select("id,x,y,status")
        .eq("stack_id", stack_id)
        .eq("id", driver_id)
        .limit(1)
        .execute()
    )
    if not response.data:
        raise HTTPException(status_code=404, detail="Driver not found")
    return dict(response.data[0])


@app.put("/drivers/{driver_id}/position")
def update_position(driver_id: str, update: PositionUpdate) -> dict[str, object]:
    stack_id = os.environ["STACK_ID"]
    values: dict[str, object] = {"x": update.x, "y": update.y}
    if update.status is not None:
        values["status"] = update.status

    response = (
        get_client()
        .table("drivers")
        .update(values)
        .eq("stack_id", stack_id)
        .eq("id", driver_id)
        .execute()
    )
    if not response.data:
        raise HTTPException(status_code=404, detail="Driver not found")
    return dict(response.data[0])
