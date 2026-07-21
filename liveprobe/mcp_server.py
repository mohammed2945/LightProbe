"""Stateless MCP facade over the shared LiveProbe engine."""

from __future__ import annotations

import asyncio
import os
from datetime import datetime, timezone
from typing import Any

from mcp.server.fastmcp import FastMCP

from liveprobe.engine import (
    FaultClass,
    Incident,
    LiveProbeEngine,
    derive_incidents,
    validate_stack_id,
)


mcp = FastMCP("liveprobe")


def _target_stack(stack_id: str) -> str:
    validated = validate_stack_id(stack_id)
    configured = os.environ.get("STACK_ID")
    if configured and configured != validated:
        raise ValueError(
            f"This LiveProbe server is configured for {configured}, not {validated}"
        )
    return validated


@mcp.tool()
async def get_system_health(stack_id: str) -> dict[str, Any]:
    """Return recent event health and direct service health probes."""
    engine = LiveProbeEngine(_target_stack(stack_id))
    try:
        await engine.tail.load_history(1)
        services = ("gateway", "matching", "pricing", "location", "trips", "payments")
        live = await asyncio.gather(
            *(engine.prober._health(service) for service in services)
        )
        error_counts = engine.tail.error_counts(60)
        medians = engine.tail.latency_medians(60)
        return {
            "stack_id": stack_id,
            "services": {
                row["service"]: {
                    "status": "healthy" if row["status"] == 200 else "degraded",
                    "http_status": row["status"],
                    "probe_latency_ms": row.get("latency_ms"),
                    "errors_60s": error_counts.get(row["service"], 0),
                    "median_latency_ms": medians.get(row["service"]),
                }
                for row in live
            },
            "last_invariant": (
                engine.tail.last_invariant_breach.compact()
                if engine.tail.last_invariant_breach
                else None
            ),
            "world_metrics": {
                name: event.payload
                for name, event in engine.tail.last_world_metrics.items()
            },
        }
    finally:
        await engine.close()


@mcp.tool()
async def get_incidents(stack_id: str) -> dict[str, Any]:
    """Derive incident candidates from the last fifteen minutes of events."""
    engine = LiveProbeEngine(_target_stack(stack_id))
    try:
        events = await engine.tail.load_history(15)
        return {
            "stack_id": stack_id,
            "incidents": derive_incidents(events),
        }
    finally:
        await engine.close()


@mcp.tool()
async def diagnose(stack_id: str) -> dict[str, Any]:
    """Detect, predict, and probe once without applying mitigation."""
    engine = LiveProbeEngine(_target_stack(stack_id))
    try:
        incident = await engine.diagnose_recent()
        if incident is None or incident.hypothesis is None:
            return {
                "stack_id": stack_id,
                "root_cause": None,
                "confidence": 0.0,
                "evidence": incident.evidence if incident else [],
                "recommended_mitigation": None,
            }
        leading_score = incident.rankings[0].score if incident.rankings else 0
        return {
            "stack_id": stack_id,
            "root_cause": incident.hypothesis.value,
            "confidence": min(1.0, leading_score / 12),
            "evidence": incident.evidence,
            "recommended_mitigation": engine.recommended_mitigation(
                incident.hypothesis
            ),
        }
    finally:
        await engine.close()


@mcp.tool()
async def mitigate(stack_id: str, fault: str) -> dict[str, Any]:
    """Apply the playbook for a fault already diagnosed by the caller."""
    stack = _target_stack(stack_id)
    diagnosis = FaultClass(fault)
    engine = LiveProbeEngine(stack)
    incident = Incident(
        id=f"mcp_{datetime.now(timezone.utc).timestamp()}",
        opened_at=datetime.now(timezone.utc),
        trigger={"type": "mcp_confirmed_diagnosis"},
        state="confirmed",
        hypothesis=diagnosis,
    )
    try:
        ok, actions = await engine.mitigator.mitigate(incident, diagnosis)
        return {
            "stack_id": stack,
            "fault": diagnosis.value,
            "mitigated": ok,
            "actions": actions,
        }
    finally:
        await engine.close()


@mcp.tool()
async def get_event_tail(stack_id: str, n: int = 20) -> dict[str, Any]:
    """Return at most fifty recent, compact event records."""
    if not 1 <= n <= 50:
        raise ValueError("n must be between 1 and 50")
    engine = LiveProbeEngine(_target_stack(stack_id))
    try:
        await engine.tail.load_history(15)
        return {
            "stack_id": stack_id,
            "events": engine.tail.compact_last(n),
        }
    finally:
        await engine.close()


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
