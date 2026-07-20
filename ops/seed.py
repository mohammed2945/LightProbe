"""Seed deterministic RideRush data for one stack."""

from __future__ import annotations

import argparse
import os
from pathlib import Path

from supabase import Client, create_client


ROOT = Path(__file__).resolve().parents[1]
STACK_IDS = ("arena", "gauntlet_a", "gauntlet_b")
DRIVER_POSITIONS = (
    ("d1", 15, 15),
    ("d2", 40, 15),
    ("d3", 65, 15),
    ("d4", 90, 15),
    ("d5", 15, 50),
    ("d6", 40, 50),
    ("d7", 65, 50),
    ("d8", 90, 50),
    ("d9", 15, 85),
    ("d10", 40, 85),
    ("d11", 65, 85),
    ("d12", 90, 85),
)


def load_env() -> None:
    """Load unset values from the repository's local .env file."""
    env_path = ROOT / ".env"
    if not env_path.exists():
        return
    for raw_line in env_path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip())


def seed(client: Client, stack_id: str) -> None:
    """Reset and seed all deterministic rows for one stack."""
    drivers = [
        {
            "stack_id": stack_id,
            "id": driver_id,
            "x": x,
            "y": y,
            "status": "idle",
        }
        for driver_id, x, y in DRIVER_POSITIONS
    ]

    client.table("payments").delete().eq("stack_id", stack_id).execute()
    client.table("trips").delete().eq("stack_id", stack_id).execute()
    client.table("drivers").delete().eq("stack_id", stack_id).execute()
    client.table("drivers").insert(drivers).execute()
    client.table("pricing_config").upsert(
        {
            "stack_id": stack_id,
            "per_mile_rate": 2.45,
            "surge": 1.0,
            "base_fare": 3.50,
        },
        on_conflict="stack_id",
    ).execute()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Reset drivers and pricing data for one RideRush stack."
    )
    parser.add_argument("stack_id", choices=STACK_IDS)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    load_env()

    missing = [
        name
        for name in ("SUPABASE_URL", "SUPABASE_SERVICE_KEY")
        if not os.environ.get(name)
    ]
    if missing:
        raise SystemExit(f"Missing environment value: {missing[0]}")

    os.environ["STACK_ID"] = args.stack_id
    client = create_client(
        os.environ["SUPABASE_URL"],
        os.environ["SUPABASE_SERVICE_KEY"],
    )
    seed(client, args.stack_id)
    print(f"Seeded {len(DRIVER_POSITIONS)} drivers and pricing for {args.stack_id}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
