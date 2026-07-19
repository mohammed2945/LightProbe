package io.liveprobe.demo.inventory;

import io.javalin.Javalin;
import io.javalin.http.Context;

import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Small Javalin service with an intentionally deterministic stale-cache race.
 *
 * <p>When BUG=on, paired leader/follower requests both read a cached stock value
 * before the leader commits. The follower then makes its decision from the stale
 * value and oversells. The source marker keeps that decision easy to locate.
 */
public final class InventoryService {
    static final String SERVICE_ID = "inventory-service";
    private static final int DEFAULT_PORT = 8080;

    private InventoryService() {}

    public static void main(String[] args) {
        boolean bugEnabled = parseBugFlag(System.getenv().getOrDefault("BUG", "on"));
        int port = positiveInt(System.getenv().getOrDefault("PORT", Integer.toString(DEFAULT_PORT)), "PORT");
        InventoryEngine engine = new InventoryEngine(bugEnabled, Duration.ofSeconds(5));

        Javalin app = Javalin.create(config -> config.showJavalinBanner = false);
        registerRoutes(app, engine);
        app.start(port);
        Runtime.getRuntime().addShutdownHook(new Thread(app::stop, "inventory-shutdown"));

        System.out.printf(
                "[inventory] service=%s port=%d BUG=%s%n",
                SERVICE_ID,
                port,
                bugEnabled ? "on" : "off");
    }

    static void registerRoutes(Javalin app, InventoryEngine engine) {
        app.get("/health", context -> {
            RequestTrace trace = beginRequest(engine, "GET", "/health");
            int status = 500;
            try {
                status = 200;
                json(context, status, Json.object(
                        "status", "ok",
                        "service", SERVICE_ID,
                        "bug", engine.bugEnabled() ? "on" : "off"));
            } finally {
                finishRequest(engine, trace, status);
            }
        });

        app.get("/stats", context -> {
            RequestTrace trace = beginRequest(engine, "GET", "/stats");
            int status = 500;
            try {
                Stats stats = engine.stats();
                status = 200;
                json(context, status, Json.object(
                        "service", SERVICE_ID,
                        "bug", engine.bugEnabled() ? "on" : "off",
                        "httpRequests", stats.httpRequests(),
                        "completedHttpRequests", stats.completedHttpRequests(),
                        "inFlightHttpRequests", stats.inFlightHttpRequests(),
                        "totalRequests", stats.totalRequests(),
                        "completedRequests", stats.completedRequests(),
                        "inFlightRequests", stats.inFlightRequests(),
                        "successfulReservations", stats.successfulReservations(),
                        "rejectedReservations", stats.rejectedReservations(),
                        "wrongStockDecisions", stats.wrongStockDecisions(),
                        "workerThreadCount", stats.workerThreads().size(),
                        "workerThreads", stats.workerThreads()));
            } finally {
                finishRequest(engine, trace, status);
            }
        });

        app.post("/reserve", context -> {
            RequestTrace trace = beginRequest(engine, "POST", "/reserve");
            int status = 500;
            try {
                String sku;
                int quantity;
                String waveId;
                String role;
                try {
                    sku = requiredQuery(context, "sku");
                    quantity = positiveInt(requiredQuery(context, "quantity"), "quantity");
                    waveId = requiredQuery(context, "wave");
                    role = requiredQuery(context, "role").toLowerCase(Locale.ROOT);
                    if (!role.equals("leader") && !role.equals("follower")) {
                        throw new IllegalArgumentException("role must be leader or follower");
                    }
                } catch (IllegalArgumentException exception) {
                    status = 400;
                    json(context, status, Json.object(
                            "error", "invalid_request",
                            "message", exception.getMessage()));
                    return;
                }

                try {
                    ReservationResult result = engine.reserve(sku, quantity, waveId, role);
                    status = result.accepted() ? 201 : 409;
                    context.header("X-Request-Ordinal", Long.toString(result.requestOrdinal()));
                    System.out.printf(
                            "[reservation] request=%d wave=%s role=%s accepted=%s "
                                    + "cached=%d authoritative=%d remaining=%d wrongDecision=%s%n",
                            result.requestOrdinal(),
                            result.waveId(),
                            result.role(),
                            result.accepted(),
                            result.cachedStock(),
                            result.observedAuthoritativeStock(),
                            result.remainingStock(),
                            result.wrongDecision());
                    json(context, status, Json.object(
                            "sku", result.sku(),
                            "quantity", result.quantity(),
                            "wave", result.waveId(),
                            "role", result.role(),
                            "accepted", result.accepted(),
                            "wrongDecision", result.wrongDecision(),
                            "cachedStock", result.cachedStock(),
                            "observedAuthoritativeStock", result.observedAuthoritativeStock(),
                            "remainingStock", result.remainingStock(),
                            "requestOrdinal", result.requestOrdinal(),
                            "thread", result.threadName()));
                } catch (IllegalArgumentException exception) {
                    status = 400;
                    json(context, status, Json.object(
                            "error", "invalid_request",
                            "message", exception.getMessage()));
                } catch (IllegalStateException exception) {
                    status = 503;
                    json(context, status, Json.object(
                            "error", "race_timeout",
                            "message", exception.getMessage()));
                }
            } finally {
                finishRequest(engine, trace, status);
            }
        });
    }

