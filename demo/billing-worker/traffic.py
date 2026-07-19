from __future__ import annotations

import argparse
import json
import signal
import threading
import time
import urllib.error
import urllib.request
from itertools import cycle
from typing import Any


USER_SEQUENCE = (
    "standard-us",
    "legacy-user",
    "standard-eu",
    "standard-us",
    "legacy-user",
    "standard-eu",
)


def post_renewal(
    base_url: str, user_id: str, subtotal_cents: int, timeout: float
) -> tuple[int, dict[str, Any]]:
    body = json.dumps(
        {"user_id": user_id, "subtotal_cents": subtotal_cents},
        separators=(",", ":"),
    ).encode("utf-8")
    request = urllib.request.Request(
        f"{base_url.rstrip('/')}/renew",
        data=body,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = response.read()
            status = response.status
    except urllib.error.HTTPError as error:
        payload = error.read()
        status = error.code
    decoded = json.loads(payload) if payload else {}
    return status, decoded if isinstance(decoded, dict) else {}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate deterministic mixed-user billing renewal traffic."
    )
    parser.add_argument("--base-url", default="http://127.0.0.1:8081")
    parser.add_argument(
        "--interval",
        type=float,
        default=0.25,
        help="seconds between requests",
    )
    parser.add_argument(
        "--requests",
        type=int,
        default=0,
        help="request count; zero runs until interrupted",
    )
    parser.add_argument("--timeout", type=float, default=2.0)
    args = parser.parse_args()
    if args.interval < 0:
        parser.error("--interval must be non-negative")
    if args.requests < 0:
        parser.error("--requests must be non-negative")
    if args.timeout <= 0:
        parser.error("--timeout must be positive")
    return args


def main() -> int:
    args = parse_args()
    stopped = threading.Event()

    def stop(_signum: int, _frame: object) -> None:
        stopped.set()

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)

    sent = 0
    succeeded = 0
    failed = 0
    for sequence, user_id in enumerate(cycle(USER_SEQUENCE), start=1):
        if stopped.is_set() or (args.requests and sent >= args.requests):
            break
        subtotal_cents = 2_000 + ((sequence - 1) % 5) * 125
        try:
            status, response = post_renewal(
                args.base_url, user_id, subtotal_cents, args.timeout
            )
            outcome = "ok" if 200 <= status < 300 else "error"
            if outcome == "ok":
                succeeded += 1
            else:
                failed += 1
            detail = response.get("detail", response.get("total_cents", ""))
            print(
                f"traffic seq={sequence} user={user_id} "
                f"status={status} outcome={outcome} detail={detail}",
                flush=True,
            )
        except (OSError, ValueError, json.JSONDecodeError) as error:
            failed += 1
            print(
                f"traffic seq={sequence} user={user_id} "
                f"status=unavailable error={type(error).__name__}",
                flush=True,
            )
        sent += 1
        if args.interval:
            stopped.wait(args.interval)

    print(
        f"traffic stopped sent={sent} succeeded={succeeded} failed={failed}",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
