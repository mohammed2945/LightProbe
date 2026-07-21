"""Stack-safe helpers for deterministic chaos fault proofs."""

from __future__ import annotations

import json
import time
from collections.abc import Callable
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

import httpx
from supabase import Client

from ops.seed import seed


FAULT_POLL_MARGIN_SECONDS = 3.0
FAULT_COOLDOWN_SECONDS = 46.0


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class FaultHarness:
    def __init__(
        self,
        client: Client,
        stack_id: str,
        *,
        gateway_url: str,
        matching_url: str,
        pricing_url: str,
        location_url: str,
        trips_url: str,
        payments_url: str,
    ) -> None:
        self.client = client
        self.stack_id = stack_id
        self.gateway_url = gateway_url.rstrip("/")
        self.matching_url = matching_url.rstrip("/")
        self.pricing_url = pricing_url.rstrip("/")
        self.location_url = location_url.rstrip("/")
        self.trips_url = trips_url.rstrip("/")
        self.payments_url = payments_url.rstrip("/")
        self.http = httpx.Client(timeout=15.0)

    def close(self) -> None:
        self.http.close()

    def reset_stack(self) -> None:
        seed(self.client, self.stack_id)

    def activate_fault(self, name: str) -> tuple[int, str]:
        self.clear_all_faults()
        self._wait_for_cooldown()
        response = (
            self.client.table("active_faults")
            .insert({"stack_id": self.stack_id, "fault": name})
            .execute()
        )
        row = response.data[0]
        print(f"activated {name} id={row['id']}")
        time.sleep(FAULT_POLL_MARGIN_SECONDS)
        return int(row["id"]), str(row["ts"])

    def clear_fault(self, fault_id: int) -> None:
        (
            self.client.table("active_faults")
            .update({"cleared_at": utc_now()})
            .eq("stack_id", self.stack_id)
            .eq("id", fault_id)
            .execute()
        )
        time.sleep(FAULT_POLL_MARGIN_SECONDS)

    def clear_all_faults(self) -> None:
        rows = (
            self.client.table("active_faults")
            .select("id")
            .eq("stack_id", self.stack_id)
            .is_("cleared_at", "null")
            .execute()
            .data
        )
        for row in rows:
            (
                self.client.table("active_faults")
                .update({"cleared_at": utc_now()})
                .eq("stack_id", self.stack_id)
                .eq("id", row["id"])
                .execute()
            )
        if rows:
            time.sleep(FAULT_POLL_MARGIN_SECONDS)

    def events_since(
        self,
        since: str,
        *,
        kinds: list[str] | None = None,
        services: list[str] | None = None,
        trace_id: str | None = None,
    ) -> list[dict[str, Any]]:
        query = (
            self.client.table("events")
            .select("id,ts,service,kind,trace_id,payload")
            .eq("stack_id", self.stack_id)
            .gte("ts", since)
        )
        if kinds:
            query = query.in_("kind", kinds)
        if services:
            query = query.in_("service", services)
        if trace_id:
            query = query.eq("trace_id", trace_id)
        return list(query.order("ts").execute().data)

    def print_signal_events(self, since: str) -> None:
        rows = self.events_since(
            since,
            kinds=["error", "invariant_breach"],
        )
        if not rows:
            print("signals: none")
            return
        print("signals:")
        for row in rows:
            print(json.dumps(row, sort_keys=True))

    def wait_for_event(
        self,
        since: str,
        predicate: Callable[[dict[str, Any]], bool],
        *,
        timeout: float = 12.0,
    ) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            for event in self.events_since(
                since,
                kinds=["error", "invariant_breach"],
            ):
                if predicate(event):
                    return event
            time.sleep(0.5)
        raise AssertionError("Timed out waiting for expected event")

    def wait_until(
        self,
        description: str,
        predicate: Callable[[], Any],
        *,
        timeout: float,
        interval: float = 0.5,
    ) -> Any:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            value = predicate()
            if value:
                return value
            time.sleep(interval)
        raise AssertionError(f"Timed out waiting for {description}")

    def set_one_idle_driver(self, driver_id: str = "d1") -> None:
        (
            self.client.table("drivers")
            .update({"status": "ontrip"})
            .eq("stack_id", self.stack_id)
            .execute()
        )
        (
            self.client.table("drivers")
            .update({"status": "idle"})
            .eq("stack_id", self.stack_id)
            .eq("id", driver_id)
            .execute()
        )

    def pricing_rate(self) -> object:
        rows = (
            self.client.table("pricing_config")
            .select("per_mile_rate")
            .eq("stack_id", self.stack_id)
            .limit(1)
            .execute()
            .data
        )
        return rows[0]["per_mile_rate"] if rows else None

    def active_trips_for(self, driver_id: str) -> list[dict[str, Any]]:
        return list(
            self.client.table("trips")
            .select("id,driver_id,status")
            .eq("stack_id", self.stack_id)
            .eq("driver_id", driver_id)
            .in_("status", ["matched", "enroute"])
            .execute()
            .data
        )

    def request_ride(
        self,
        *,
        trace_id: str | None = None,
        rider_id: str | None = None,
    ) -> tuple[httpx.Response, str]:
        trace = trace_id or str(uuid4())
        response = self.http.post(
            f"{self.gateway_url}/request_ride",
            json={
                "rider_id": rider_id or f"fault-proof-{uuid4().hex[:8]}",
                "x": 16,
                "y": 16,
                "dest_x": 22,
                "dest_y": 24,
            },
            headers={"X-Trace-Id": trace},
        )
        return response, trace

    def complete_trip(self, trip_id: str, trace_id: str) -> httpx.Response:
        return self.http.post(
            f"{self.trips_url}/trips/{trip_id}/complete",
            headers={"X-Trace-Id": trace_id},
        )

    def _wait_for_cooldown(self) -> None:
        rows = (
            self.client.table("active_faults")
            .select("ts")
            .eq("stack_id", self.stack_id)
            .order("ts", desc=True)
            .limit(1)
            .execute()
            .data
        )
        if not rows:
            return
        inserted_at = datetime.fromisoformat(str(rows[0]["ts"]).replace("Z", "+00:00"))
        age = (datetime.now(timezone.utc) - inserted_at).total_seconds()
        remaining = FAULT_COOLDOWN_SECONDS - age
        if remaining > 0:
            print(f"fault cooldown: waiting {remaining:.1f}s")
            time.sleep(remaining)