    private static RequestTrace beginRequest(InventoryEngine engine, String method, String path) {
        long startedNanos = System.nanoTime();
        long ordinal = engine.beginHttpRequest();
        String thread = Thread.currentThread().getName();
        System.out.printf(
                "[request] started id=%d method=%s path=%s thread=%s%n",
                ordinal,
                method,
                path,
                thread);
        return new RequestTrace(ordinal, method, path, thread, startedNanos);
    }

    private static void finishRequest(InventoryEngine engine, RequestTrace trace, int status) {
        engine.completeHttpRequest();
        long elapsedMillis = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - trace.startedNanos());
        System.out.printf(
                "[request] completed id=%d method=%s path=%s status=%d elapsedMs=%d thread=%s%n",
                trace.ordinal(),
                trace.method(),
                trace.path(),
                status,
                elapsedMillis,
                trace.thread());
    }

    private static String requiredQuery(Context context, String name) {
        String value = context.queryParam(name);
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(name + " is required");
        }
        return value;
    }

    private static void json(Context context, int status, String body) {
        context.status(status).contentType("application/json; charset=utf-8").result(body);
    }

    private static int positiveInt(String value, String name) {
        try {
            int parsed = Integer.parseInt(value);
            if (parsed <= 0) {
                throw new NumberFormatException();
            }
            return parsed;
        } catch (NumberFormatException exception) {
            throw new IllegalArgumentException(name + " must be a positive integer");
        }
    }

    private static boolean parseBugFlag(String raw) {
        return switch (raw.toLowerCase(Locale.ROOT)) {
            case "on" -> true;
            case "off" -> false;
            default -> throw new IllegalArgumentException("BUG must be on or off");
        };
    }
}

final class InventoryEngine {
    private static final int STOCK_PER_WAVE = 1;

    private final boolean bugEnabled;
    private final Duration raceTimeout;
    private final ConcurrentHashMap<String, AtomicInteger> authoritativeStock = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, Integer> stockCache = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, RaceWave> waves = new ConcurrentHashMap<>();
    private final Set<String> workerThreads = ConcurrentHashMap.newKeySet();
    private final AtomicLong totalRequests = new AtomicLong();
    private final AtomicLong completedRequests = new AtomicLong();
    private final AtomicLong successfulReservations = new AtomicLong();
    private final AtomicLong rejectedReservations = new AtomicLong();
    private final AtomicLong wrongStockDecisions = new AtomicLong();
    private final AtomicInteger inFlightRequests = new AtomicInteger();
    private final AtomicLong httpRequests = new AtomicLong();
    private final AtomicLong completedHttpRequests = new AtomicLong();
    private final AtomicInteger inFlightHttpRequests = new AtomicInteger();

    InventoryEngine(boolean bugEnabled, Duration raceTimeout) {
        this.bugEnabled = bugEnabled;
        this.raceTimeout = Objects.requireNonNull(raceTimeout, "raceTimeout");
        if (raceTimeout.isZero() || raceTimeout.isNegative()) {
            throw new IllegalArgumentException("raceTimeout must be positive");
        }
    }

    boolean bugEnabled() {
        return bugEnabled;
    }

    long beginHttpRequest() {
        workerThreads.add(Thread.currentThread().getName());
        inFlightHttpRequests.incrementAndGet();
        return httpRequests.incrementAndGet();
    }

