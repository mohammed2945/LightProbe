"""Exercise all six chaos faults and enforce Gate 3."""

from __future__ import annotations

import argparse
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import uuid4

import httpx
from supabase import create_client

from ops.fault_harness import FaultHarness, utc_now
from ops.seed import STACK_IDS, load_env


FAULTS = (
    "db_kill",
    "bad_deploy",
    "mem_leak",
    "surge_poison",
    "fare_corrupt",
    "double_dispatch",
)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def test_db_kill(harness: FaultHarness) -> None:
    harness.reset_stack()
    fault_id, since = harness.activate_fault("db_kill")
    try:
        matching = harness.http.post(
            f"{harness.matching_url}/assign",
            json={"rider_id": "db-kill-proof", "x": 16, "y": 16},
            headers={"X-Trace-Id": str(uuid4())},
        )
        trips = harness.http.get(
            f"{harness.trips_url}/trips/missing",
            headers={"X-Trace-Id": str(uuid4())},
        )
        require(matching.status_code == 500, "db_kill did not fail matching")
        require(trips.status_code == 500, "db_kill did not fail trips")
        for service in ("matching", "trips"):
            harness.wait_for_event(
                since,
                lambda event, expected=service: (
                    event["kind"] == "error" and event["service"] == expected
                ),
            )
        harness.print_signal_events(since)
    finally:
        harness.clear_fault(fault_id)

    harness.reset_stack()
    matching = harness.http.post(
        f"{harness.matching_url}/assign",
        json={"rider_id": "db-recovery", "x": 16, "y": 16},
    )
    require(matching.status_code == 200, "matching did not recover from db_kill")
    trips = harness.http.get(f"{harness.trips_url}/trips/missing")
    require(trips.status_code == 404, "trips DB access did not recover")
    print("PASS db_kill")


def test_bad_deploy(harness: FaultHarness) -> None:
    harness.reset_stack()
    fault_id, since = harness.activate_fault("bad_deploy")
    try:
        response, _ = harness.request_ride()
        require(response.status_code == 500, "bad_deploy did not fail gateway")
        harness.wait_for_event(
            since,
            lambda event: event["kind"] == "error" and event["service"] == "gateway",
        )
        harness.print_signal_events(since)
    finally:
        harness.clear_fault(fault_id)

    harness.reset_stack()
    response, _ = harness.request_ride()
    require(response.status_code == 200, "gateway did not recover from bad_deploy")
    print("PASS bad_deploy")


def _location_request(url: str) -> tuple[int, float, int]:
    started = time.perf_counter()
    with httpx.Client(timeout=5.0) as client:
        response = client.get(f"{url}/healthz")
    elapsed = time.perf_counter() - started
    allocated = int(response.headers.get("X-RideRush-Mem-MB", "0"))
    return response.status_code, elapsed, allocated


def test_mem_leak(harness: FaultHarness) -> None:
    harness.reset_stack()
    fault_id, since = harness.activate_fault("mem_leak")
    try:
        with ThreadPoolExecutor(max_workers=50) as executor:
            ramp = list(
                executor.map(
                    lambda _: _location_request(harness.location_url),
                    range(150),
                )
            )
        require(all(status == 200 for status, _, _ in ramp), "location died in ramp")
        require(max(mb for _, _, mb in ramp) == 150, "mem_leak did not reach 150MB")

        plateau = [_location_request(harness.location_url) for _ in range(5)]
        require(
            all(status == 200 for status, _, _ in plateau),
            "location died at mem_leak cap",
        )
        require(
            all(mb == 150 for _, _, mb in plateau),
            "mem_leak exceeded or fell below the 150MB cap",
        )
        require(
            all(0.75 <= elapsed <= 1.5 for _, elapsed, _ in plateau),
            f"mem_leak plateau was not ~900ms: {plateau}",
        )

        with ThreadPoolExecutor(max_workers=25) as executor:
            beyond_cap = list(
                executor.map(
                    lambda _: _location_request(harness.location_url),
                    range(25),
                )
            )
        require(
            all(status == 200 and mb == 150 for status, _, mb in beyond_cap),
            "mem_leak grew beyond cap or location died",
        )
        location_errors = harness.events_since(
            since,
            kinds=["error"],
            services=["location"],
        )
        require(not location_errors, f"location emitted errors: {location_errors}")
        print(
            "mem_leak plateau:",
            [round(elapsed * 1000, 1) for _, elapsed, _ in plateau],
            "ms at 150MB",
        )
        harness.print_signal_events(since)
    finally:
        harness.clear_fault(fault_id)

    status, elapsed, allocated = _location_request(harness.location_url)
    require(status == 200, "location did not survive mem_leak")
    require(allocated == 0, "mem_leak behavior remained active after clear")
    require(elapsed < 0.4, f"location latency did not recover: {elapsed:.3f}s")
    print("PASS mem_leak")


