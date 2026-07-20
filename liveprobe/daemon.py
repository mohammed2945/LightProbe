"""Long-running LiveProbe daemon with a minimal Cloud Run health endpoint."""

from __future__ import annotations

import asyncio
import json
import logging
from contextlib import asynccontextmanager, suppress
from typing import Any

from fastapi import FastAPI

from liveprobe.engine import LiveProbeEngine


POLL_SECONDS = 2.0
LOGGER = logging.getLogger(__name__)
_engine: LiveProbeEngine | None = None
_status: dict[str, Any] = {
    "status": "starting",
    "last_event_id": None,
    "incident_id": None,
    "incident_state": None,
}


def _log(stage: str, **values: Any) -> None:
    LOGGER.info(json.dumps({"stage": stage, **values}, sort_keys=True, default=str))


async def run_daemon(engine: LiveProbeEngine) -> None:
    _status["status"] = "polling"
    _log("startup", stack_id=engine.stack_id)
    try:
        while True:
            try:
                new_events = await engine.tail.poll()
                _status["last_event_id"] = engine.tail.cursor
                if engine.active_incident is not None:
                    _status["incident_id"] = engine.active_incident.id
                    _status["incident_state"] = engine.active_incident.state
                else:
                    _status["incident_id"] = None
                    _status["incident_state"] = None
                if new_events:
                    _log(
                        "poll",
                        events=len(new_events),
                        cursor=engine.tail.cursor,
                        busy=engine._busy(),
                        cooling_down=engine._cooling_down(),
                    )
                if not engine._busy():
                    incident = await engine.process(new_events)
                    if incident is not None:
                        _status["incident_id"] = incident.id
                        _status["incident_state"] = incident.state
                        _log(
                            "incident",
                            incident_id=incident.id,
                            state=incident.state,
                            hypothesis=incident.hypothesis,
                        )
            except Exception:
                _status["status"] = "degraded"
                LOGGER.exception("LiveProbe daemon iteration failed")
            else:
                _status["status"] = "polling"
            await asyncio.sleep(POLL_SECONDS)
    finally:
        await engine.close()


@asynccontextmanager
async def lifespan(_: FastAPI):
    global _engine
    logging.basicConfig(level=logging.INFO)
    _engine = LiveProbeEngine()
    task = asyncio.create_task(run_daemon(_engine))
    yield
    task.cancel()
    with suppress(asyncio.CancelledError):
        await task
    _engine = None


app = FastAPI(title="LiveProbe", lifespan=lifespan)


@app.get("/healthz")
def healthz() -> dict[str, Any]:
    payload = dict(_status)
    if _engine is not None:
        payload["cooling_down"] = _engine._cooling_down()
        payload["busy"] = _engine._busy()
    return payload


@app.post("/reset")
def reset() -> dict[str, Any]:
    """Clear stuck incident/cooldown state between demo runs."""
    if _engine is None:
        return {"reset": False, "reason": "engine_not_ready"}
    result = _engine.reset()
    _status["incident_id"] = None
    _status["incident_state"] = None
    _status["status"] = "polling"
    return result


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    asyncio.run(run_daemon(LiveProbeEngine()))


if __name__ == "__main__":
    main()