    void completeHttpRequest() {
        inFlightHttpRequests.decrementAndGet();
        completedHttpRequests.incrementAndGet();
    }

    ReservationResult reserve(String sku, int requested, String waveId, String requestRole) {
        validateRequest(sku, requested, waveId, requestRole);
        long requestOrdinal = totalRequests.incrementAndGet();
        inFlightRequests.incrementAndGet();
        String threadName = Thread.currentThread().getName();
        workerThreads.add(threadName);
        try {
            RaceWave wave = waves.compute(waveId, (ignored, existing) -> {
                if (existing != null) {
                    existing.requireSku(sku);
                    return existing;
                }
                authoritativeStock.put(sku, new AtomicInteger(STOCK_PER_WAVE));
                stockCache.put(sku, STOCK_PER_WAVE);
                return new RaceWave(sku);
            });

            ReservationResult result = bugEnabled
                    ? reserveWithStaleCache(
                            sku, requested, waveId, requestRole, requestOrdinal, threadName, wave)
                    : reserveAtomically(
                            sku, requested, waveId, requestRole, requestOrdinal, threadName, wave);
            if (result.accepted()) {
                successfulReservations.incrementAndGet();
            } else {
                rejectedReservations.incrementAndGet();
            }
            if (result.wrongDecision()) {
                wrongStockDecisions.incrementAndGet();
            }
            return result;
        } finally {
            inFlightRequests.decrementAndGet();
            completedRequests.incrementAndGet();
        }
    }

    private ReservationResult reserveWithStaleCache(
            String sku,
            int requested,
            String waveId,
            String requestRole,
            long requestOrdinal,
            String threadName,
            RaceWave wave) {
        int cachedStock = stockCache.getOrDefault(sku, 0);
        wave.cacheReadersReady().countDown();
        await(wave.cacheReadersReady(), "both requests did not read the cache");

        if (requestRole.equals("leader")) {
            try {
                AtomicInteger stock = authoritativeStock.get(sku);
                int authoritativeBefore = stock.get();
                boolean accepted = authoritativeBefore >= requested;
                int remaining = accepted
                        ? stock.addAndGet(-requested)
                        : authoritativeBefore;
                return new ReservationResult(
                        sku,
                        requested,
                        waveId,
                        requestRole,
                        accepted,
                        false,
                        cachedStock,
                        authoritativeBefore,
                        remaining,
                        requestOrdinal,
                        threadName);
            } finally {
                wave.leaderCommitted().countDown();
            }
        }

        await(wave.leaderCommitted(), "leader did not commit the reservation");
        int authoritativeStock = this.authoritativeStock.get(sku).get();
        boolean staleCachedStock = cachedStock > authoritativeStock;
        boolean reserveDecision = cachedStock >= requested; // LIVEPROBE_BUG_LINE
        boolean wrongDecision = reserveDecision && authoritativeStock < requested;
        int remaining = reserveDecision
                ? this.authoritativeStock.get(sku).addAndGet(-requested)
                : authoritativeStock;
        cleanupWave(waveId, wave, sku);
        return new ReservationResult(
                sku,
                requested,
                waveId,
                requestRole,
                reserveDecision,
                wrongDecision && staleCachedStock,
                cachedStock,
                authoritativeStock,
                remaining,
                requestOrdinal,
                threadName);
    }

    private ReservationResult reserveAtomically(
            String sku,
            int requested,
            String waveId,
            String requestRole,
            long requestOrdinal,
            String threadName,
            RaceWave wave) {
        AtomicInteger stock = authoritativeStock.get(sku);
        AtomicReference<ReservationDecision> decision = new AtomicReference<>();
        stock.updateAndGet(current -> {
            boolean accepted = current >= requested;
            int remaining = accepted ? current - requested : current;
            decision.set(new ReservationDecision(current, remaining, accepted));
            return remaining;
        });
        ReservationDecision result = decision.get();
        stockCache.put(sku, result.remaining());
        if (wave.finishedRequests().incrementAndGet() == 2) {
            cleanupWave(waveId, wave, sku);
        }
        return new ReservationResult(
                sku,
                requested,
                waveId,
                requestRole,
                result.accepted(),
                false,
                result.authoritativeBefore(),
                result.authoritativeBefore(),
                result.remaining(),
                requestOrdinal,
                threadName);
    }

    private void cleanupWave(String waveId, RaceWave wave, String sku) {
        if (waves.remove(waveId, wave)) {
            authoritativeStock.remove(sku);
            stockCache.remove(sku);
        }
    }

