"""Nearest-idle-driver matching."""

from __future__ import annotations

import os
import time
from typing import Any

from fastapi import FastAPI
from pydantic import BaseModel, Field
from supabase import Client

from common.db import get_client
from common.faults import is_active
from common.http import install_request_telemetry


SERVICE = "matching"
app = FastAPI(title="RideRush Matching")
install_request_telemetry(app, SERVICE)


class AssignmentRequest(BaseModel):
    rider_id: str
    x: int = Field(ge=0, le=100)
    y: int = Field(ge=0, le=100)


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/assign")
def assign_driver(request: AssignmentRequest) -> dict[str, str | None]:
    stack_id = os.environ["STACK_ID"]

    # Keep this availability READ separate from the assignment WRITE.
    drivers = _read_idle_drivers(stack_id)
    if not drivers:
        return {"driver_id": None}

    driver = min(
        drivers,
        key=lambda item: (
            abs(int(item["x"]) - request.x) + abs(int(item["y"]) - request.y),
            str(item["id"]),
        ),
    )

    if is_active("double_dispatch"):
        time.sleep(0.2)

    # Deliberately not an atomic compare-and-swap: the race fault depends on it.
    _write_assignment(stack_id, str(driver["id"]))
    return {"driver_id": str(driver["id"])}


def _db() -> Client:
    if is_active("db_kill"):
        raise ConnectionError("db_kill is active")
    return get_client()


def _read_idle_drivers(stack_id: str) -> list[dict[str, Any]]:
    response = (
        _db()
        .table("drivers")
        .select("id,x,y")
        .eq("stack_id", stack_id)
        .eq("status", "idle")
        .execute()
    )
    return list(response.data)


def _write_assignment(stack_id: str, driver_id: str) -> None:
    (
        _db()
        .table("drivers")
        .update({"status": "enroute"})
        .eq("stack_id", stack_id)
        .eq("id", driver_id)
        .execute()
    )