def test_surge_poison(harness: FaultHarness) -> None:
    harness.reset_stack()
    fault_id, since = harness.activate_fault("surge_poison")
    try:
        ride_response, trace_id = harness.request_ride()
        require(ride_response.status_code == 200, "surge ride request failed early")
        ride = ride_response.json()
        require(float(ride["quote"]) > 500, "surge quote was not poisoned")
        completion = harness.complete_trip(str(ride["trip_id"]), trace_id)
        require(completion.status_code == 500, "surge payment did not fail")
        harness.wait_for_event(
            since,
            lambda event: (
                event["kind"] == "error" and event["service"] == "payments"
            ),
        )
        pricing_errors = harness.events_since(
            since,
            kinds=["error"],
            services=["pricing"],
        )
        require(not pricing_errors, "surge_poison caused pricing errors")
        harness.print_signal_events(since)
    finally:
        harness.clear_fault(fault_id)

    harness.reset_stack()
    ride_response, trace_id = harness.request_ride()
    require(ride_response.status_code == 200, "surge recovery ride failed")
    ride = ride_response.json()
    require(float(ride["quote"]) == 37.8, "surge did not recover to 1.0")
    completion = harness.complete_trip(str(ride["trip_id"]), trace_id)
    require(completion.status_code == 200, "surge recovery capture failed")
    print("PASS surge_poison")


def test_fare_corrupt(harness: FaultHarness) -> None:
    harness.reset_stack()
    activated_at = time.monotonic()
    fault_id, since = harness.activate_fault("fare_corrupt")
    trip_id = ""
    trace_id = ""
    try:
        harness.wait_until(
            "fare_corrupt rate refresh",
            lambda: harness.pricing_rate() == "2,45",
            timeout=30.0,
            interval=1.0,
        )
        quote = harness.http.get(
            f"{harness.pricing_url}/quote",
            params={"x": 16, "y": 16, "dest_x": 22, "dest_y": 24},
            headers={"X-Trace-Id": str(uuid4())},
        )
        require(quote.status_code == 200, "fare_corrupt broke pricing quote")

        ride_response, trace_id = harness.request_ride()
        require(ride_response.status_code == 200, "fare_corrupt broke ride creation")
        trip_id = str(ride_response.json()["trip_id"])
        completion = harness.complete_trip(trip_id, trace_id)
        require(completion.status_code == 500, "fare_corrupt did not fail payments")
        harness.wait_for_event(
            since,
            lambda event: (
                event["kind"] == "error" and event["service"] == "payments"
            ),
        )
        pricing_errors = harness.events_since(
            since,
            kinds=["error"],
            services=["pricing"],
        )
        require(
            len(pricing_errors) == 0,
            f"fare_corrupt produced pricing errors: {pricing_errors}",
        )
        require(
            time.monotonic() - activated_at < 120,
            "fare_corrupt payment failure exceeded two minutes",
        )
        harness.print_signal_events(since)
    finally:
        harness.clear_fault(fault_id)

    harness.wait_until(
        "numeric rate recovery",
        lambda: isinstance(harness.pricing_rate(), (int, float)),
        timeout=30.0,
        interval=1.0,
    )
    recovery = harness.complete_trip(trip_id, trace_id)
    require(recovery.status_code == 200, "fare_corrupt capture did not recover")
    print("PASS fare_corrupt (zero pricing errors, payment failed within 2m)")


def _concurrent_ride(
    gateway_url: str,
    barrier: threading.Barrier,
    rider_id: str,
) -> tuple[int, dict[str, Any]]:
    trace_id = str(uuid4())
    barrier.wait()
    with httpx.Client(timeout=15.0) as client:
        response = client.post(
            f"{gateway_url}/request_ride",
            json={
                "rider_id": rider_id,
                "x": 16,
                "y": 16,
                "dest_x": 22,
                "dest_y": 24,
            },
            headers={"X-Trace-Id": trace_id},
        )
    body = response.json() if response.headers.get("content-type", "").startswith(
        "application/json"
    ) else {}
    return response.status_code, body


def test_double_dispatch(harness: FaultHarness, attempts: int) -> None:
    harness.reset_stack()
    fault_id, activated_since = harness.activate_fault("double_dispatch")
    passed = 0
    try:
        for attempt in range(1, attempts + 1):
            harness.reset_stack()
            harness.set_one_idle_driver("d1")
            since = utc_now()
            barrier = threading.Barrier(3)
            with ThreadPoolExecutor(max_workers=2) as executor:
                futures = [
                    executor.submit(
                        _concurrent_ride,
                        harness.gateway_url,
                        barrier,
                        f"double-{attempt}-{index}",
                    )
                    for index in (1, 2)
                ]
                barrier.wait()
                results = [future.result() for future in futures]

            require(
                all(status == 200 for status, _ in results),
                f"double dispatch request failed: {results}",
            )
            driver_ids = [body.get("driver_id") for _, body in results]
            require(
                driver_ids == ["d1", "d1"],
                f"requests did not share d1: {driver_ids}",
            )
            active = harness.active_trips_for("d1")
            require(len(active) == 2, f"expected two active d1 trips, got {active}")
            breach = harness.wait_for_event(
                since,
                lambda event: (
                    event["kind"] == "invariant_breach"
                    and event["payload"].get("invariant") == "driver_single_trip"
                    and "d1 active_trips=2" in event["payload"].get("detail", "")
                ),
                timeout=10.0,
            )
            print(f"double_dispatch attempt {attempt}: {breach['payload']}")
            passed += 1

        require(passed == attempts, f"double_dispatch passed only {passed}/{attempts}")
        harness.print_signal_events(activated_since)
    finally:
        harness.clear_fault(fault_id)

    harness.reset_stack()
    response, _ = harness.request_ride()
    require(response.status_code == 200, "matching did not recover from race fault")
    print(f"PASS double_dispatch {passed}/{attempts}")


