#!/usr/bin/env python3
"""Microbenchmark steady-state overhead after LINE locations are DISABLEd."""

from __future__ import annotations

import argparse
import statistics
import sys
import time


def workload(iterations: int) -> int:
    total = 0
    for value in range(iterations):
        total += (value * 17) % 13
    return total


def sample(rounds: int, iterations: int) -> list[int]:
    measurements: list[int] = []
    for _ in range(rounds):
        started = time.perf_counter_ns()
        workload(iterations)
        measurements.append(time.perf_counter_ns() - started)
    return measurements


def percentile_99(values: list[int]) -> float:
    return statistics.quantiles(values, n=100, method="inclusive")[-1]


def summarize(values: list[int]) -> tuple[float, float]:
    return statistics.median(values) / 1_000, percentile_99(values) / 1_000


def summarize_trials(trials: list[list[int]]) -> tuple[float, float]:
    summaries = [summarize(values) for values in trials]
    return (
        statistics.median(summary[0] for summary in summaries),
        statistics.median(summary[1] for summary in summaries),
    )


def measured_with_disabled_lines(
    rounds: int, iterations: int
) -> list[int]:
    monitoring = sys.monitoring
    tool_id = monitoring.DEBUGGER_ID

    def disable_location(code: object, line: int) -> object:
        return monitoring.DISABLE

    monitoring.use_tool_id(tool_id, "liveprobe-benchmark")
    try:
        monitoring.register_callback(
            tool_id, monitoring.events.LINE, disable_location
        )
        monitoring.set_events(tool_id, monitoring.events.LINE)
        workload(iterations)
        return sample(rounds, iterations)
    finally:
        monitoring.set_events(tool_id, 0)
        monitoring.register_callback(tool_id, monitoring.events.LINE, None)
        monitoring.free_tool_id(tool_id)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--rounds", type=int, default=500)
    parser.add_argument("--trials", type=int, default=7)
    parser.add_argument("--iterations", type=int, default=5000)
    parser.add_argument("--assert-max-p99", type=float)
    args = parser.parse_args()
    if args.rounds < 100 or args.trials < 3 or args.iterations < 1:
        parser.error(
            "rounds must be >= 100, trials >= 3, and iterations positive"
        )

    workload(args.iterations)
    baseline_trials: list[list[int]] = []
    monitored_trials: list[list[int]] = []
    for _ in range(args.trials):
        baseline_before = sample(args.rounds, args.iterations)
        monitored_trials.append(
            measured_with_disabled_lines(args.rounds, args.iterations)
        )
        baseline_after = sample(args.rounds, args.iterations)
        baseline_trials.append([*baseline_before, *baseline_after])

    base_p50, base_p99 = summarize_trials(baseline_trials)
    monitored_p50, monitored_p99 = summarize_trials(monitored_trials)
    delta = ((monitored_p99 / base_p99) - 1.0) * 100 if base_p99 else 0.0

    print("mode                 p50_us      p99_us    p99_delta")
    print(f"baseline          {base_p50:10.3f} {base_p99:11.3f}          -")
    print(
        f"disabled-location {monitored_p50:10.3f} "
        f"{monitored_p99:11.3f} {delta:9.2f}%"
    )

    if args.assert_max_p99 is not None and delta > args.assert_max_p99:
        print(
            f"p99 delta {delta:.2f}% exceeds {args.assert_max_p99:.2f}%",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
