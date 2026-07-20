"""Run the frozen ten-minute fault schedule against both gauntlet stacks."""

from __future__ import annotations

import argparse
import asyncio
import os
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Literal

from supabase import Client, create_client

from common.telemetry import emit
from ops.janitor import reset_stack
from ops.seed import load_env


GAUNTLET_STACKS = ("gauntlet_a", "gauntlet_b")


@dataclass(frozen=True)
class ScheduleEvent:
    offset_seconds: int
    action: Literal["start", "clear"]
    fault: str


SCHEDULE = (
    ScheduleEvent(0, "start", "bad_deploy"),
    ScheduleEvent(60, "clear", "bad_deploy"),
    ScheduleEvent(90, "start", "db_kill"),
    ScheduleEvent(150, "clear", "db_kill"),
    ScheduleEvent(180, "start", "mem_leak"),
    ScheduleEvent(270, "clear", "mem_leak"),
    ScheduleEvent(300, "start", "surge_poison"),
    ScheduleEvent(360, "clear", "surge_poison"),
    ScheduleEvent(390, "start", "fare_corrupt"),
    ScheduleEvent(510, "clear", "fare_corrupt"),
    ScheduleEvent(525, "start", "double_dispatch"),
    ScheduleEvent(585, "clear", "double_dispatch"),
)


def new_client() -> Client:
    return create_client(
        os.environ["SUPABASE_URL"],
        os.environ["SUPABASE_SERVICE_KEY"],
    )


def start_fault(stack_id: str, fault: str) -> int:
    response = (
        new_client()
        .table("active_faults")
        .insert({"stack_id": stack_id, "fault": fault})
        .execute()
    )
    emit(
        stack_id,
        "agent",
        "fault_started",
        None,
        {"fault": fault, "source": "run_gauntlet"},
    )
    return int(response.data[0]["id"])


def clear_fault(stack_id: str, fault: str, fault_id: int) -> None:
    (
        new_client()
        .table("active_faults")
        .update({"cleared_at": datetime.now(timezone.utc).isoformat()})
        .eq("stack_id", stack_id)
        .eq("id", fault_id)
        .execute()
    )
    emit(
        stack_id,
        "agent",
        "fault_cleared",
        None,
        {"fault": fault, "source": "run_gauntlet"},
    )


def print_schedule() -> None:
    base = datetime.now(timezone.utc)
    print(f"Gauntlet dry-run base={base.isoformat()}")
    for event in SCHEDULE:
        timestamp = base + timedelta(seconds=event.offset_seconds)
        minute, second = divmod(event.offset_seconds, 60)
        print(
            f"{timestamp.isoformat()} +{minute}:{second:02d} "
            f"{event.action.upper()} {event.fault} "
            f"stacks={','.join(GAUNTLET_STACKS)}"
        )
    janitor_at = base + timedelta(seconds=SCHEDULE[-1].offset_seconds)
    print(
        f"{janitor_at.isoformat()} +9:45 JANITOR "
        "stack=gauntlet_b after final clear"
    )


async def run_schedule() -> None:
    loop = asyncio.get_running_loop()
    started_at = loop.time()
    active_ids: dict[tuple[str, str], int] = {}

    for event in SCHEDULE:
        remaining = event.offset_seconds - (loop.time() - started_at)
        if remaining > 0:
            await asyncio.sleep(remaining)
        timestamp = datetime.now(timezone.utc).isoformat()

        if event.action == "start":
            ids = await asyncio.gather(
                *(
                    asyncio.to_thread(start_fault, stack_id, event.fault)
                    for stack_id in GAUNTLET_STACKS
                )
            )
            for stack_id, fault_id in zip(GAUNTLET_STACKS, ids, strict=True):
                active_ids[(stack_id, event.fault)] = fault_id
        else:
            await asyncio.gather(
                *(
                    asyncio.to_thread(
                        clear_fault,
                        stack_id,
                        event.fault,
                        active_ids[(stack_id, event.fault)],
                    )
                    for stack_id in GAUNTLET_STACKS
                )
            )
        print(
            f"{timestamp} {event.action.upper()} {event.fault} "
            f"stacks={','.join(GAUNTLET_STACKS)}",
            flush=True,
        )

    result = await asyncio.to_thread(reset_stack, new_client(), "gauntlet_b")
    print(f"{datetime.now(timezone.utc).isoformat()} JANITOR {result}", flush=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.dry_run:
        print_schedule()
        return 0
    load_env()
    asyncio.run(run_schedule())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
