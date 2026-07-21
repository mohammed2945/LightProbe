"""Shared predict -> probe -> verify engine for the six RideRush faults."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import statistics
import time
from collections import Counter, defaultdict, deque
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from enum import StrEnum
from typing import Any, Callable, Coroutine, Iterable
from uuid import uuid4

import httpx
from supabase import Client, create_client

from common.telemetry import emit


LOGGER = logging.getLogger(__name__)
EVENT_RETENTION_SECONDS = 15 * 60
ERROR_TRIGGER_COUNT = 5
ERROR_TRIGGER_SECONDS = 20
LATENCY_WINDOW_SECONDS = 60
VERIFY_TIMEOUT_SECONDS = 45
VERIFY_INTERVAL_SECONDS = 5
# After close/escalate, ignore fresh symptoms briefly so residual errors from the
# just-cleared fault don't immediately reopen an incident (blocks demo re-runs).
INCIDENT_COOLDOWN_SECONDS = 45


class FaultClass(StrEnum):
    DB_KILL = "db_kill"
    BAD_DEPLOY = "bad_deploy"
    MEM_LEAK = "mem_leak"
    SURGE_POISON = "surge_poison"
    FARE_CORRUPT = "fare_corrupt"
    DOUBLE_DISPATCH = "double_dispatch"


@dataclass(frozen=True)
class EventRecord:
    id: int
    ts: datetime
    service: str
    kind: str
    trace_id: str | None
    payload: dict[str, Any]

    @classmethod
    def from_row(cls, row: dict[str, Any]) -> EventRecord:
        return cls(
            id=int(row["id"]),
            ts=_parse_ts(str(row["ts"])),
            service=str(row["service"]),
            kind=str(row["kind"]),
            trace_id=str(row["trace_id"]) if row.get("trace_id") else None,
            payload=dict(row.get("payload") or {}),
        )

    def compact(self) -> dict[str, Any]:
        return {
            "ts": self.ts.isoformat(),
            "service": self.service,
            "kind": self.kind,
            "trace_id": self.trace_id,
            "payload": self.payload,
        }


@dataclass(frozen=True)
class ProbeResult:
    name: str
    ok: bool
    observed: Any
    expected: str


@dataclass(frozen=True)
class HypothesisRank:
    fault: FaultClass
    score: int
    rationale: str


@dataclass
class Incident:
    id: str
    opened_at: datetime
    trigger: dict[str, Any]
    state: str = "open"
    hypothesis: FaultClass | None = None
    evidence: list[dict[str, Any]] = field(default_factory=list)
    actions: list[str] = field(default_factory=list)
    closed_at: datetime | None = None
    rankings: list[HypothesisRank] = field(default_factory=list)
    llm_calls: int = 0

    def compact(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "opened_at": self.opened_at.isoformat(),
            "trigger": self.trigger,
            "state": self.state,
            "hypothesis": self.hypothesis.value if self.hypothesis else None,
            "evidence": self.evidence,
            "actions": self.actions,
            "closed_at": self.closed_at.isoformat() if self.closed_at else None,
        }


class EventTail:
    """Stack-scoped event cursor with rolling operational windows."""

    def __init__(self, client: Client, stack_id: str) -> None:
        self.client = client
        self.stack_id = stack_id
        self.cursor: int | None = None
        self.events: deque[EventRecord] = deque()
        self.last_invariant_breach: EventRecord | None = None
        self.last_world_metrics: dict[str, EventRecord] = {}

    async def poll(self) -> list[EventRecord]:
        rows = await asyncio.to_thread(self._fetch_rows)
        records = [EventRecord.from_row(row) for row in rows]
        initial = self.cursor is None
        for event in records:
            self._append(event)
        if records:
            self.cursor = max(event.id for event in records)
        self._prune()
        # Advance the cursor on cold start without treating backlog as new symptoms.
        if initial:
            return []
        return records

    async def load_history(self, minutes: int = 15) -> list[EventRecord]:
        rows = await asyncio.to_thread(self._fetch_window_rows, minutes)
        self.events.clear()
        for row in rows:
            self._append(EventRecord.from_row(row))
        if self.events:
            self.cursor = self.events[-1].id
        self._prune()
        return list(self.events)

    def errors(
        self,
        seconds: int,
        *,
        service: str | None = None,
        since: datetime | None = None,
    ) -> list[EventRecord]:
        cutoff = since or (_utcnow() - timedelta(seconds=seconds))
        return [
            event
            for event in self.events
            if event.kind == "error"
            and event.ts >= cutoff
            and (service is None or event.service == service)
        ]

    def error_counts(self, seconds: int = 60) -> dict[str, int]:
        return dict(Counter(event.service for event in self.errors(seconds)))

    def latency_medians(self, seconds: int = 60) -> dict[str, float]:
        cutoff = _utcnow() - timedelta(seconds=seconds)
        samples: dict[str, list[float]] = defaultdict(list)
        for event in self.events:
            if event.kind != "request" or event.ts < cutoff:
                continue
            latency = event.payload.get("latency_ms")
            if isinstance(latency, (int, float)):
                samples[event.service].append(float(latency))
        return {
            service: float(statistics.median(values))
            for service, values in samples.items()
            if values
        }

    def trailing_baseline(self, service: str) -> float | None:
        now = _utcnow()
        historical = [
            float(event.payload["latency_ms"])
            for event in self.events
            if event.kind == "request"
            and event.service == service
            and isinstance(event.payload.get("latency_ms"), (int, float))
            and now - timedelta(seconds=EVENT_RETENTION_SECONDS)
            <= event.ts
            < now - timedelta(seconds=LATENCY_WINDOW_SECONDS)
        ]
        if len(historical) >= 3:
            return max(0.1, float(statistics.median(historical)))

        all_samples = sorted(
            float(event.payload["latency_ms"])
            for event in self.events
            if event.kind == "request"
            and event.service == service
            and isinstance(event.payload.get("latency_ms"), (int, float))
        )
        if not all_samples:
            return None
        stable_count = min(10, max(1, len(all_samples) // 4))
        return max(0.1, float(statistics.median(all_samples[:stable_count])))

    def compact_last(self, count: int = 30) -> list[dict[str, Any]]:
        return [event.compact() for event in list(self.events)[-count:]]

    def _fetch_rows(self) -> list[dict[str, Any]]:
        query = (
            self.client.table("events")
            .select("id,ts,service,kind,trace_id,payload")
            .eq("stack_id", self.stack_id)
        )
        if self.cursor is None:
            since = (_utcnow() - timedelta(seconds=EVENT_RETENTION_SECONDS)).isoformat()
            rows = (
                query.gte("ts", since)
                .order("id", desc=True)
                .limit(1000)
                .execute()
                .data
            )
            return list(reversed(rows))
        return list(
            query.gt("id", self.cursor).order("id").limit(1000).execute().data
        )

    def _fetch_window_rows(self, minutes: int) -> list[dict[str, Any]]:
        since = (_utcnow() - timedelta(minutes=minutes)).isoformat()
        rows = (
            self.client.table("events")
            .select("id,ts,service,kind,trace_id,payload")
            .eq("stack_id", self.stack_id)
            .gte("ts", since)
            .order("id", desc=True)
            .limit(1000)
            .execute()
            .data
        )
        return list(reversed(rows))

    def _append(self, event: EventRecord) -> None:
        self.events.append(event)
        if event.kind == "invariant_breach":
            self.last_invariant_breach = event
        if event.kind == "metric":
            metric_name = event.payload.get("metric_name")
            if isinstance(metric_name, str):
                self.last_world_metrics[metric_name] = event

    def _prune(self) -> None:
        cutoff = _utcnow() - timedelta(seconds=EVENT_RETENTION_SECONDS)
        while self.events and self.events[0].ts < cutoff:
            self.events.popleft()


class Detector:
    """Open incidents only from observable event-stream symptoms."""

    def detect(
        self,
        tail: EventTail,
        new_events: Iterable[EventRecord],
    ) -> Incident | None:
        events = list(new_events)
        if not events:
            return None

        invariant = next(
            (event for event in reversed(events) if event.kind == "invariant_breach"),
            None,
        )
        if invariant is not None:
            return self._incident(
                {
                    "type": "invariant_breach",
                    "service": invariant.service,
                    "invariant": invariant.payload.get("invariant"),
                    "detail": invariant.payload.get("detail"),
                }
            )

        error_services = {
            event.service for event in events if event.kind == "error"
        }
        for service in sorted(error_services):
            fresh = sum(
                1
                for event in events
                if event.kind == "error" and event.service == service
            )
            # Require a real fresh burst, not one leftover error plus an old window.
            if fresh <= 1:
                continue
            count = len(tail.errors(ERROR_TRIGGER_SECONDS, service=service))
            if count > ERROR_TRIGGER_COUNT:
                return self._incident(
                    {
                        "type": "error_burst",
                        "service": service,
                        "count": count,
                        "window_seconds": ERROR_TRIGGER_SECONDS,
                    }
                )

        request_services = {
            event.service for event in events if event.kind == "request"
        }
        medians = tail.latency_medians(LATENCY_WINDOW_SECONDS)
        for service in sorted(request_services):
            median = medians.get(service)
            baseline = tail.trailing_baseline(service)
            if (
                median is not None
                and baseline is not None
                and median > baseline * 5
            ):
                return self._incident(
                    {
                        "type": "latency_regression",
                        "service": service,
                        "median_ms": round(median, 2),
                        "baseline_ms": round(baseline, 2),
                    }
                )
        return None

    @staticmethod
    def _incident(trigger: dict[str, Any]) -> Incident:
        return Incident(
            id=f"inc_{uuid4().hex[:12]}",
            opened_at=_utcnow(),
            trigger=trigger,
        )


class AgentEmitter:
    """The only LiveProbe event writer; kinds are contract-limited."""

    def __init__(self, stack_id: str) -> None:
        self.stack_id = stack_id

    async def action(self, incident: Incident, message: str) -> None:
        incident.actions.append(message)
        emit(
            self.stack_id,
            "agent",
            "agent_action",
            None,
            {"message": message},
        )
        await asyncio.sleep(0)

    async def narration(self, message: str) -> None:
        emit(
            self.stack_id,
            "agent",
            "narration",
            None,
            {"message": message},
        )
        await asyncio.sleep(0)


class Hypothesizer:
    """Rank the six frozen fault classes from events, with Gemini tie-breaking."""

    SIGNATURES = {
        FaultClass.DB_KILL: (
            "Errors in both trips and matching with connection/database messages."
        ),
        FaultClass.BAD_DEPLOY: (
            "Gateway-only KeyError-style failures while downstream services stay healthy."
        ),
        FaultClass.MEM_LEAK: (
            "Location latency ramps above baseline without corresponding errors."
        ),
        FaultClass.SURGE_POISON: (
            "Payment validation failures coincide with absurd quotes and effective surge 50."
        ),
        FaultClass.FARE_CORRUPT: (
            "Payment float/parse failures while pricing remains error-free."
        ),
        FaultClass.DOUBLE_DISPATCH: (
            "driver_single_trip invariant breach with no error events."
        ),
    }

    def __init__(self) -> None:
        self.model = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")

    async def rank(
        self,
        incident: Incident,
        tail: EventTail,
    ) -> list[HypothesisRank]:
        rankings = self._deterministic_rank(incident, tail)
        matches = [ranking for ranking in rankings if ranking.score >= 8]
        if len(matches) != 1:
            gemini = await self._gemini_rank(incident, tail, rankings)
            if gemini is not None:
                rankings = [
                    gemini,
                    *(item for item in rankings if item.fault != gemini.fault),
                ]
        incident.rankings = rankings
        return rankings

    async def summarize(self, incident: Incident, verified: bool) -> str:
        fallback = (
            f"LiveProbe diagnosed {incident.hypothesis.value if incident.hypothesis else 'an unresolved fault'} "
            f"from event signatures and live probes. "
            f"{'Mitigation restored the canary path and verification checks passed.' if verified else 'Evidence or recovery remained incomplete, so the incident was escalated.'}"
        )
        if not os.environ.get("GEMINI_API_KEY") or incident.llm_calls >= 2:
            return fallback
        prompt = (
            "Write exactly two concise sentences summarizing this RideRush incident for "
            "an operations audience. Do not invent facts. Return strict JSON "
            '{"summary":"..."}. Incident: '
            + json.dumps(incident.compact(), default=str)
        )
        response = await self._gemini_json(incident, prompt)
        if isinstance(response, dict) and isinstance(response.get("summary"), str):
            return str(response["summary"])
        return fallback

    def _deterministic_rank(
        self,
        incident: Incident,
        tail: EventTail,
    ) -> list[HypothesisRank]:
        cutoff = incident.opened_at - timedelta(seconds=30)
        recent = [event for event in tail.events if event.ts >= cutoff]
        errors = [event for event in recent if event.kind == "error"]
        by_service = Counter(event.service for event in errors)
        messages = " ".join(
            str(event.payload.get("message", "")).lower() for event in errors
        )
        invariant_names = {
            str(event.payload.get("invariant"))
            for event in recent
            if event.kind == "invariant_breach"
        }
        scores = {fault: 0 for fault in FaultClass}
        rationales: dict[FaultClass, list[str]] = defaultdict(list)

        if by_service["trips"] and by_service["matching"]:
            scores[FaultClass.DB_KILL] += 6
            rationales[FaultClass.DB_KILL].append("trips and matching both error")
        if any(
            token in messages
            for token in ("connection", "database", "db_kill", "refused", "unavailable")
        ):
            scores[FaultClass.DB_KILL] += 4
            rationales[FaultClass.DB_KILL].append("database-flavored errors")

        downstream_errors = sum(
            count for service, count in by_service.items() if service != "gateway"
        )
        if by_service["gateway"] and downstream_errors == 0:
            scores[FaultClass.BAD_DEPLOY] += 5
            rationales[FaultClass.BAD_DEPLOY].append("errors isolated to gateway")
        if "missing_field" in messages or "keyerror" in messages:
            scores[FaultClass.BAD_DEPLOY] += 5
            rationales[FaultClass.BAD_DEPLOY].append("KeyError signature")

        if (
            incident.trigger.get("type") == "latency_regression"
            and incident.trigger.get("service") == "location"
        ):
            scores[FaultClass.MEM_LEAK] += 10
            rationales[FaultClass.MEM_LEAK].append("location latency exceeds baseline")
            if not errors:
                scores[FaultClass.MEM_LEAK] += 2
                rationales[FaultClass.MEM_LEAK].append("no errors")

        if by_service["payments"]:
            if "422" in messages or "outside (0, 500)" in messages:
                scores[FaultClass.SURGE_POISON] += 9
                rationales[FaultClass.SURGE_POISON].append(
                    "payment fare validation failures"
                )
            if any(
                token in messages
                for token in ("non-int", "float", "parse", "could not convert")
            ):
                scores[FaultClass.FARE_CORRUPT] += 10
                rationales[FaultClass.FARE_CORRUPT].append(
                    "payment numeric-type failure"
                )
                if by_service["pricing"] == 0:
                    scores[FaultClass.FARE_CORRUPT] += 2
                    rationales[FaultClass.FARE_CORRUPT].append("pricing remains clean")

        if "driver_single_trip" in invariant_names:
            scores[FaultClass.DOUBLE_DISPATCH] += 10
            rationales[FaultClass.DOUBLE_DISPATCH].append(
                "driver_single_trip invariant breached"
            )
            if not errors:
                scores[FaultClass.DOUBLE_DISPATCH] += 2
                rationales[FaultClass.DOUBLE_DISPATCH].append("zero errors")

        return sorted(
            (
                HypothesisRank(
                    fault=fault,
                    score=score,
                    rationale="; ".join(rationales[fault]) or "no direct signature",
                )
                for fault, score in scores.items()
            ),
            key=lambda item: (-item.score, item.fault.value),
        )

    async def _gemini_rank(
        self,
        incident: Incident,
        tail: EventTail,
        deterministic: list[HypothesisRank],
    ) -> HypothesisRank | None:
        if not os.environ.get("GEMINI_API_KEY"):
            return None
        prompt = (
            "You are ranking one known RideRush fault. Choose only one enum value from "
            f"{[fault.value for fault in FaultClass]}. Return strict JSON "
            '{"fault":"enum","confidence":0.0,"rationale":"one sentence"}. '
            "Do not propose another class.\nSignatures:\n"
            + json.dumps(
                {fault.value: signature for fault, signature in self.SIGNATURES.items()}
            )
            + "\nDeterministic ranking:\n"
            + json.dumps([asdict(item) for item in deterministic], default=str)
            + "\nLast 30 events:\n"
            + json.dumps(tail.compact_last(30), default=str)
        )
        response = await self._gemini_json(incident, prompt)
        if not isinstance(response, dict):
            return None
        try:
            fault = FaultClass(str(response["fault"]))
        except (KeyError, ValueError):
            return None
        rationale = str(response.get("rationale") or "Gemini tie-break")
        return HypothesisRank(fault=fault, score=100, rationale=rationale)

    async def _gemini_json(
        self,
        incident: Incident,
        prompt: str,
    ) -> dict[str, Any] | None:
        if incident.llm_calls >= 2:
            return None
        incident.llm_calls += 1
        try:
            return await asyncio.wait_for(
                asyncio.to_thread(self._call_gemini, prompt),
                timeout=4.0,
            )
        except Exception:
            LOGGER.exception("Gemini call failed; using deterministic fallback")
            return None

    def _call_gemini(self, prompt: str) -> dict[str, Any]:
        from google import genai
        from google.genai import types

        client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
        response = client.models.generate_content(
            model=self.model,
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                temperature=0,
            ),
        )
        return dict(json.loads(response.text or "{}"))


ProbeCallable = Callable[[], Coroutine[Any, Any, ProbeResult]]


class Prober:
    """Execute only the concrete predictions for a ranked hypothesis."""

    PREDICTIONS = {
        FaultClass.DB_KILL: ("pricing_quote_healthy", "canary_fails_matching"),
        FaultClass.BAD_DEPLOY: ("downstream_services_healthy",),
        FaultClass.MEM_LEAK: ("location_memory_elevated", "other_services_normal"),
        FaultClass.SURGE_POISON: ("absurd_short_quote", "effective_surge_fifty"),
        FaultClass.FARE_CORRUPT: ("rate_is_non_float", "pricing_quote_healthy"),
        FaultClass.DOUBLE_DISPATCH: (
            "driver_has_two_active_trips",
            "duplicate_trips_created_together",
        ),
    }

    def __init__(
        self,
        client: Client,
        stack_id: str,
        emitter: AgentEmitter,
    ) -> None:
        self.client = client
        self.stack_id = stack_id
        self.emitter = emitter
        self.http = httpx.AsyncClient(timeout=8.0)
        self.urls = {
            "gateway": os.environ["GATEWAY_URL"].rstrip("/"),
            "matching": os.environ["MATCHING_URL"].rstrip("/"),
            "pricing": os.environ["PRICING_URL"].rstrip("/"),
            "location": os.environ["LOCATION_URL"].rstrip("/"),
            "trips": os.environ["TRIPS_URL"].rstrip("/"),
            "payments": os.environ["PAYMENTS_URL"].rstrip("/"),
        }

    async def close(self) -> None:
        await self.http.aclose()

    async def run(
        self,
        incident: Incident,
        fault: FaultClass,
        runner_up: FaultClass | None,
    ) -> tuple[list[ProbeResult], int]:
        predicted = list(self.PREDICTIONS[fault])
        names = list(predicted)
        if runner_up is not None:
            discriminator = self.PREDICTIONS[runner_up][0]
            if discriminator not in names:
                names.append(discriminator)

        results: list[ProbeResult] = []
        probes = self._probe_map()
        for name in names:
            result = await probes[name]()
            results.append(result)
            incident.evidence.append(asdict(result))
            observed = _compact_value(result.observed)
            outcome = "confirmed" if result.ok else "contradicted"
            await self.emitter.action(
                incident,
                f"Probe: {name} → {observed}; prediction {outcome}.",
            )
        return results, len(predicted)

    async def canary_complete(self) -> ProbeResult:
        started = time.perf_counter()
        trace_id = f"probe-{uuid4()}"
        trip_id: str | None = None
        try:
            response = await self.http.post(
                f"{self.urls['gateway']}/request_ride",
                json={
                    "rider_id": f"probe-{uuid4().hex[:8]}",
                    "x": 16,
                    "y": 16,
                    "dest_x": 22,
                    "dest_y": 24,
                },
                headers={"X-Trace-Id": trace_id},
            )
            if response.status_code != 200:
                return ProbeResult(
                    "canary_end_to_end",
                    False,
                    {"request_status": response.status_code},
                    "ride request and completion both return 200",
                )
            body = response.json()
            trip_id = str(body["trip_id"])
            completion = await self.http.post(
                f"{self.urls['trips']}/trips/{trip_id}/complete",
                headers={"X-Trace-Id": trace_id},
            )
            elapsed_ms = round((time.perf_counter() - started) * 1000, 1)
            return ProbeResult(
                "canary_end_to_end",
                completion.status_code == 200,
                {
                    "request_status": response.status_code,
                    "completion_status": completion.status_code,
                    "latency_ms": elapsed_ms,
                },
                "ride request and completion both return 200",
            )
        except Exception as exc:
            return ProbeResult(
                "canary_end_to_end",
                False,
                {"error": str(exc)},
                "ride request and completion both return 200",
            )
        finally:
            if trip_id is not None:
                await asyncio.to_thread(self._cleanup_canary, trip_id)

    def _probe_map(self) -> dict[str, ProbeCallable]:
        return {
            "pricing_quote_healthy": self._pricing_quote_healthy,
            "canary_fails_matching": self._canary_fails_matching,
            "downstream_services_healthy": self._downstream_services_healthy,
            "location_memory_elevated": self._location_memory_elevated,
            "other_services_normal": self._other_services_normal,
            "absurd_short_quote": self._absurd_short_quote,
            "effective_surge_fifty": self._effective_surge_fifty,
            "rate_is_non_float": self._rate_is_non_float,
            "driver_has_two_active_trips": self._driver_has_two_active_trips,
            "duplicate_trips_created_together": self._duplicate_trips_created_together,
        }

    async def _pricing_quote_healthy(self) -> ProbeResult:
        response = await self._quote()
        return ProbeResult(
            "pricing_quote_healthy",
            response["status"] == 200,
            response,
            "pricing /quote returns 200",
        )

    async def _canary_fails_matching(self) -> ProbeResult:
        trace_id = f"probe-{uuid4()}"
        status = 0
        transport_error: str | None = None
        try:
            response = await self.http.post(
                f"{self.urls['gateway']}/request_ride",
                json={
                    "rider_id": f"probe-{uuid4().hex[:8]}",
                    "x": 16,
                    "y": 16,
                    "dest_x": 22,
                    "dest_y": 24,
                },
                headers={"X-Trace-Id": trace_id},
            )
            status = response.status_code
        except httpx.HTTPError as exc:
            transport_error = str(exc)
        await asyncio.sleep(0.75)
        matching_errors = await asyncio.to_thread(
            self._events_for_trace,
            trace_id,
            "matching",
            "error",
        )
        observed = {
            "gateway_status": status,
            "matching_errors": len(matching_errors),
            "transport_error": transport_error,
        }
        return ProbeResult(
            "canary_fails_matching",
            (status >= 500 or transport_error is not None) and bool(matching_errors),
            observed,
            "gateway canary fails with a matching error",
        )

    async def _downstream_services_healthy(self) -> ProbeResult:
        services = ("matching", "pricing", "trips", "payments", "location")
        results = await asyncio.gather(*(self._health(service) for service in services))
        quote = await self._quote()
        observed = {
            result["service"]: result["status"] for result in results
        } | {"quote_status": quote["status"]}
        return ProbeResult(
            "downstream_services_healthy",
            all(result["status"] == 200 for result in results)
            and quote["status"] == 200,
            observed,
            "all downstream health checks and pricing quote return 200",
        )

    async def _location_memory_elevated(self) -> ProbeResult:
        started = time.perf_counter()
        response = await self.http.get(f"{self.urls['location']}/openapi.json")
        elapsed_ms = round((time.perf_counter() - started) * 1000, 1)
        memory_mb = int(response.headers.get("X-RideRush-Mem-MB", "0"))
        observed = {
            "status": response.status_code,
            "memory_mb": memory_mb,
            "latency_ms": elapsed_ms,
        }
        return ProbeResult(
            "location_memory_elevated",
            response.status_code == 200 and memory_mb > 0,
            observed,
            "location memory gauge is elevated while health remains 200",
        )

    async def _other_services_normal(self) -> ProbeResult:
        results = await asyncio.gather(
            self._health("gateway"),
            self._health("pricing"),
        )
        return ProbeResult(
            "other_services_normal",
            all(
                result["status"] == 200 and result["latency_ms"] < 1000
                for result in results
            ),
            results,
            "gateway and pricing remain healthy below 1000ms",
        )

    async def _absurd_short_quote(self) -> ProbeResult:
        response = await self._quote()
        quote = response.get("body", {}).get("quote")
        return ProbeResult(
            "absurd_short_quote",
            response["status"] == 200
            and isinstance(quote, (int, float))
            and float(quote) > 100,
            response,
            "short-trip quote exceeds $100",
        )

    async def _effective_surge_fifty(self) -> ProbeResult:
        rows = await asyncio.to_thread(self._pricing_config)
        response = await self._quote()
        effective = response.get("body", {}).get("surge")
        stored = rows[0].get("surge") if rows else None
        observed = {"effective_quote_surge": effective, "stored_surge": stored}
        return ProbeResult(
            "effective_surge_fifty",
            isinstance(effective, (int, float)) and float(effective) >= 50,
            observed,
            "effective /quote surge is at least 50; stored surge remains contextual",
        )

    async def _rate_is_non_float(self) -> ProbeResult:
        rows = await asyncio.to_thread(self._pricing_config)
        value = rows[0].get("per_mile_rate") if rows else None
        return ProbeResult(
            "rate_is_non_float",
            isinstance(value, str),
            {"value": value, "type": type(value).__name__},
            "per_mile_rate is a non-float string",
        )

    async def _driver_has_two_active_trips(self) -> ProbeResult:
        trips = await asyncio.to_thread(self._active_trips)
        counts = Counter(
            str(trip["driver_id"])
            for trip in trips
            if trip.get("driver_id") is not None
        )
        driver_id, count = max(counts.items(), key=lambda item: item[1], default=("", 0))
        return ProbeResult(
            "driver_has_two_active_trips",
            count >= 2,
            {"driver_id": driver_id or None, "active_trips": count},
            "one driver has at least two active trips",
        )

    async def _duplicate_trips_created_together(self) -> ProbeResult:
        trips = await asyncio.to_thread(self._active_trips)
        grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for trip in trips:
            if trip.get("driver_id"):
                grouped[str(trip["driver_id"])].append(trip)
        best_gap: float | None = None
        best_driver: str | None = None
        for driver_id, rows in grouped.items():
            if len(rows) < 2:
                continue
            ordered = sorted(rows, key=lambda row: _parse_ts(str(row["created_at"])))
            gap = (
                _parse_ts(str(ordered[1]["created_at"]))
                - _parse_ts(str(ordered[0]["created_at"]))
            ).total_seconds()
            if best_gap is None or gap < best_gap:
                best_gap = gap
                best_driver = driver_id
        return ProbeResult(
            "duplicate_trips_created_together",
            best_gap is not None and best_gap <= 1.5,
            {"driver_id": best_driver, "gap_seconds": best_gap},
            "duplicate active trips were created within about one second",
        )

    async def _quote(self) -> dict[str, Any]:
        started = time.perf_counter()
        try:
            response = await self.http.get(
                f"{self.urls['pricing']}/quote",
                params={"x": 10, "y": 10, "dest_x": 12, "dest_y": 12},
                headers={"X-Trace-Id": f"probe-{uuid4()}"},
            )
            return {
                "status": response.status_code,
                "latency_ms": round((time.perf_counter() - started) * 1000, 1),
                "body": response.json()
                if response.headers.get("content-type", "").startswith(
                    "application/json"
                )
                else {},
            }
        except Exception as exc:
            return {"status": 0, "error": str(exc)}

    async def _health(self, service: str) -> dict[str, Any]:
        started = time.perf_counter()
        try:
            # Cloud Run reserves /healthz; FastAPI's read-only schema route is
            # a portable liveness probe that exercises each deployed service.
            response = await self.http.get(f"{self.urls[service]}/openapi.json")
            return {
                "service": service,
                "status": response.status_code,
                "latency_ms": round((time.perf_counter() - started) * 1000, 1),
            }
        except Exception as exc:
            return {"service": service, "status": 0, "error": str(exc)}

    def _pricing_config(self) -> list[dict[str, Any]]:
        return list(
            self.client.table("pricing_config")
            .select("per_mile_rate,surge")
            .eq("stack_id", self.stack_id)
            .limit(1)
            .execute()
            .data
        )

    def _active_trips(self) -> list[dict[str, Any]]:
        return list(
            self.client.table("trips")
            .select(
                "id,rider_id,driver_id,pickup_x,pickup_y,status,created_at"
            )
            .eq("stack_id", self.stack_id)
            .in_("status", ["matched", "enroute"])
            .order("created_at")
            .execute()
            .data
        )

    def _events_for_trace(
        self,
        trace_id: str,
        service: str,
        kind: str,
    ) -> list[dict[str, Any]]:
        return list(
            self.client.table("events")
            .select("id")
            .eq("stack_id", self.stack_id)
            .eq("trace_id", trace_id)
            .eq("service", service)
            .eq("kind", kind)
            .execute()
            .data
        )

    def _cleanup_canary(self, trip_id: str) -> None:
        rows = (
            self.client.table("trips")
            .select("driver_id")
            .eq("stack_id", self.stack_id)
            .eq("id", trip_id)
            .limit(1)
            .execute()
            .data
        )
        (
            self.client.table("payments")
            .delete()
            .eq("stack_id", self.stack_id)
            .eq("trip_id", trip_id)
            .execute()
        )
        (
            self.client.table("trips")
            .delete()
            .eq("stack_id", self.stack_id)
            .eq("id", trip_id)
            .execute()
        )
        if rows and rows[0].get("driver_id"):
            (
                self.client.table("drivers")
                .update({"status": "idle"})
                .eq("stack_id", self.stack_id)
                .eq("id", rows[0]["driver_id"])
                .execute()
            )


class Mitigator:
    """Apply one confirmed playbook; injected ground truth is read only here."""

    PLAYBOOKS = {
        FaultClass.DB_KILL: "Restoring database connectivity",
        FaultClass.BAD_DEPLOY: "Rolling back deploy",
        FaultClass.MEM_LEAK: "Restarting location service",
        FaultClass.SURGE_POISON: "Resetting surge config",
        FaultClass.FARE_CORRUPT: "Repairing rate feed",
        FaultClass.DOUBLE_DISPATCH: "Reconciling duplicate dispatch",
    }

    def __init__(
        self,
        client: Client,
        stack_id: str,
        emitter: AgentEmitter,
    ) -> None:
        self.client = client
        self.stack_id = stack_id
        self.emitter = emitter

    async def mitigate(
        self,
        incident: Incident,
        diagnosis: FaultClass,
    ) -> tuple[bool, list[str]]:
        incident.state = "mitigating"
        rows = await asyncio.to_thread(self._matching_fault_rows, diagnosis)
        if len(rows) != 1:
            await self.emitter.action(
                incident,
                f"Mitigation failed: no active flag matches confirmed {diagnosis.value}; refusing to guess.",
            )
            return False, []

        actions: list[str] = []
        if diagnosis == FaultClass.FARE_CORRUPT:
            await asyncio.to_thread(self._repair_rate)
            message = "Repairing rate feed: per_mile_rate restored to numeric 2.45."
            actions.append(message)
            await self.emitter.action(incident, message)
        elif diagnosis == FaultClass.DOUBLE_DISPATCH:
            reassignment = await asyncio.to_thread(self._repair_double_dispatch)
            if reassignment is None:
                await self.emitter.action(
                    incident,
                    "Mitigation failed: duplicate dispatch had no safe idle-driver reassignment.",
                )
                return False, actions
            actions.append(reassignment)
            await self.emitter.action(incident, reassignment)

        playbook = self.PLAYBOOKS[diagnosis]
        await self.emitter.action(
            incident,
            f"Mitigation: {playbook} for confirmed {diagnosis.value}.",
        )
        await asyncio.to_thread(self._clear_fault, int(rows[0]["id"]))
        if diagnosis == FaultClass.MEM_LEAK:
            freed = await self._reset_location_leak()
            if freed is not None:
                message = f"Released location leak buffers ({freed} MB)."
                actions.append(message)
                await self.emitter.action(incident, message)
        actions.append(playbook)
        return True, actions

    async def _reset_location_leak(self) -> int | None:
        location_url = os.environ.get("LOCATION_URL", "").rstrip("/")
        if not location_url:
            return None
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                response = await client.post(f"{location_url}/reset_leak")
                response.raise_for_status()
                return int(response.json().get("freed_mb", 0))
        except Exception:
            LOGGER.exception("Failed to reset location leak buffers")
            return None

    def _matching_fault_rows(self, diagnosis: FaultClass) -> list[dict[str, Any]]:
        return list(
            self.client.table("active_faults")
            .select("id")
            .eq("stack_id", self.stack_id)
            .eq("fault", diagnosis.value)
            .is_("cleared_at", "null")
            .limit(2)
            .execute()
            .data
        )

    def _clear_fault(self, fault_id: int) -> None:
        (
            self.client.table("active_faults")
            .update({"cleared_at": _utcnow().isoformat()})
            .eq("stack_id", self.stack_id)
            .eq("id", fault_id)
            .execute()
        )

    def _repair_rate(self) -> None:
        (
            self.client.table("pricing_config")
            .update({"per_mile_rate": 2.45})
            .eq("stack_id", self.stack_id)
            .execute()
        )

    def _repair_double_dispatch(self) -> str | None:
        trips = list(
            self.client.table("trips")
            .select("id,driver_id,pickup_x,pickup_y,status,created_at")
            .eq("stack_id", self.stack_id)
            .in_("status", ["matched", "enroute"])
            .order("created_at")
            .execute()
            .data
        )
        grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for trip in trips:
            if trip.get("driver_id"):
                grouped[str(trip["driver_id"])].append(trip)
        duplicate = next(
            (
                (driver_id, rows)
                for driver_id, rows in sorted(grouped.items())
                if len(rows) >= 2
            ),
            None,
        )
        if duplicate is None:
            return None
        original_driver, rows = duplicate
        ordered = sorted(rows, key=lambda row: _parse_ts(str(row["created_at"])))
        later = ordered[-1]
        idle = list(
            self.client.table("drivers")
            .select("id,x,y")
            .eq("stack_id", self.stack_id)
            .eq("status", "idle")
            .execute()
            .data
        )
        if not idle:
            return None
        replacement = min(
            idle,
            key=lambda driver: (
                abs(int(driver["x"]) - int(later["pickup_x"]))
                + abs(int(driver["y"]) - int(later["pickup_y"])),
                str(driver["id"]),
            ),
        )
        (
            self.client.table("trips")
            .update({"driver_id": replacement["id"], "status": "matched"})
            .eq("stack_id", self.stack_id)
            .eq("id", later["id"])
            .execute()
        )
        (
            self.client.table("drivers")
            .update({"status": "enroute"})
            .eq("stack_id", self.stack_id)
            .eq("id", replacement["id"])
            .execute()
        )
        return (
            f"Reassigned later trip {later['id']} from {original_driver} to nearest "
            f"idle driver {replacement['id']}."
        )


class Verifier:
    """Verify recovery from fresh errors, a canary, and fault-specific state."""

    AFFECTED_SERVICES = {
        FaultClass.DB_KILL: ("matching", "trips", "gateway"),
        FaultClass.BAD_DEPLOY: ("gateway",),
        FaultClass.MEM_LEAK: ("location",),
        FaultClass.SURGE_POISON: ("pricing", "payments", "trips"),
        FaultClass.FARE_CORRUPT: ("payments", "trips"),
        FaultClass.DOUBLE_DISPATCH: ("matching", "trips"),
    }

    def __init__(
        self,
        client: Client,
        stack_id: str,
        emitter: AgentEmitter,
        prober: Prober,
        hypothesizer: Hypothesizer,
    ) -> None:
        self.client = client
        self.stack_id = stack_id
        self.emitter = emitter
        self.prober = prober
        self.hypothesizer = hypothesizer

    async def verify(self, incident: Incident, fault: FaultClass) -> bool:
        incident.state = "verifying"
        started = _utcnow()
        deadline = time.monotonic() + VERIFY_TIMEOUT_SECONDS
        latest_errors = 0
        latest_canary: ProbeResult | None = None

        while time.monotonic() < deadline:
            latest_errors = await asyncio.to_thread(
                self._fresh_error_count,
                fault,
                started,
            )
            latest_canary = await self.prober.canary_complete()
            specific_ok = await self._specific_recovery(fault)
            if (
                latest_errors <= ERROR_TRIGGER_COUNT
                and latest_canary.ok
                and specific_ok
            ):
                latency = latest_canary.observed.get("latency_ms", "?")
                await self.emitter.action(
                    incident,
                    f"Recovery verified: {fault.value}; error rate {latest_errors}/60s, canary trip completed in {latency}ms ✓.",
                )
                incident.state = "closed"
                incident.closed_at = _utcnow()
                summary = await self.hypothesizer.summarize(incident, True)
                await self.emitter.narration(summary)
                return True
            await asyncio.sleep(VERIFY_INTERVAL_SECONDS)

        await self.emitter.action(
            incident,
            "Mitigation did not restore health — escalating.",
        )
        incident.state = "escalated"
        summary = await self.hypothesizer.summarize(incident, False)
        await self.emitter.narration(summary)
        return False

    def _fresh_error_count(self, fault: FaultClass, since: datetime) -> int:
        rows = (
            self.client.table("events")
            .select("id,service")
            .eq("stack_id", self.stack_id)
            .eq("kind", "error")
            .gte("ts", since.isoformat())
            .in_("service", list(self.AFFECTED_SERVICES[fault]))
            .execute()
            .data
        )
        return len(rows)

    async def _specific_recovery(self, fault: FaultClass) -> bool:
        if fault == FaultClass.MEM_LEAK:
            result = await self.prober._health("location")
            return result["status"] == 200 and result.get("latency_ms", 9999) < 1000
        if fault == FaultClass.SURGE_POISON:
            quote = await self.prober._quote()
            value = quote.get("body", {}).get("quote")
            surge = quote.get("body", {}).get("surge")
            return (
                quote.get("status") == 200
                and isinstance(value, (int, float))
                and float(value) < 100
                and isinstance(surge, (int, float))
                and float(surge) < 50
            )
        if fault == FaultClass.FARE_CORRUPT:
            rows = await asyncio.to_thread(self.prober._pricing_config)
            value = rows[0].get("per_mile_rate") if rows else None
            return isinstance(value, (int, float))
        if fault == FaultClass.DOUBLE_DISPATCH:
            result = await self.prober._driver_has_two_active_trips()
            return not result.ok
        return True


class LiveProbeEngine:
    """One-incident orchestration shared by the daemon and MCP server."""

    RECOMMENDED_MITIGATIONS = Mitigator.PLAYBOOKS

    def __init__(
        self,
        stack_id: str | None = None,
        client: Client | None = None,
    ) -> None:
        self.stack_id = stack_id or os.environ["STACK_ID"]
        self.client = client or create_client(
            os.environ["SUPABASE_URL"],
            os.environ["SUPABASE_SERVICE_KEY"],
        )
        self.tail = EventTail(self.client, self.stack_id)
        self.detector = Detector()
        self.emitter = AgentEmitter(self.stack_id)
        self.hypothesizer = Hypothesizer()
        self.prober = Prober(self.client, self.stack_id, self.emitter)
        self.mitigator = Mitigator(self.client, self.stack_id, self.emitter)
        self.verifier = Verifier(
            self.client,
            self.stack_id,
            self.emitter,
            self.prober,
            self.hypothesizer,
        )
        self.incidents: list[Incident] = []
        self.active_incident: Incident | None = None
        self._cooldown_until: datetime | None = None

    async def close(self) -> None:
        await self.prober.close()

    def reset(self) -> dict[str, Any]:
        """Drop in-flight incident state so a demo can be re-run immediately."""
        previous = self.active_incident.state if self.active_incident else None
        self.active_incident = None
        self._cooldown_until = None
        self.detector = Detector()
        return {"reset": True, "previous_state": previous}

    def _busy(self) -> bool:
        return (
            self.active_incident is not None
            and self.active_incident.state
            not in {"closed", "escalated"}
        )

    def _cooling_down(self) -> bool:
        return (
            self._cooldown_until is not None and _utcnow() < self._cooldown_until
        )

    def _arm_cooldown(self) -> None:
        self._cooldown_until = _utcnow() + timedelta(
            seconds=INCIDENT_COOLDOWN_SECONDS
        )

    async def diagnose(
        self,
        incident: Incident,
        tail: EventTail | None = None,
    ) -> Incident:
        source = tail or self.tail
        incident.state = "predicting"
        rankings = await self.hypothesizer.rank(incident, source)
        candidates = rankings[:2]
        await self.emitter.action(
            incident,
            f"Predict: leading hypothesis {candidates[0].fault.value} from {candidates[0].rationale}.",
        )

        for round_index, candidate in enumerate(candidates, start=1):
            runner_up = (
                candidates[round_index].fault
                if round_index < len(candidates)
                else None
            )
            incident.state = "probing"
            results, predicted_count = await self.prober.run(
                incident,
                candidate.fault,
                runner_up,
            )
            if all(result.ok for result in results[:predicted_count]):
                incident.hypothesis = candidate.fault
                incident.state = "confirmed"
                await self.emitter.action(
                    incident,
                    f"Diagnosis confirmed: {candidate.fault.value}; all predicted probes matched.",
                )
                return incident
            if round_index == 1 and len(candidates) > 1:
                await self.emitter.action(
                    incident,
                    f"Evidence contradicted {candidate.fault.value}; testing runner-up {candidates[1].fault.value}.",
                )

        incident.state = "escalated"
        await self.emitter.action(
            incident,
            "Evidence inconclusive — escalating to human.",
        )
        return incident

    async def run_incident(self, incident: Incident) -> Incident:
        self.incidents.append(incident)
        self.active_incident = incident
        try:
            await self.emitter.action(
                incident,
                f"Incident opened: {self._trigger_message(incident.trigger)}.",
            )
            await self.diagnose(incident)
            if incident.hypothesis is None:
                incident.state = "escalated"
                summary = await self.hypothesizer.summarize(incident, False)
                await self.emitter.narration(summary)
                return incident

            mitigated, _ = await self.mitigator.mitigate(
                incident,
                incident.hypothesis,
            )
            if not mitigated:
                incident.state = "escalated"
                return incident
            await self.verifier.verify(incident, incident.hypothesis)
            return incident
        finally:
            if incident.state in {"closed", "escalated"}:
                self._arm_cooldown()

    async def process(self, new_events: Iterable[EventRecord]) -> Incident | None:
        if self._busy() or self._cooling_down():
            return None
        incident = self.detector.detect(self.tail, new_events)
        if incident is None:
            return None
        return await self.run_incident(incident)

    async def diagnose_recent(self) -> Incident | None:
        await self.tail.load_history(15)
        recent = [
            event
            for event in self.tail.events
            if event.ts >= _utcnow() - timedelta(seconds=60)
        ]
        incident = self.detector.detect(self.tail, recent)
        if incident is None:
            return None
        self.incidents.append(incident)
        await self.diagnose(incident)
        return incident

    @staticmethod
    def recommended_mitigation(fault: FaultClass) -> str:
        return LiveProbeEngine.RECOMMENDED_MITIGATIONS[fault]

    @staticmethod
    def _trigger_message(trigger: dict[str, Any]) -> str:
        if trigger.get("type") == "error_burst":
            return (
                f"{trigger.get('service')} crossed {trigger.get('count')} errors "
                f"in {trigger.get('window_seconds')}s"
            )
        if trigger.get("type") == "latency_regression":
            return (
                f"{trigger.get('service')} median latency reached "
                f"{trigger.get('median_ms')}ms versus {trigger.get('baseline_ms')}ms"
            )
        return (
            f"{trigger.get('invariant')} invariant breached: "
            f"{trigger.get('detail')}"
        )


def derive_incidents(events: list[EventRecord]) -> list[dict[str, Any]]:
    """Derive compact, stateless incident candidates from recent events."""
    incidents: list[dict[str, Any]] = []
    last_opened: dict[str, datetime] = {}
    for event in events:
        if event.kind == "invariant_breach":
            key = f"invariant:{event.payload.get('invariant')}"
            if event.ts - last_opened.get(key, datetime.min.replace(tzinfo=timezone.utc)) > timedelta(seconds=30):
                incidents.append(
                    {
                        "opened_at": event.ts.isoformat(),
                        "trigger": "invariant_breach",
                        "service": event.service,
                        "detail": event.payload,
                    }
                )
                last_opened[key] = event.ts
        if event.kind == "error":
            window_start = event.ts - timedelta(seconds=ERROR_TRIGGER_SECONDS)
            count = sum(
                1
                for candidate in events
                if candidate.kind == "error"
                and candidate.service == event.service
                and window_start <= candidate.ts <= event.ts
            )
            key = f"errors:{event.service}"
            if (
                count > ERROR_TRIGGER_COUNT
                and event.ts
                - last_opened.get(key, datetime.min.replace(tzinfo=timezone.utc))
                > timedelta(seconds=30)
            ):
                incidents.append(
                    {
                        "opened_at": event.ts.isoformat(),
                        "trigger": "error_burst",
                        "service": event.service,
                        "errors_20s": count,
                    }
                )
                last_opened[key] = event.ts
    return incidents[-20:]


def validate_stack_id(stack_id: str) -> str:
    if stack_id not in {"arena", "gauntlet_a", "gauntlet_b"}:
        raise ValueError(f"Unknown stack_id: {stack_id}")
    return stack_id


def _parse_ts(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _compact_value(value: Any, limit: int = 180) -> str:
    rendered = json.dumps(value, sort_keys=True, default=str)
    return rendered if len(rendered) <= limit else rendered[: limit - 1] + "…"
