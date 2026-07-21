"""Rider-facing ride orchestration."""

from __future__ import annotations

import os

import httpx
from fastapi import FastAPI, Request
from pydantic import BaseModel, Field

from common.faults import is_active
from common.http import install_request_telemetry


SERVICE = "gateway"
app = FastAPI(title="RideRush Gateway")
install_request_telemetry(app, SERVICE)


class RideRequest(BaseModel):
    rider_id: str
    x: int = Field(ge=0, le=100)
    y: int = Field(ge=0, le=100)
    dest_x: int = Field(ge=0, le=100)
    dest_y: int = Field(ge=0, le=100)


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/request_ride")
async def request_ride(
    ride: RideRequest,
    request: Request,
) -> dict[str, object]:
    if is_active("bad_deploy"):
        _ = ride.model_dump()["missing_field"]

    trace_id = request.state.trace_id
    headers = {"X-Trace-Id": trace_id}
    async with httpx.AsyncClient(timeout=5.0) as client:
        pricing_response = await client.get(
            f"{os.environ['PRICING_URL'].rstrip('/')}/quote",
            params={
                "x": ride.x,
                "y": ride.y,
                "dest_x": ride.dest_x,
                "dest_y": ride.dest_y,
            },
            headers=headers,
        )
        pricing_response.raise_for_status()
        pricing = pricing_response.json()

        matching_response = await client.post(
            f"{os.environ['MATCHING_URL'].rstrip('/')}/assign",
            json={"rider_id": ride.rider_id, "x": ride.x, "y": ride.y},
            headers=headers,
        )
        matching_response.raise_for_status()
        driver_id = matching_response.json().get("driver_id")

        trip_response = await client.post(
            f"{os.environ['TRIPS_URL'].rstrip('/')}/trips",
            json={
                "rider_id": ride.rider_id,
                "driver_id": driver_id,
                "pickup_x": ride.x,
                "pickup_y": ride.y,
                "dest_x": ride.dest_x,
                "dest_y": ride.dest_y,
                "distance": pricing["distance"],
                "quote": pricing["quote"],
                "surge": pricing["surge"],
            },
            headers=headers,
        )
        trip_response.raise_for_status()
        trip = trip_response.json()

    response: dict[str, object] = {
        "trip_id": trip["id"],
        "quote": pricing["quote"],
    }
    if driver_id is not None:
        response["driver_id"] = driver_id
    return response


@app.get("/trip/{trip_id}")
async def get_trip(trip_id: str, request: Request) -> dict[str, object]:
    async with httpx.AsyncClient(timeout=5.0) as client:
        response = await client.get(
            f"{os.environ['TRIPS_URL'].rstrip('/')}/trips/{trip_id}",
            headers={"X-Trace-Id": request.state.trace_id},
        )
        response.raise_for_status()
        return dict(response.json())
