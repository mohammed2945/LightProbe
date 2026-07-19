package io.liveprobe.bridge;

import java.util.Objects;
import java.util.concurrent.TimeUnit;
import java.util.function.LongSupplier;

/** Deterministic fixed-window limiter checked before any JDI capture work. */
final class RateLimiter {
    private static final long WINDOW_NANOS = TimeUnit.SECONDS.toNanos(1);

    private final int permitsPerSecond;
    private final LongSupplier nanoClock;
    private long windowStart;
    private int used;

    RateLimiter(int permitsPerSecond) {
        this(permitsPerSecond, System::nanoTime);
    }

    RateLimiter(int permitsPerSecond, LongSupplier nanoClock) {
        if (permitsPerSecond <= 0) {
            throw new IllegalArgumentException("permitsPerSecond must be positive");
        }
        this.permitsPerSecond = permitsPerSecond;
        this.nanoClock = Objects.requireNonNull(nanoClock, "nanoClock");
        this.windowStart = nanoClock.getAsLong();
    }

    synchronized boolean tryAcquire() {
        rollWindow(nanoClock.getAsLong());
        if (used >= permitsPerSecond) {
            return false;
        }
        used++;
        return true;
    }

    synchronized long nanosUntilReset() {
        long now = nanoClock.getAsLong();
        rollWindow(now);
        if (used < permitsPerSecond) {
            return 0;
        }
        return Math.max(1, WINDOW_NANOS - Math.max(0, now - windowStart));
    }

    synchronized int remaining() {
        rollWindow(nanoClock.getAsLong());
        return Math.max(0, permitsPerSecond - used);
    }

    private void rollWindow(long now) {
        long elapsed = now - windowStart;
        if (elapsed < 0 || elapsed >= WINDOW_NANOS) {
            windowStart = now;
            used = 0;
        }
    }
}
