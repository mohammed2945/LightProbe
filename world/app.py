"""Deterministic one-tick-per-second RideRush city simulation."""

from __future__ import annotations

import asyncio
import json
import logging
import math
import os
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal
from uuid import NAMESPACE_URL, uuid5

import httpx
from fastapi import FastAPI

from common.db import get_client
from common.http import install_request_telemetry
from common.telemetry import emit


SERVICE = "world"
LOGGER = logging.getLogger(__name__)
TICK_SECONDS = 1.0
DRIVER_SPEED_PER_TICK = 5
STRANDED_AFTER_SECONDS = 20
MAX_TICK_BYTES = 4096
MAX_RIDERS_IN_TICK = 24


@dataclass(frozen=True)
class TripAction:
    kind: Literal["pickup", "complete"]
    trip_id: str
    trace_id: str


class WorldEngine:
    def __init__(self) -> None:
        self.stack_id = os.environ["STACK_ID"]

    def step(self, tick: int) -> tuple[dict[str, Any], int, list[TripAction]]:
        client = get_client()
        config_rows = (
            client.table("pricing_config")
            .select("surge")
            .eq("stack_id", self.stack_id)
            .limit(1)
            .execute()
            .data
        )
        surge = float(config_rows[0]["surge"]) if config_rows else 1.0
        driver_rows = list(
            client.table("drivers")
            .select("id,x,y,status")
            .eq("stack_id", self.stack_id)
            .order("id")
            .execute()
            .data
        )
        trip_rows = list(
            client.table("trips")
            .select(
                "id,rider_id,driver_id,pickup_x,pickup_y,dest_x,dest_y,"
                "distance,quote,status,created_at"
            )
            .eq("stack_id", self.stack_id)
            .in_("status", ["requested", "matched", "enroute"])
            .order("created_at")
            .execute()
            .data
        )

        drivers = {str(row["id"]): dict(row) for row in driver_rows}
        updates: dict[str, dict[str, object]] = {}
        actions: list[TripAction] = []
        assigned_drivers: set[str] = set()

        for trip in trip_rows:
            driver_id = trip.get("driver_id")
            if driver_id is None or trip["status"] == "requested":
                continue
            driver_key = str(driver_id)
            if driver_key in assigned_drivers or driver_key not in drivers:
                continue
            assigned_drivers.add(driver_key)
            driver = drivers[driver_key]

            if trip["status"] == "matched":
                target_x, target_y = int(trip["pickup_x"]), int(trip["pickup_y"])
                next_status = "enroute"
                action_kind: Literal["pickup", "complete"] = "pickup"
            else:
                target_x, target_y = int(trip["dest_x"]), int(trip["dest_y"])
                next_status = "ontrip"
                action_kind = "complete"

            next_x, next_y = _move_manhattan(
                int(driver["x"]),
                int(driver["y"]),
                target_x,
                target_y,
                DRIVER_SPEED_PER_TICK,
            )
            arrived = next_x == target_x and next_y == target_y
            if arrived and action_kind == "pickup":
                next_status = "ontrip"

            driver.update({"x": next_x, "y": next_y, "status": next_status})
            updates[driver_key] = {
                "stack_id": self.stack_id,
                "id": driver_key,
                "x": next_x,
                "y": next_y,
                "status": next_status,
            }
            if arrived:
                actions.append(
                    TripAction(
                        kind=action_kind,
                        trip_id=str(trip["id"]),
                        trace_id=str(
                            uuid5(NAMESPACE_URL, f"riderush:{trip['id']}")
                        ),
                    )
                )

        if updates:
            (
                client.table("drivers")
                .upsert(list(updates.values()), on_conflict="stack_id,id")
                .execute()
            )

        riders, stranded_count = self._rider_payloads(trip_rows, drivers)
        payload: dict[str, Any] = {
            "tick": tick,
            "surge": surge,
            "drivers": [
                {
                    "id": str(driver["id"]),
                    "x": int(driver["x"]),
                    "y": int(driver["y"]),
                    "st": str(driver["status"]),
                }
                for driver in sorted(drivers.values(), key=lambda item: str(item["id"]))
            ],
            "riders": riders[:MAX_RIDERS_IN_TICK],
        }
        _trim_payload(payload)
        return payload, stranded_count, actions

    def _rider_payloads(
        self,
        trips: list[dict[str, Any]],
        drivers: dict[str, dict[str, Any]],
    ) -> tuple[list[dict[str, object]], int]:
        now = datetime.now().astimezone()
        riders: list[dict[str, object]] = []
        stranded_count = 0
        for trip in trips:
            status = str(trip["status"])
            pickup_x, pickup_y = int(trip["pickup_x"]), int(trip["pickup_y"])
            rider_x, rider_y = pickup_x, pickup_y
            eta_s = 0

            if status == "requested":
                age = (now - _parse_timestamp(str(trip["created_at"]))).total_seconds()
                rider_status = "stranded" if age >= STRANDED_AFTER_SECONDS else "waiting"
                if rider_status == "stranded":
                    stranded_count += 1
            elif status == "matched":
                rider_status = "matched"
                driver = drivers.get(str(trip.get("driver_id")))
                if driver is not None:
                    remaining = abs(int(driver["x"]) - pickup_x) + abs(
                        int(driver["y"]) - pickup_y
                    )
                    eta_s = math.ceil(
                        (remaining + int(trip["distance"])) / DRIVER_SPEED_PER_TICK
                    )
            else:
                rider_status = "riding"
                driver = drivers.get(str(trip.get("driver_id")))
                if driver is not None:
                    rider_x, rider_y = int(driver["x"]), int(driver["y"])
                    remaining = abs(int(driver["x"]) - int(trip["dest_x"])) + abs(
                        int(driver["y"]) - int(trip["dest_y"])
                    )
                    eta_s = math.ceil(remaining / DRIVER_SPEED_PER_TICK)

            riders.append(
                {
                    "id": str(trip["rider_id"]),
                    "x": rider_x,
                    "y": rider_y,
                    "st": rider_status,
                    "eta_s": eta_s,
                    "quote": f"${float(trip['quote']):.2f}",
                }
            )
        return riders, stranded_count


