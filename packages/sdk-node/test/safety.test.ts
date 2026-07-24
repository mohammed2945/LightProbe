import { afterEach, describe, expect, it, vi } from "vitest";

import { TokenBucket } from "../src/rate-limiter.js";
import { resolveLimits } from "../src/live-probe.js";
import { EventLoopSafetyMonitor } from "../src/safety-monitor.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
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
    expect(monitor.reasonCode).toBe("event_loop_lag");
    expect(onRed).toHaveBeenCalledWith(80);

    p95Nanoseconds = 1_000_000;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(monitor.state).toBe("green");
    expect(monitor.reasonCode).toBeUndefined();
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

describe("canonical safety limits", () => {
  it("resolves portable environment variables", () => {
    vi.stubEnv("LIVEPROBE_MAX_PROBE_HITS_PER_SECOND", "12");
    vi.stubEnv("LIVEPROBE_MAX_TELEMETRY_BYTES_PER_SECOND", "4096");
    vi.stubEnv("LIVEPROBE_MAX_BUFFERED_EVENT_BYTES", "8192");
    vi.stubEnv("LIVEPROBE_MAX_EVENT_LOOP_LAG_MS", "75");
    vi.stubEnv("LIVEPROBE_SAFETY_COOLDOWN_MS", "2500");

    expect(resolveLimits()).toMatchObject({
      hitsPerSec: 12,
      bandwidthKbPerSec: 4,
      maxQueueBytes: 8192,
      maxLagMs: 75,
      cooldownMs: 2500,
    });
  });

  it("accepts equivalent legacy aliases and rejects conflicts", () => {
    expect(
      resolveLimits({
        maxProbeHitsPerSecond: 20,
        hitsPerSec: 20,
        maxTelemetryBytesPerSecond: 2048,
        bandwidthKbPerSec: 2,
      }),
    ).toMatchObject({ hitsPerSec: 20, bandwidthKbPerSec: 2 });

    expect(() =>
      resolveLimits({ maxProbeHitsPerSecond: 20, hitsPerSec: 10 }),
    ).toThrow(/conflicts/u);
  });
});
