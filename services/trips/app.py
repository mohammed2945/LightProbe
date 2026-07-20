"""Trip creation and lifecycle management."""

from __future__ import annotations

import asyncio
import logging
import os
from collections import Counter
from contextlib import asynccontextmanager, suppress
from datetime import datetime, timedelta, timezone
from typing import Literal
from uuid import uuid4

import httpx
from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, Field
from supabase import Client

from common.db import get_client
from common.faults import is_active
from common.http import install_request_telemetry
from common.telemetry import emit


SERVICE = "trips"
LOGGER = logging.getLogger(__name__)
INVARIANT_INTERVAL_SECONDS = 5


@asynccontextmanager
async def lifespan(_: FastAPI):
    task = asyncio.create_task(_invariant_loop())
    yield
    task.cancel()
    with suppress(asyncio.CancelledError):
        await task


app = FastAPI(title="RideRush Trips", lifespan=lifespan)
install_request_telemetry(app, SERVICE)


class TripCreateRequest(BaseModel):
    rider_id: str
    driver_id: str | None = None
    pickup_x: int = Field(ge=0, le=100)
    pickup_y: int = Field(ge=0, le=100)
    dest_x: int = Field(ge=0, le=100)
    dest_y: int = Field(ge=0, le=100)
    distance: int = Field(ge=0)
    quote: float
    surge: float = Field(gt=0)


class TripStatusUpdate(BaseModel):
    status: Literal["matched", "enroute"]


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/trips")
def create_trip(request: TripCreateRequest) -> dict[str, object]:
    stack_id = os.environ["STACK_ID"]
    trip_id = str(uuid4())
    status = "matched" if request.driver_id else "requested"
    response = (
        _db()
        .table("trips")
        .insert(
            {
                "stack_id": stack_id,
                "id": trip_id,
                "rider_id": request.rider_id,
                "driver_id": request.driver_id,
                "pickup_x": request.pickup_x,
                "pickup_y": request.pickup_y,
                "dest_x": request.dest_x,
                "dest_y": request.dest_y,
                "distance": request.distance,
                "quote": request.quote,
                "surge": request.surge,
                "status": status,
            }
        )
        .execute()
    )
    return dict(response.data[0])


@app.get("/trips/{trip_id}")
def get_trip(trip_id: str) -> dict[str, object]:
    return _get_trip(os.environ["STACK_ID"], trip_id)


@app.patch("/trips/{trip_id}/status")
def update_trip_status(
    trip_id: str,
    update: TripStatusUpdate,
) -> dict[str, object]:
    stack_id = os.environ["STACK_ID"]
    trip = _get_trip(stack_id, trip_id)
    current = str(trip["status"])
    if current == update.status:
        return trip
    allowed = {
        "requested": {"matched"},
        "matched": {"enroute"},
        "enroute": set(),
        "completed": set(),
    }
    if update.status not in allowed.get(current, set()):
        raise HTTPException(
            status_code=409,
            detail=f"Invalid trip transition {current}->{update.status}",
        )
    response = (
        _db()
        .table("trips")
        .update({"status": update.status})
        .eq("stack_id", stack_id)
        .eq("id", trip_id)
        .execute()
    )
    return dict(response.data[0])


@app.post("/trips/{trip_id}/complete")
def complete_trip(trip_id: str, request: Request) -> dict[str, object]:
    stack_id = os.environ["STACK_ID"]
    trip = _get_trip(stack_id, trip_id)
    if trip["status"] == "completed":
        return trip
    if not trip.get("driver_id"):
        raise HTTPException(status_code=409, detail="Trip has no assigned driver")
    if trip["status"] == "matched":
        (
            _db()
            .table("trips")
            .update({"status": "enroute"})
            .eq("stack_id", stack_id)
            .eq("id", trip_id)
            .execute()
        )
    elif trip["status"] != "enroute":
        raise HTTPException(status_code=409, detail="Trip cannot be completed")

    payment_response = httpx.post(
        f"{os.environ['PAYMENTS_URL'].rstrip('/')}/capture",
        json={
            "trip_id": trip_id,
            "distance": trip["distance"],
            "surge": trip["surge"],
        },
        headers={"X-Trace-Id": request.state.trace_id},
        timeout=5.0,
    )
    payment_response.raise_for_status()
    payment = payment_response.json()

    completed_at = datetime.now(timezone.utc).isoformat()
    response = (
        _db()
        .table("trips")
        .update(
            {
                "status": "completed",
                "fare": payment["amount"],
                "completed_at": completed_at,
            }
        )
        .eq("stack_id", stack_id)
        .eq("id", trip_id)
        .execute()
    )
    (
        _db()
        .table("drivers")
        .update({"status": "idle"})
        .eq("stack_id", stack_id)
        .eq("id", str(trip["driver_id"]))
        .execute()
    )
    return dict(response.data[0])


def _db() -> Client:
    if is_active("db_kill"):
        raise ConnectionError("db_kill is active")
    return get_client()


def _get_trip(stack_id: str, trip_id: str) -> dict[str, object]:
    response = (
        _db()
        .table("trips")
        .select("*")
        .eq("stack_id", stack_id)
        .eq("id", trip_id)
        .limit(1)
        .execute()
    )
    if not response.data:
        raise HTTPException(status_code=404, detail="Trip not found")
    return dict(response.data[0])


async def _invariant_loop() -> None:
    while True:
        await asyncio.sleep(INVARIANT_INTERVAL_SECONDS)
        try:
            await asyncio.to_thread(_check_invariants)
        except Exception:
            LOGGER.exception("Invariant check failed")


def _check_invariants() -> None:
    stack_id = os.environ["STACK_ID"]

    active_trips = (
        _db()
        .table("trips")
        .select("driver_id")
        .eq("stack_id", stack_id)
        .in_("status", ["matched", "enroute"])
        .execute()
        .data
    )
    trip_counts = Counter(
        str(trip["driver_id"])
        for trip in active_trips
        if trip.get("driver_id") is not None
    )
    for driver_id, count in trip_counts.items():
        if count > 1:
            _emit_breach(
                stack_id,
                "driver_single_trip",
                f"{driver_id} active_trips={count}",
            )

    payments = (
        _db()
        .table("payments")
        .select("id,amount")
        .eq("stack_id", stack_id)
        .eq("status", "captured")
        .execute()
        .data
    )
    for payment in payments:
        amount = payment.get("amount")
        if not isinstance(amount, (int, float)) or not 0 < float(amount) < 500:
            _emit_breach(
                stack_id,
                "captured_fare_range",
                f"payment {payment.get('id')} amount={amount}",
            )

    idle_drivers = (
        _db()
        .table("drivers")
        .select("id")
        .eq("stack_id", stack_id)
        .eq("status", "idle")
        .limit(1)
        .execute()
        .data
    )
    if not idle_drivers:
        return

    cutoff = (datetime.now(timezone.utc) - timedelta(seconds=45)).isoformat()
    stale_trips = (
        _db()
        .table("trips")
        .select("id,rider_id,created_at")
        .eq("stack_id", stack_id)
        .eq("status", "requested")
        .lt("created_at", cutoff)
        .execute()
        .data
    )
    for trip in stale_trips:
        _emit_breach(
            stack_id,
            "rider_match_timeout",
            (
                f"rider {trip.get('rider_id')} trip={trip.get('id')} "
                f"requested_since={trip.get('created_at')} idle_drivers_exist"
            ),
        )


def _emit_breach(stack_id: str, invariant: str, detail: str) -> None:
    emit(
        stack_id,
        SERVICE,
        "invariant_breach",
        None,
        {"invariant": invariant, "detail": detail},
    )
