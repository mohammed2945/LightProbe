"""Continuous deterministic rider request generation."""

from __future__ import annotations

import asyncio
import logging
import os
import random
from contextlib import asynccontextmanager, suppress
from uuid import uuid4

import httpx
from fastapi import FastAPI

from common.db import get_client
from common.http import install_request_telemetry


SERVICE = "ridersim"
LOGGER = logging.getLogger(__name__)
REQUEST_INTERVAL_SECONDS = 4.0


@asynccontextmanager
async def lifespan(_: FastAPI):
    task = asyncio.create_task(_rider_loop())
    yield
    task.cancel()
    with suppress(asyncio.CancelledError):
        await task


app = FastAPI(title="RideRush Rider Simulator", lifespan=lifespan)
install_request_telemetry(app, SERVICE)


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


async def _rider_loop() -> None:
    stack_id = os.environ["STACK_ID"]
    random_source = random.Random(f"ridersim:{stack_id}")
    gateway_url = os.environ["GATEWAY_URL"].rstrip("/")
    counter = 0

    async with httpx.AsyncClient(timeout=8.0) as http:
        while True:
            started_at = asyncio.get_running_loop().time()
            try:
                idle_count = await asyncio.to_thread(_idle_driver_count, stack_id)
                request_count = 2 if idle_count == 1 else 1
                payloads: list[tuple[dict[str, object], str]] = []
                for _ in range(request_count):
                    counter += 1
                    payloads.append(
                        (
                            _random_ride(random_source, counter),
                            str(uuid4()),
                        )
                    )
                await asyncio.gather(
                    *(
                        _request_ride(http, gateway_url, payload, trace_id)
                        for payload, trace_id in payloads
                    )
                )
            except Exception:
                LOGGER.exception("Rider simulation iteration failed")

            elapsed = asyncio.get_running_loop().time() - started_at
            await asyncio.sleep(max(0.0, REQUEST_INTERVAL_SECONDS - elapsed))


def _idle_driver_count(stack_id: str) -> int:
    rows = (
        get_client()
        .table("drivers")
        .select("id")
        .eq("stack_id", stack_id)
        .eq("status", "idle")
        .execute()
        .data
    )
    return len(rows)


def _random_ride(
    random_source: random.Random,
    counter: int,
) -> dict[str, object]:
    x = random_source.randint(0, 100)
    y = random_source.randint(0, 100)
    dest_x = random_source.randint(0, 100)
    dest_y = random_source.randint(0, 100)
    while dest_x == x and dest_y == y:
        dest_x = random_source.randint(0, 100)
        dest_y = random_source.randint(0, 100)
    return {
        "rider_id": f"r{counter}-{uuid4().hex[:6]}",
        "x": x,
        "y": y,
        "dest_x": dest_x,
        "dest_y": dest_y,
    }


async def _request_ride(
    http: httpx.AsyncClient,
    gateway_url: str,
    payload: dict[str, object],
    trace_id: str,
) -> None:
    response = await http.post(
        f"{gateway_url}/request_ride",
        json=payload,
        headers={"X-Trace-Id": trace_id},
    )
    if response.status_code >= 400:
        LOGGER.warning(
            "Rider request failed status=%s trace_id=%s",
            response.status_code,
            trace_id,
        )