def verify_auxiliary_invariants(harness: FaultHarness) -> None:
    harness.reset_stack()
    since = utc_now()
    stale_trip_id = str(uuid4())
    fare_trip_id = str(uuid4())
    payment_id = str(uuid4())
    stale_created_at = (
        datetime.now(timezone.utc) - timedelta(seconds=60)
    ).isoformat()
    try:
        harness.client.table("trips").insert(
            {
                "stack_id": harness.stack_id,
                "id": stale_trip_id,
                "rider_id": "stale-rider-proof",
                "driver_id": None,
                "pickup_x": 10,
                "pickup_y": 10,
                "dest_x": 20,
                "dest_y": 20,
                "distance": 20,
                "quote": 52.5,
                "surge": 1.0,
                "status": "requested",
                "created_at": stale_created_at,
            }
        ).execute()
        harness.client.table("trips").insert(
            {
                "stack_id": harness.stack_id,
                "id": fare_trip_id,
                "rider_id": "fare-invariant-proof",
                "driver_id": None,
                "pickup_x": 10,
                "pickup_y": 10,
                "dest_x": 20,
                "dest_y": 20,
                "distance": 20,
                "quote": 52.5,
                "surge": 1.0,
                "status": "completed",
                "fare": 600.0,
                "completed_at": utc_now(),
            }
        ).execute()
        harness.client.table("payments").insert(
            {
                "stack_id": harness.stack_id,
                "id": payment_id,
                "trip_id": fare_trip_id,
                "amount": 600.0,
                "status": "captured",
            }
        ).execute()

        for invariant in ("captured_fare_range", "rider_match_timeout"):
            harness.wait_for_event(
                since,
                lambda event, expected=invariant: (
                    event["kind"] == "invariant_breach"
                    and event["payload"].get("invariant") == expected
                ),
                timeout=10.0,
            )
        harness.print_signal_events(since)
        print("PASS auxiliary invariants 2/2")
    finally:
        (
            harness.client.table("payments")
            .delete()
            .eq("stack_id", harness.stack_id)
            .eq("id", payment_id)
            .execute()
        )
        (
            harness.client.table("trips")
            .delete()
            .eq("stack_id", harness.stack_id)
            .in_("id", [stale_trip_id, fare_trip_id])
            .execute()
        )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stack", choices=STACK_IDS, default="arena")
    parser.add_argument("--fault", choices=("all", *FAULTS), default="all")
    parser.add_argument("--double-attempts", type=int, default=5)
    parser.add_argument("--gateway-url", default="http://localhost:8000")
    parser.add_argument("--matching-url", default="http://localhost:8001")
    parser.add_argument("--pricing-url", default="http://localhost:8002")
    parser.add_argument("--location-url", default="http://localhost:8003")
    parser.add_argument("--trips-url", default="http://localhost:8004")
    parser.add_argument("--payments-url", default="http://localhost:8005")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    load_env()
    os.environ["STACK_ID"] = args.stack
    client = create_client(
        os.environ["SUPABASE_URL"],
        os.environ["SUPABASE_SERVICE_KEY"],
    )
    harness = FaultHarness(
        client,
        args.stack,
        gateway_url=args.gateway_url,
        matching_url=args.matching_url,
        pricing_url=args.pricing_url,
        location_url=args.location_url,
        trips_url=args.trips_url,
        payments_url=args.payments_url,
    )
    tests = {
        "db_kill": test_db_kill,
        "bad_deploy": test_bad_deploy,
        "mem_leak": test_mem_leak,
        "surge_poison": test_surge_poison,
        "fare_corrupt": test_fare_corrupt,
    }
    selected = FAULTS if args.fault == "all" else (args.fault,)

    try:
        harness.clear_all_faults()
        for fault in selected:
            print(f"\n=== {fault} ===")
            if fault == "double_dispatch":
                require(
                    args.double_attempts >= 5,
                    "Gate 3 requires at least five double_dispatch attempts",
                )
                test_double_dispatch(harness, args.double_attempts)
            else:
                tests[fault](harness)
        if args.fault == "all":
            print("\n=== auxiliary invariants ===")
            verify_auxiliary_invariants(harness)
        print("\nGATE 3 PASS")
        return 0
    finally:
        harness.clear_all_faults()
        harness.reset_stack()
        harness.close()


if __name__ == "__main__":
    raise SystemExit(main())
