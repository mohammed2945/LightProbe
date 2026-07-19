# Inventory service concurrency demo

A self-contained Java 17+ Javalin service that demonstrates a deterministic
stale-cache reservation bug. The Maven build emits full line, variable, and
source debug symbols.

## Behavior

Each traffic wave starts with one authoritative unit and sends a concurrent
`leader` and `follower` reservation:

- `BUG=on`: both requests first read cached stock `1`. The leader consumes the
  authoritative unit, then the follower deliberately decides from its stale
  cached value. Both requests are accepted, authoritative stock reaches `-1`,
  and `wrongStockDecisions` increments.
- `BUG=off`: both requests decide with an atomic authoritative-stock operation.
  Exactly one request is accepted, stock never becomes negative, and
  `wrongStockDecisions` stays at zero.

The follower is held behind explicit latches, so this outcome does not depend on
thread scheduling or sleeps.

## Build, test, and run

Requirements: JDK 17+, Maven 3.9+, and curl for the smoke test.

```sh
make validate
make test
make run
```

In a second terminal, run a finite deterministic traffic batch:

```sh
WAVES=10 make traffic
```

Use `BUG=off java -jar target/inventory-service.jar` to run the corrected mode.

## HTTP API

- `GET /health` reports health and the selected bug mode.
- `POST /reserve?sku=widget&quantity=1&wave=w1&role=leader`
- `POST /reserve?sku=widget&quantity=1&wave=w1&role=follower`
- `GET /stats` reports HTTP, reservation, in-flight, success, rejection,
  wrong-decision, and worker-thread counters.

The two reservation requests for a wave must be concurrent.
`TrafficGenerator` handles that pairing and uses a unique SKU for each wave.
Request logs have stable `[request]` and `[reservation]` prefixes.

## Smoke test

```sh
make smoke
```

The smoke script starts the packaged app on loopback, drives six waves through
the Java traffic generator, and proves that completed reservation and
wrong-decision counters advance. `make e2e` is a compatibility alias for the
same local-only check. Neither command contacts a remote service.

## Docker

```sh
docker build -t inventory-service .
docker network create --internal inventory-demo
docker run --rm --network inventory-demo --name inventory inventory-service
```

The multi-stage image runs on Java 17. JVM diagnostics are disabled by default.
For local container-to-container diagnostics on an internal Docker network:

```sh
docker run --rm --network inventory-demo \
  --env ENABLE_INTERNAL_JDWP=true \
  --env INTERNAL_JDWP_PORT=5005 \
  --name inventory inventory-service
```

The Dockerfile does not expose the diagnostic port, and no command in this
directory publishes it to the host. Never add a host publication for that port.

## Stable source location

The intentional decision is the single source line marked
`LIVEPROBE_BUG_LINE` in:

`src/main/java/io/liveprobe/demo/inventory/InventoryService.java`

The cached value, authoritative value, wave, role, and request ordinal remain
local variables around that line. `make validate` checks the layout, endpoint
surface, debug metadata, optional diagnostic configuration, and smoke-test
shape without requiring dependency resolution.
