package io.liveprobe.demo.inventory;

import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

final class InventoryEngineTest {
    @Test
    void bugModeDeterministicallyOversellsFromStaleCache() throws Exception {
        InventoryEngine engine = new InventoryEngine(true, Duration.ofSeconds(2));

        List<ReservationResult> results = runPair(engine, "bug-wave");
        ReservationResult leader = resultForRole(results, "leader");
        ReservationResult follower = resultForRole(results, "follower");

        assertTrue(leader.accepted());
        assertFalse(leader.wrongDecision());
        assertTrue(follower.accepted());
        assertTrue(follower.wrongDecision());
        assertEquals(1, follower.cachedStock());
        assertEquals(0, follower.observedAuthoritativeStock());
        assertEquals(-1, follower.remainingStock());
        assertEquals(2, engine.stats().totalRequests());
        assertEquals(2, engine.stats().completedRequests());
        assertEquals(2, engine.stats().successfulReservations());
        assertEquals(0, engine.stats().rejectedReservations());
        assertEquals(1, engine.stats().wrongStockDecisions());
    }

    @Test
    void fixedModeMakesOneAtomicReservationAndRejectsTheOther() throws Exception {
        InventoryEngine engine = new InventoryEngine(false, Duration.ofSeconds(2));

        List<ReservationResult> results = runPair(engine, "fixed-wave");

        assertEquals(1, results.stream().filter(ReservationResult::accepted).count());
        assertEquals(1, results.stream().filter(result -> !result.accepted()).count());
        assertTrue(results.stream().noneMatch(ReservationResult::wrongDecision));
        assertTrue(results.stream().allMatch(result ->
                result.cachedStock() == result.observedAuthoritativeStock()));
        assertEquals(2, engine.stats().totalRequests());
        assertEquals(2, engine.stats().completedRequests());
        assertEquals(1, engine.stats().successfulReservations());
        assertEquals(1, engine.stats().rejectedReservations());
        assertEquals(0, engine.stats().wrongStockDecisions());
    }

    private static List<ReservationResult> runPair(InventoryEngine engine, String wave) throws Exception {
        ExecutorService executor = Executors.newFixedThreadPool(2);
        try {
            Future<ReservationResult> follower =
                    executor.submit(() -> engine.reserve("widget", 1, wave, "follower"));
            Future<ReservationResult> leader =
                    executor.submit(() -> engine.reserve("widget", 1, wave, "leader"));
            return List.of(
                    follower.get(3, TimeUnit.SECONDS),
                    leader.get(3, TimeUnit.SECONDS));
        } finally {
            executor.shutdownNow();
            executor.awaitTermination(3, TimeUnit.SECONDS);
        }
    }

    private static ReservationResult resultForRole(
            List<ReservationResult> results,
            String role) {
        return results.stream()
                .filter(result -> result.role().equals(role))
                .findFirst()
                .orElseThrow();
    }
}
