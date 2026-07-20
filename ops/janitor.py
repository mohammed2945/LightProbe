"""Return one RideRush stack to its deterministic clean state."""

from __future__ import annotations

import argparse
import os
import time
from datetime import datetime, timezone

import httpx
from supabase import Client, create_client

from common.telemetry import emit
from ops.seed import STACK_IDS, load_env, seed


def _best_effort_post(url: str) -> dict[str, object] | None:
    try:
        response = httpx.post(url, timeout=5.0)
        response.raise_for_status()
        payload = response.json()
        return payload if isinstance(payload, dict) else {"ok": True}
    except Exception as exc:
        return {"error": str(exc)}


def reset_runtime_state() -> dict[str, object]:
    """Clear process-local demo state that survives DB resets."""
    results: dict[str, object] = {}
    location_url = os.environ.get("LOCATION_URL", "").rstrip("/")
    liveprobe_url = os.environ.get("LIVEPROBE_URL", "").rstrip("/")
    if location_url:
        results["location_reset"] = _best_effort_post(f"{location_url}/reset_leak")
    if liveprobe_url:
        results["liveprobe_reset"] = _best_effort_post(f"{liveprobe_url}/reset")
    return results


def reset_stack(client: Client, stack_id: str) -> dict[str, object]:
    """Clear faults, remove orphan rides, and restore seeded state."""
    active_faults = list(
        client.table("active_faults")
        .select("id,fault")
        .eq("stack_id", stack_id)
        .is_("cleared_at", "null")
        .execute()
        .data
    )

    cleared_at = datetime.now(timezone.utc).isoformat()
    for row in active_faults:
        (
            client.table("active_faults")
            .update({"cleared_at": cleared_at})
            .eq("stack_id", stack_id)
            .eq("id", row["id"])
            .execute()
        )

    seed(client, stack_id)
    runtime = reset_runtime_state()

    cleared_names = [str(row["fault"]) for row in active_faults]
    for fault in cleared_names or ["all"]:
        emit(
            stack_id,
            "agent",
            "fault_cleared",
            None,
            {"fault": fault, "source": "janitor"},
        )
    time.sleep(1.1)
    return {
        "stack_id": stack_id,
        "faults_cleared": cleared_names,
        "orphan_trips_cancelled": "deleted_via_seed",
        "drivers_reset": 12,
        "per_mile_rate": 2.45,
        "surge": 1.0,
        "base_fare": 3.50,
        **runtime,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stack_id", choices=STACK_IDS)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    load_env()
    os.environ["STACK_ID"] = args.stack_id
    client = create_client(
        os.environ["SUPABASE_URL"],
        os.environ["SUPABASE_SERVICE_KEY"],
    )
    result = reset_stack(client, args.stack_id)
    print(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
