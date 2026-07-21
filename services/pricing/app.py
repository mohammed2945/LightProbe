"""Pricing quotes and periodic rate refresh."""

from __future__ import annotations

import asyncio
import logging
import os
import threading
from contextlib import asynccontextmanager, suppress
from typing import Annotated, Any

from fastapi import FastAPI, HTTPException, Query

from common.db import get_client
from common.faults import is_active
from common.http import install_request_telemetry


SERVICE = "pricing"
LOGGER = logging.getLogger(__name__)
RATE_REFRESH_SECONDS = 20
BASE_RATE = 2.45

_cached_rate = BASE_RATE
_rate_lock = threading.Lock()


@asynccontextmanager
async def lifespan(_: FastAPI):
    task = asyncio.create_task(_rate_refresh_loop())
    yield
    task.cancel()
    with suppress(asyncio.CancelledError):
        await task


app = FastAPI(title="RideRush Pricing", lifespan=lifespan)
install_request_telemetry(app, SERVICE)


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/quote")
def quote(
    x: Annotated[int, Query(ge=0, le=100)],
    y: Annotated[int, Query(ge=0, le=100)],
    dest_x: Annotated[int, Query(ge=0, le=100)],
    dest_y: Annotated[int, Query(ge=0, le=100)],
) -> dict[str, float | int]:
    stack_id = os.environ["STACK_ID"]
    response = (
        get_client()
        .table("pricing_config")
        .select("per_mile_rate,surge,base_fare")
        .eq("stack_id", stack_id)
        .limit(1)
        .execute()
    )
    if not response.data:
        raise HTTPException(status_code=503, detail="Pricing is not configured")

    config: dict[str, Any] = response.data[0]
    rate = config["per_mile_rate"]
    if isinstance(rate, (int, float)):
        with _rate_lock:
            global _cached_rate
            _cached_rate = float(rate)
    else:
        with _rate_lock:
            rate = _cached_rate

    distance = abs(dest_x - x) + abs(dest_y - y)
    surge = 50.0 if is_active("surge_poison") else float(config["surge"])
    amount = float(config["base_fare"]) + float(rate) * distance * surge
    return {
        "quote": round(amount, 2),
        "distance": distance,
        "surge": surge,
    }


async def _rate_refresh_loop() -> None:
    while True:
        await asyncio.sleep(RATE_REFRESH_SECONDS)
        try:
            await asyncio.to_thread(_refresh_rate)
        except Exception:
            LOGGER.exception("Rate refresh failed")


def _refresh_rate() -> None:
    stack_id = os.environ["STACK_ID"]
    value: float | str = "2,45" if is_active("fare_corrupt") else BASE_RATE
    (
        get_client()
        .table("pricing_config")
        .update({"per_mile_rate": value})
        .eq("stack_id", stack_id)
        .execute()
    )
    if isinstance(value, float):
        with _rate_lock:
            global _cached_rate
            _cached_rate = value
