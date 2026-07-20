"""Run one complete ride and print its cross-service event trail."""

from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path
from uuid import uuid4

import httpx
from supabase import Client, create_client


ROOT = Path(__file__).resolve().parents[1]


def load_env() -> None:
    env_path = ROOT / ".env"
    if not env_path.exists():
        return
    for raw_line in env_path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip())


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gateway-url", default="http://localhost:8000")
    parser.add_argument("--trips-url", default="http://localhost:8004")
    return parser.parse_args()


def event_trail(client: Client, stack_id: str, trace_id: str) -> list[dict]:
    response = (
        client.table("events")
        .select("id,ts,service,kind,trace_id,payload")
        .eq("stack_id", stack_id)
        .eq("trace_id", trace_id)
        .order("ts")
        .execute()
    )
    return list(response.data)


def main() -> int:
    args = parse_args()
    load_env()
    stack_id = os.environ["STACK_ID"]
    trace_id = str(uuid4())
    rider_id = f"proof-{uuid4().hex[:8]}"
    headers = {"X-Trace-Id": trace_id}

    with httpx.Client(timeout=10.0) as http:
        ride_response = http.post(
            f"{args.gateway_url.rstrip('/')}/request_ride",
            json={
                "rider_id": rider_id,
                "x": 16,
                "y": 16,
                "dest_x": 22,
                "dest_y": 24,
            },
            headers=headers,
        )
        ride_response.raise_for_status()
        ride = ride_response.json()
        print("ride:", json.dumps(ride, sort_keys=True))

        complete_response = http.post(
            f"{args.trips_url.rstrip('/')}/trips/{ride['trip_id']}/complete",
            headers=headers,
        )
        complete_response.raise_for_status()
        print("completion:", json.dumps(complete_response.json(), sort_keys=True))

        final_response = http.get(
            f"{args.gateway_url.rstrip('/')}/trip/{ride['trip_id']}",
            headers=headers,
        )
        final_response.raise_for_status()
        print("final_trip:", json.dumps(final_response.json(), sort_keys=True))

    supabase = create_client(
        os.environ["SUPABASE_URL"],
        os.environ["SUPABASE_SERVICE_KEY"],
    )
    events: list[dict] = []
    for _ in range(20):
        events = event_trail(supabase, stack_id, trace_id)
        if len(events) >= 8:
            break
        time.sleep(0.25)

    print(f"trace_id: {trace_id}")
    print("event_trail:")
    for event in events:
        print(json.dumps(event, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
