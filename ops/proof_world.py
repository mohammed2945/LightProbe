"""Observe an autonomous city for 60 seconds and enforce Gate 4."""

from __future__ import annotations

import argparse
import json
import os
import time
from datetime import datetime, timezone
from typing import Any

from supabase import Client, create_client

from ops.seed import STACK_IDS, load_env


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def event_rows(
    client: Client,
    stack_id: str,
    *,
    kind: str,
    since: str,
    until: str,
    service: str | None = None,
) -> list[dict[str, Any]]:
    query = (
        client.table("events")
        .select("id,ts,service,kind,trace_id,payload")
        .eq("stack_id", stack_id)
        .eq("kind", kind)
        .gte("ts", since)
        .lte("ts", until)
    )
    if service is not None:
        query = query.eq("service", service)
    return list(query.order("ts").execute().data)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stack", choices=STACK_IDS, default="arena")
    parser.add_argument("--duration", type=int, default=60)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    load_env()
    os.environ["STACK_ID"] = args.stack
    client = create_client(
        os.environ["SUPABASE_URL"],
        os.environ["SUPABASE_SERVICE_KEY"],
    )

    started_at = utc_now()
    print(f"watching {args.stack} for {args.duration}s from {started_at}")
    for elapsed in range(0, args.duration, 10):
        sleep_for = min(10, args.duration - elapsed)
        time.sleep(sleep_for)
        print(f"  observed {elapsed + sleep_for}s")
    ended_at = utc_now()
    time.sleep(3)

    ticks = event_rows(
        client,
        args.stack,
        kind="world_tick",
        service="world",
        since=started_at,
        until=ended_at,
    )
    metrics = event_rows(
        client,
        args.stack,
        kind="metric",
        service="world",
        since=started_at,
        until=ended_at,
    )
    gateway_requests = event_rows(
        client,
        args.stack,
        kind="request",
        service="gateway",
        since=started_at,
        until=ended_at,
    )
    completed = list(
        client.table("trips")
        .select("id,rider_id,driver_id,fare,completed_at")
        .eq("stack_id", args.stack)
        .eq("status", "completed")
        .gte("completed_at", started_at)
        .lte("completed_at", ended_at)
        .execute()
        .data
    )

    required_ticks = max(1, args.duration - 5)
    tick_numbers = [int(row["payload"]["tick"]) for row in ticks]
    payload_sizes = [
        len(
            json.dumps(
                row["payload"],
                separators=(",", ":"),
                ensure_ascii=False,
            ).encode("utf-8")
        )
        for row in ticks
    ]
    ride_requests = [
        row
        for row in gateway_requests
        if row["payload"].get("route") == "/request_ride"
    ]
    stranded_metrics = [
        row
        for row in metrics
        if row["payload"].get("metric_name") == "stranded_count"
    ]

    if len(ticks) < required_ticks:
        raise AssertionError(f"world_ticks={len(ticks)} required>={required_ticks}")
    if len(set(tick_numbers)) != len(tick_numbers):
        raise AssertionError("duplicate world tick numbers detected")
    if payload_sizes and max(payload_sizes) >= 4096:
        raise AssertionError(f"world_tick payload reached {max(payload_sizes)} bytes")
    if len(completed) < 3:
        raise AssertionError(f"completed_trips={len(completed)} required>=3")
    if len(stranded_metrics) < max(1, args.duration // 5 - 1):
        raise AssertionError("stranded_count metrics were not emitted every ~5s")
    if len(ride_requests) < max(1, args.duration // 6):
        raise AssertionError("ridersim did not sustain autonomous ride requests")

    print(
        "GATE 4 PASS:",
        f"world_ticks={len(ticks)}",
        f"completed_trips={len(completed)}",
        f"ride_requests={len(ride_requests)}",
        f"stranded_metrics={len(stranded_metrics)}",
        f"max_payload_bytes={max(payload_sizes, default=0)}",
    )
    for trip in completed:
        print("completed:", json.dumps(trip, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