@asynccontextmanager
async def lifespan(_: FastAPI):
    task = asyncio.create_task(_world_loop())
    yield
    task.cancel()
    with suppress(asyncio.CancelledError):
        await task


app = FastAPI(title="RideRush World", lifespan=lifespan)
install_request_telemetry(app, SERVICE)


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


async def _world_loop() -> None:
    engine = WorldEngine()
    loop = asyncio.get_running_loop()
    next_tick_at = loop.time()
    tick = 0
    last_payload: dict[str, Any] = {
        "tick": 0,
        "surge": 1.0,
        "drivers": [],
        "riders": [],
    }
    stranded_count = 0
    action_tasks: dict[TripAction, asyncio.Task[None]] = {}
    state_task: asyncio.Task[
        tuple[dict[str, Any], int, list[TripAction]]
    ] | None = None

    async with httpx.AsyncClient(timeout=8.0) as http:
        try:
            while True:
                tick += 1
                actions: list[TripAction] = []
                if state_task is not None and state_task.done():
                    try:
                        last_payload, stranded_count, actions = state_task.result()
                    except Exception:
                        LOGGER.exception("World tick state update failed")
                    state_task = None

                if state_task is None:
                    state_task = asyncio.create_task(
                        asyncio.to_thread(engine.step, tick)
                    )

                payload = dict(last_payload)
                payload["tick"] = tick

                emit(engine.stack_id, SERVICE, "world_tick", None, payload)
                if tick % 5 == 0:
                    emit(
                        engine.stack_id,
                        SERVICE,
                        "metric",
                        None,
                        {
                            "metric_name": "stranded_count",
                            "value": stranded_count,
                        },
                    )

                for action in actions:
                    if action in action_tasks:
                        continue
                    task = asyncio.create_task(_perform_action(http, action))
                    action_tasks[action] = task
                    task.add_done_callback(
                        lambda _, item=action: action_tasks.pop(item, None)
                    )

                next_tick_at += TICK_SECONDS
                now = loop.time()
                while next_tick_at <= now:
                    next_tick_at += TICK_SECONDS
                await asyncio.sleep(next_tick_at - now)
        finally:
            if state_task is not None:
                state_task.cancel()
                with suppress(asyncio.CancelledError):
                    await state_task
            for task in action_tasks.values():
                task.cancel()
            if action_tasks:
                await asyncio.gather(*action_tasks.values(), return_exceptions=True)


async def _perform_action(
    http: httpx.AsyncClient,
    action: TripAction,
) -> None:
    try:
        headers = {"X-Trace-Id": action.trace_id}
        trips_url = os.environ["TRIPS_URL"].rstrip("/")
        if action.kind == "pickup":
            response = await http.patch(
                f"{trips_url}/trips/{action.trip_id}/status",
                json={"status": "enroute"},
                headers=headers,
            )
        else:
            response = await http.post(
                f"{trips_url}/trips/{action.trip_id}/complete",
                headers=headers,
            )
        response.raise_for_status()
    except Exception:
        LOGGER.exception("World trip action failed: %s %s", action.kind, action.trip_id)


def _move_manhattan(
    x: int,
    y: int,
    target_x: int,
    target_y: int,
    distance: int,
) -> tuple[int, int]:
    x_delta = target_x - x
    x_step = min(abs(x_delta), distance)
    x += x_step if x_delta >= 0 else -x_step
    remaining = distance - x_step
    y_delta = target_y - y
    y_step = min(abs(y_delta), remaining)
    y += y_step if y_delta >= 0 else -y_step
    return x, y


def _parse_timestamp(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _trim_payload(payload: dict[str, Any]) -> None:
    riders = payload["riders"]
    while (
        len(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
        >= MAX_TICK_BYTES
        and riders
    ):
        riders.pop()
