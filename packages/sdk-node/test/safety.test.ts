import { afterEach, describe, expect, it, vi } from "vitest";

import { TokenBucket } from "../src/rate-limiter.js";
import { EventLoopSafetyMonitor } from "../src/safety-monitor.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("TokenBucket", () => {
  it("limits before work and refills over time", () => {
    let now = 0;
    const bucket = new TokenBucket(2, () => now);
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(false);
    now = 500;
    expect(bucket.tryTake()).toBe(true);
  });
});

describe("EventLoopSafetyMonitor", () => {
  it("enters RED, cools down, and rearms", async () => {
    vi.useFakeTimers();
    let p95Nanoseconds = 80_000_000;
    const onRed = vi.fn();
    const onRearm = vi.fn();
    const histogram = {
      enable: vi.fn(() => true),
      disable: vi.fn(() => true),
      reset: vi.fn(),
      percentile: vi.fn(() => p95Nanoseconds),
    };
    const monitor = new EventLoopSafetyMonitor({
      maxLagMs: 50,
      sampleIntervalMs: 1000,
      cooldownMs: 10_000,
      onRed,
      onRearm,
      histogram,
    });

    monitor.start();
    monitor.sampleNow();
    expect(monitor.state).toBe("red");
    expect(onRed).toHaveBeenCalledWith(80);

    p95Nanoseconds = 1_000_000;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(monitor.state).toBe("green");
    expect(onRearm).toHaveBeenCalledOnce();

    monitor.stop();
    expect(histogram.disable).toHaveBeenCalledOnce();
  });

  it("ignores healthy samples", () => {
    const onRed = vi.fn();
    const monitor = new EventLoopSafetyMonitor({
      maxLagMs: 50,
      sampleIntervalMs: 1000,
      cooldownMs: 10_000,
      onRed,
      onRearm: vi.fn(),
      histogram: {
        enable: () => true,
        disable: () => true,
        reset() {},
        percentile: () => 20_000_000,
      },
    });
    monitor.start();
    monitor.sampleNow();
    expect(monitor.state).toBe("green");
    expect(onRed).not.toHaveBeenCalled();
    monitor.stop();
  });
});
