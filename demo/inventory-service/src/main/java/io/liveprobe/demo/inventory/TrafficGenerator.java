package io.liveprobe.demo.inventory;

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

/** Continuously drives deterministic two-request reserve races. */
public final class TrafficGenerator {
    private TrafficGenerator() {}

    public static void main(String[] args) throws Exception {
        String baseUrl = stripTrailingSlash(env("TARGET_URL", "http://127.0.0.1:8080"));
        long intervalMillis = positiveLong(env("INTERVAL_MS", "75"), "INTERVAL_MS");
        long startDelayMillis = nonNegativeLong(env("START_DELAY_MS", "0"), "START_DELAY_MS");
        long durationSeconds = nonNegativeLong(env("DURATION_SECONDS", "0"), "DURATION_SECONDS");
        long maxWaves = nonNegativeLong(env("WAVES", "0"), "WAVES");

        ExecutorService executor = Executors.newFixedThreadPool(8);
        HttpClient client = HttpClient.newBuilder()
                .executor(executor)
                .connectTimeout(Duration.ofSeconds(3))
                .build();
        AtomicLong waveSequence = new AtomicLong();

        if (startDelayMillis > 0) {
            Thread.sleep(startDelayMillis);
        }
        waitUntilHealthy(client, baseUrl);
        Instant deadline = durationSeconds == 0
                ? Instant.MAX
                : Instant.now().plusSeconds(durationSeconds);
        System.out.printf(
                "[traffic] target=%s intervalMs=%d waves=%s durationSeconds=%s%n",
                baseUrl,
                intervalMillis,
                maxWaves == 0 ? "unbounded" : Long.toString(maxWaves),
                durationSeconds == 0 ? "unbounded" : Long.toString(durationSeconds));

        Runtime.getRuntime().addShutdownHook(new Thread(executor::shutdownNow, "traffic-shutdown"));
        try {
            while ((maxWaves == 0 || waveSequence.get() < maxWaves)
                    && Instant.now().isBefore(deadline)
                    && !Thread.currentThread().isInterrupted()) {
                long sequence = waveSequence.incrementAndGet();
                String wave = "wave-" + sequence;
                String sku = "widget-" + sequence;
                CompletableFuture<HttpResponse<String>> leader =
                        sendReservation(client, baseUrl, sku, wave, "leader");
                CompletableFuture<HttpResponse<String>> follower =
                        sendReservation(client, baseUrl, sku, wave, "follower");
                try {
                    CompletableFuture.allOf(leader, follower).join();
                    HttpResponse<String> leaderResponse = leader.join();
                    HttpResponse<String> followerResponse = follower.join();
                    System.out.printf(
                            "[traffic] wave=%s leader=%d follower=%d completedPairs=%d%n",
                            wave,
                            leaderResponse.statusCode(),
                            followerResponse.statusCode(),
                            sequence);
                } catch (RuntimeException exception) {
                    System.err.printf(
                            "[traffic] wave=%s failed=%s%n",
                            wave,
                            safeMessage(exception));
                }
                Thread.sleep(intervalMillis);
            }
        } finally {
            executor.shutdownNow();
            executor.awaitTermination(5, TimeUnit.SECONDS);
        }
    }

    private static CompletableFuture<HttpResponse<String>> sendReservation(
            HttpClient client,
            String baseUrl,
            String sku,
            String wave,
            String role) {
        String query = "sku=" + encode(sku)
                + "&quantity=1"
                + "&wave=" + encode(wave)
                + "&role=" + encode(role);
        HttpRequest request = HttpRequest.newBuilder(URI.create(baseUrl + "/reserve?" + query))
                .timeout(Duration.ofSeconds(10))
                .header("Accept", "application/json")
                .POST(HttpRequest.BodyPublishers.noBody())
                .build();
        return client.sendAsync(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
    }

    private static void waitUntilHealthy(HttpClient client, String baseUrl) throws InterruptedException {
        HttpRequest request = HttpRequest.newBuilder(URI.create(baseUrl + "/health"))
                .timeout(Duration.ofSeconds(2))
                .header("Accept", "application/json")
                .GET()
                .build();
        for (int attempt = 1; attempt <= 60; attempt++) {
            try {
                HttpResponse<Void> response = client.send(request, HttpResponse.BodyHandlers.discarding());
                if (response.statusCode() == 200) {
                    return;
                }
            } catch (Exception ignored) {
                // The target may still be starting.
            }
            Thread.sleep(500);
        }
        throw new IllegalStateException("inventory service did not become healthy within 30 seconds");
    }

    private static String encode(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8).replace("+", "%20");
    }

    private static String env(String name, String fallback) {
        String value = System.getenv(name);
        return value == null || value.isBlank() ? fallback : value;
    }

    private static long positiveLong(String value, String name) {
        long parsed = nonNegativeLong(value, name);
        if (parsed == 0) {
            throw new IllegalArgumentException(name + " must be positive");
        }
        return parsed;
    }

    private static long nonNegativeLong(String value, String name) {
        try {
            long parsed = Long.parseLong(value);
            if (parsed < 0) {
                throw new NumberFormatException();
            }
            return parsed;
        } catch (NumberFormatException exception) {
            throw new IllegalArgumentException(name + " must be a non-negative integer");
        }
    }

    private static String stripTrailingSlash(String value) {
        String normalized = value;
        while (normalized.endsWith("/")) {
            normalized = normalized.substring(0, normalized.length() - 1);
        }
        return normalized;
    }

    private static String safeMessage(Throwable throwable) {
        Throwable current = throwable;
        while (current.getCause() != null) {
            current = current.getCause();
        }
        String message = current.getMessage();
        return message == null || message.isBlank()
                ? current.getClass().getSimpleName()
                : message;
    }
}
