"""Prove LiveProbe diagnoses, mitigates, and verifies all six faults twice."""

from __future__ import annotations

import argparse
import json
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any, Callable
from uuid import uuid4

import httpx
from supabase import Client, create_client

from ops.fault_harness import FAULT_COOLDOWN_SECONDS, utc_now
from ops.seed import STACK_IDS, load_env, seed


FAULTS = (
    "db_kill",
    "bad_deploy",
    "mem_leak",
    "surge_poison",
    "fare_corrupt",
    "double_dispatch",
)


class AgentProof:
    def __init__(self, args: argparse.Namespace, client: Client) -> None:
        self.args = args
        self.client = client
        self.stack_id = args.stack
        self.http = httpx.Client(timeout=15.0)

    def close(self) -> None:
        self.http.close()

    def run_fault(self, fault: str, pass_number: int) -> float:
        self._reset()
        self._establish_latency_baseline()
        fault_id, activated_at = self._activate(fault)
        print(f"\n=== pass {pass_number} / {fault} / id={fault_id} ===")
        try:
            self._trigger(fault)
            events = self._wait_for_recovery(fault, activated_at)
            recovery = next(
                event
                for event in events
                if str(event["payload"].get("message", "")).startswith(
                    f"Recovery verified: {fault};"
                )
            )
            mttr = (
                _parse_ts(str(recovery["ts"])) - _parse_ts(activated_at)
            ).total_seconds()
            for event in events:
                print(
                    f"{event['ts']} "
                    f"{event['payload'].get('message', '')}"
                )
            print(f"PASS {fault} mttr={mttr:.2f}s")
            return mttr
        finally:
            self._clear_if_active(fault_id)
            self._reset()

    def _trigger(self, fault: str) -> None:
        triggers: dict[str, Callable[[], None]] = {
            "db_kill": self._trigger_db_kill,
            "bad_deploy": self._trigger_bad_deploy,
            "mem_leak": self._trigger_mem_leak,
            "surge_poison": self._trigger_surge_poison,
            "fare_corrupt": self._trigger_fare_corrupt,
            "double_dispatch": self._trigger_double_dispatch,
        }
        triggers[fault]()

    def _trigger_db_kill(self) -> None:
        for index in range(7):
            trace = f"agent-proof-db-{index}-{uuid4()}"
            with httpx.Client(timeout=5.0) as client:
                try:
                    client.post(
                        f"{self.args.matching_url}/assign",
                        json={"rider_id": trace, "x": 16, "y": 16},
                        headers={"X-Trace-Id": trace},
                    )
                except httpx.HTTPError:
                    pass
                try:
                    client.get(
                        f"{self.args.trips_url}/trips/missing-{index}",
                        headers={"X-Trace-Id": trace},
                    )
                except httpx.HTTPError:
                    pass

    def _trigger_bad_deploy(self) -> None:
        for index in range(7):
            try:
                with httpx.Client(timeout=5.0) as client:
                    client.post(
                        f"{self.args.gateway_url}/request_ride",
                        json={
                            "rider_id": f"agent-proof-bad-{index}",
                            "x": 16,
                            "y": 16,
                            "dest_x": 22,
                            "dest_y": 24,
                        },
                        headers={"X-Trace-Id": str(uuid4())},
                    )
            except httpx.HTTPError:
                pass

    def _trigger_mem_leak(self) -> None:
        def hit(_: int) -> int:
            with httpx.Client(timeout=5.0) as client:
                return client.get(f"{self.args.location_url}/healthz").status_code

        with ThreadPoolExecutor(max_workers=20) as executor:
            statuses = list(executor.map(hit, range(60)))
        if any(status != 200 for status in statuses):
            raise AssertionError(f"location failed during memory ramp: {statuses}")

    def _trigger_surge_poison(self) -> None:
        self._drive_payment_failures("surge")

    def _trigger_fare_corrupt(self) -> None:
        deadline = time.monotonic() + 35
        while time.monotonic() < deadline:
            rows = (
                self.client.table("pricing_config")
                .select("per_mile_rate")
                .eq("stack_id", self.stack_id)
                .limit(1)
                .execute()
                .data
            )
            if rows and isinstance(rows[0]["per_mile_rate"], str):
                break
            time.sleep(1)
        else:
            raise AssertionError("fare_corrupt never wrote a string rate")
        self._drive_payment_failures("fare")

    def _drive_payment_failures(self, prefix: str) -> None:
        for index in range(6):
            response, trace_id = self._request_ride(
                f"agent-proof-{prefix}-{index}"
            )
            if response.status_code != 200:
                raise AssertionError(
                    f"{prefix} ride request failed early: {response.text}"
                )
            trip_id = str(response.json()["trip_id"])
            try:
                with httpx.Client(timeout=10.0) as client:
                    completion = client.post(
                        f"{self.args.trips_url}/trips/{trip_id}/complete",
                        headers={"X-Trace-Id": trace_id},
                    )
                if completion.status_code < 400:
                    raise AssertionError(
                        f"{prefix} payment unexpectedly succeeded: {completion.text}"
                    )
            except httpx.HTTPError:
                pass

    def _trigger_double_dispatch(self) -> None:
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
            .in_("id", ["d1", "d2", "d3"])
            .execute()
        )
        barrier = threading.Barrier(3)

        def request(index: int) -> tuple[int, dict[str, Any]]:
            barrier.wait()
            response, _ = self._request_ride(f"agent-proof-double-{index}")
            return response.status_code, response.json()

        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = [executor.submit(request, index) for index in (1, 2)]
            barrier.wait()
            results = [future.result() for future in futures]
        if not all(status == 200 for status, _ in results):
            raise AssertionError(f"double dispatch requests failed: {results}")
        drivers = [body.get("driver_id") for _, body in results]
        if drivers != ["d1", "d1"]:
            raise AssertionError(f"race did not duplicate d1: {drivers}")

    def _wait_for_recovery(
        self,
        fault: str,
        activated_at: str,
    ) -> list[dict[str, Any]]:
        deadline = time.monotonic() + self.args.timeout
        while time.monotonic() < deadline:
            events = self._agent_actions(activated_at)
            messages = [
                str(event["payload"].get("message", "")) for event in events
            ]
            wrong = [
                message
                for message in messages
                if message.startswith("Diagnosis confirmed:")
                and not message.startswith(f"Diagnosis confirmed: {fault};")
            ]
            if wrong:
                raise AssertionError(
                    f"LiveProbe committed the wrong diagnosis for {fault}: {wrong}"
                )
            if any(
                marker in message
                for message in messages
                for marker in (
                    "Evidence inconclusive",
                    "Mitigation failed",
                    "Mitigation did not restore health",
                )
            ):
                raise AssertionError(
                    f"LiveProbe escalated {fault}: {json.dumps(messages)}"
                )
            confirmed = any(
                message.startswith(f"Diagnosis confirmed: {fault};")
                for message in messages
            )
            mitigated = any(
                message.startswith("Mitigation:") and fault in message
                for message in messages
            )
            verified = any(
                message.startswith(f"Recovery verified: {fault};")
                for message in messages
            )
            if confirmed and mitigated and verified:
                return events
            time.sleep(1)
        raise AssertionError(
            f"Timed out waiting for LiveProbe recovery of {fault}: "
            f"{json.dumps(self._agent_actions(activated_at), default=str)}"
        )

    def _agent_actions(self, since: str) -> list[dict[str, Any]]:
        return list(
            self.client.table("events")
            .select("ts,payload")
            .eq("stack_id", self.stack_id)
            .eq("service", "agent")
            .eq("kind", "agent_action")
            .gte("ts", since)
            .order("ts")
            .execute()
            .data
        )

    def _request_ride(self, rider_id: str) -> tuple[httpx.Response, str]:
        trace_id = str(uuid4())
        request = {
            "rider_id": rider_id,
            "x": 16,
            "y": 16,
            "dest_x": 22,
            "dest_y": 24,
        }
        try:
            response = self.http.post(
                f"{self.args.gateway_url}/request_ride",
                json=request,
                headers={"X-Trace-Id": trace_id},
            )
        except httpx.HTTPError:
            with httpx.Client(timeout=15.0) as client:
                response = client.post(
                    f"{self.args.gateway_url}/request_ride",
                    json=request,
                    headers={"X-Trace-Id": trace_id},
                )
        return response, trace_id

    def _establish_latency_baseline(self) -> None:
        for _ in range(12):
            response = self.http.get(f"{self.args.location_url}/healthz")
            response.raise_for_status()
        time.sleep(2)

    def _activate(self, fault: str) -> tuple[int, str]:
        self._wait_for_cooldown()
        response = (
            self.client.table("active_faults")
            .insert({"stack_id": self.stack_id, "fault": fault})
            .execute()
        )
        row = response.data[0]
        time.sleep(3)
        return int(row["id"]), str(row["ts"])

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
        age = (
            datetime.now(timezone.utc)
            - _parse_ts(str(rows[0]["ts"]))
        ).total_seconds()
        remaining = FAULT_COOLDOWN_SECONDS - age
        if remaining > 0:
            print(f"fault cooldown: waiting {remaining:.1f}s")
            time.sleep(remaining)

    def _clear_if_active(self, fault_id: int) -> None:
        (
            self.client.table("active_faults")
            .update({"cleared_at": utc_now()})
            .eq("stack_id", self.stack_id)
            .eq("id", fault_id)
            .is_("cleared_at", "null")
            .execute()
        )
        time.sleep(3)

    def _reset(self) -> None:
        seed(self.client, self.stack_id)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stack", choices=STACK_IDS, default="arena")
    parser.add_argument("--passes", type=int, default=2)
    parser.add_argument("--timeout", type=float, default=90.0)
    parser.add_argument("--gateway-url", default="http://localhost:8000")
    parser.add_argument("--matching-url", default="http://localhost:8001")
    parser.add_argument("--pricing-url", default="http://localhost:8002")
    parser.add_argument("--location-url", default="http://localhost:8003")
    parser.add_argument("--trips-url", default="http://localhost:8004")
    parser.add_argument("--payments-url", default="http://localhost:8005")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.passes < 2:
        raise SystemExit("Gate requires --passes >= 2")
    load_env()
    os.environ["STACK_ID"] = args.stack
    client = create_client(
        os.environ["SUPABASE_URL"],
        os.environ["SUPABASE_SERVICE_KEY"],
    )
    proof = AgentProof(args, client)
    results: list[dict[str, Any]] = []
    try:
        for pass_number in range(1, args.passes + 1):
            for fault in FAULTS:
                mttr = proof.run_fault(fault, pass_number)
                results.append(
                    {"pass": pass_number, "fault": fault, "mttr_seconds": mttr}
                )
    finally:
        proof.close()
        seed(client, args.stack)

    print("\nLIVEPROBE PROOF PASS")
    print(json.dumps(results, indent=2, sort_keys=True))
    print(f"passed={len(results)}/{len(FAULTS) * args.passes}")
    return 0


def _parse_ts(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


if __name__ == "__main__":
    raise SystemExit(main())
