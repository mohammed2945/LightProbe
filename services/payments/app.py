"""Fresh-rate fare capture."""

from __future__ import annotations

import os
from typing import Any
from uuid import uuid4

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from common.db import get_client
from common.http import install_request_telemetry


SERVICE = "payments"
app = FastAPI(title="RideRush Payments")
install_request_telemetry(app, SERVICE)


class CaptureRequest(BaseModel):
    trip_id: str
    distance: float = Field(ge=0)
    surge: float = Field(gt=0)


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/capture")
def capture(request: CaptureRequest) -> dict[str, object]:
    stack_id = os.environ["STACK_ID"]
    config_response = (
        get_client()
        .table("pricing_config")
        .select("per_mile_rate,base_fare")
        .eq("stack_id", stack_id)
        .limit(1)
        .execute()
    )
    if not config_response.data:
        raise HTTPException(status_code=503, detail="Pricing is not configured")

    config: dict[str, Any] = config_response.data[0]
    per_mile_rate = config["per_mile_rate"]

    # Intentionally use the freshly read value directly in float arithmetic.
    # A fare_corrupt string therefore fails here, not in pricing.
    amount = (
        float(config["base_fare"])
        + per_mile_rate * float(request.distance) * float(request.surge)
    )
    if not 0 < amount < 500:
        raise HTTPException(status_code=422, detail="Captured fare outside (0, 500)")

    payment_id = str(uuid4())
    response = (
        get_client()
        .table("payments")
        .upsert(
            {
                "stack_id": stack_id,
                "id": payment_id,
                "trip_id": request.trip_id,
                "amount": float(amount),
                "status": "captured",
            },
            on_conflict="stack_id,trip_id",
        )
        .execute()
    )
    payment = response.data[0] if response.data else {}
    return {
        "payment_id": payment.get("id", payment_id),
        "amount": round(float(amount), 2),
        "status": "captured",
    }