    Stats stats() {
        ArrayList<String> threads = new ArrayList<>(workerThreads);
        Collections.sort(threads);
        return new Stats(
                httpRequests.get(),
                completedHttpRequests.get(),
                inFlightHttpRequests.get(),
                totalRequests.get(),
                completedRequests.get(),
                inFlightRequests.get(),
                successfulReservations.get(),
                rejectedReservations.get(),
                wrongStockDecisions.get(),
                List.copyOf(threads));
    }

    private void await(CountDownLatch latch, String timeoutMessage) {
        try {
            if (!latch.await(raceTimeout.toMillis(), TimeUnit.MILLISECONDS)) {
                throw new IllegalStateException(timeoutMessage);
            }
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("reservation interrupted");
        }
    }

    private static void validateRequest(String sku, int requested, String waveId, String requestRole) {
        if (sku == null || sku.isBlank()) {
            throw new IllegalArgumentException("sku must not be blank");
        }
        if (requested <= 0) {
            throw new IllegalArgumentException("quantity must be positive");
        }
        if (waveId == null || waveId.isBlank()) {
            throw new IllegalArgumentException("wave must not be blank");
        }
        if (!requestRole.equals("leader") && !requestRole.equals("follower")) {
            throw new IllegalArgumentException("role must be leader or follower");
        }
    }
}

record RaceWave(
        String sku,
        CountDownLatch cacheReadersReady,
        CountDownLatch leaderCommitted,
        AtomicInteger finishedRequests) {
    RaceWave(String sku) {
        this(sku, new CountDownLatch(2), new CountDownLatch(1), new AtomicInteger());
    }

    void requireSku(String requestedSku) {
        if (!sku.equals(requestedSku)) {
            throw new IllegalArgumentException("wave must use one sku");
        }
    }
}

record ReservationDecision(int authoritativeBefore, int remaining, boolean accepted) {}

record RequestTrace(
        long ordinal,
        String method,
        String path,
        String thread,
        long startedNanos) {}

record ReservationResult(
        String sku,
        int quantity,
        String waveId,
        String role,
        boolean accepted,
        boolean wrongDecision,
        int cachedStock,
        int observedAuthoritativeStock,
        int remainingStock,
        long requestOrdinal,
        String threadName) {}

record Stats(
        long httpRequests,
        long completedHttpRequests,
        int inFlightHttpRequests,
        long totalRequests,
        long completedRequests,
        int inFlightRequests,
        long successfulReservations,
        long rejectedReservations,
        long wrongStockDecisions,
        List<String> workerThreads) {}

final class Json {
    private Json() {}

    static String object(Object... pairs) {
        if (pairs.length % 2 != 0) {
            throw new IllegalArgumentException("JSON object requires key/value pairs");
        }
        StringBuilder output = new StringBuilder("{");
        for (int index = 0; index < pairs.length; index += 2) {
            if (index > 0) {
                output.append(',');
            }
            output.append(quote(Objects.toString(pairs[index]))).append(':');
            append(output, pairs[index + 1]);
        }
        return output.append('}').toString();
    }

    private static void append(StringBuilder output, Object value) {
        if (value == null) {
            output.append("null");
        } else if (value instanceof String string) {
            output.append(quote(string));
        } else if (value instanceof Number || value instanceof Boolean) {
            output.append(value);
        } else if (value instanceof Iterable<?> iterable) {
            output.append('[');
            boolean first = true;
            for (Object item : iterable) {
                if (!first) {
                    output.append(',');
                }
                append(output, item);
                first = false;
            }
            output.append(']');
        } else {
            output.append(quote(value.toString()));
        }
    }

    private static String quote(String value) {
        StringBuilder output = new StringBuilder(value.length() + 2).append('"');
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            switch (character) {
                case '"' -> output.append("\\\"");
                case '\\' -> output.append("\\\\");
                case '\b' -> output.append("\\b");
                case '\f' -> output.append("\\f");
                case '\n' -> output.append("\\n");
                case '\r' -> output.append("\\r");
                case '\t' -> output.append("\\t");
                default -> {
                    if (character < 0x20) {
                        output.append(String.format("\\u%04x", (int) character));
                    } else {
                        output.append(character);
                    }
                }
            }
        }
        return output.append('"').toString();
    }
}
