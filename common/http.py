"""HTTP trace propagation and request/error telemetry."""

from __future__ import annotations

import os
import time
from collections.abc import Awaitable, Callable
from uuid import uuid4

from fastapi import FastAPI, Request, Response

from common.faults import is_active
from common.telemetry import emit


FAULT_NAMES = (
    "db_kill",
    "bad_deploy",
    "mem_leak",
    "surge_poison",
    "fare_corrupt",
    "double_dispatch",
)


def install_request_telemetry(app: FastAPI, service: str) -> None:
    """Instrument every route and place its trace ID on request state."""

    @app.middleware("http")
    async def telemetry_middleware(
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        trace_id = request.headers.get("X-Trace-Id") or str(uuid4())
        request.state.trace_id = trace_id
        started_at = time.perf_counter()
        stack_id = os.environ.get("STACK_ID")

        try:
            response = await call_next(request)
        except Exception as exc:
            latency_ms = round((time.perf_counter() - started_at) * 1000, 2)
            if stack_id:
                emit(
                    stack_id,
                    service,
                    "error",
                    trace_id,
                    {
                        "message": str(exc),
                        "stack_hint": f"{service}:{request.url.path}",
                    },
                )
                emit(
                    stack_id,
                    service,
                    "request",
                    trace_id,
                    {
                        "route": _route_name(request),
                        "status": 500,
                        "latency_ms": latency_ms,
                    },
                )
            raise

        latency_ms = round((time.perf_counter() - started_at) * 1000, 2)
        if stack_id:
            if response.status_code >= 400:
                emit(
                    stack_id,
                    service,
                    "error",
                    trace_id,
                    {
                        "message": f"HTTP {response.status_code}",
                        "stack_hint": f"{service}:{request.url.path}",
                    },
                )
            emit(
                stack_id,
                service,
                "request",
                trace_id,
                {
                    "route": _route_name(request),
                    "status": response.status_code,
                    "latency_ms": latency_ms,
                },
            )

        active = sorted(name for name in FAULT_NAMES if is_active(name))
        if active:
            print(f"[{service}] polled active faults: {active}", flush=True)

        response.headers["X-Trace-Id"] = trace_id
        return response


def _route_name(request: Request) -> str:
    route = request.scope.get("route")
    return str(getattr(route, "path", request.url.path))
