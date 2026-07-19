import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  BrokerState,
  CreateProbeSchema,
  buildBroker,
  type ProbeDefinition,
} from "../src/index.js";

const openBrokers: Awaited<ReturnType<typeof buildBroker>>[] = [];

afterEach(async () => {
  await Promise.all(openBrokers.splice(0).map((broker) => broker.close()));
});

function createCounter(state: BrokerState, ttlSeconds = 1_800): ProbeDefinition {
  return state.createProbe(
    CreateProbeSchema.parse({
      serviceId: "orders",
      type: "counter",
      file: "src/orders.ts",
      line: 19,
      hitLimit: 10_000,
      ttlSeconds,
      createdBy: "test",
    }),
  );
}

class EventBeforeRegistrationState extends BrokerState {
  public injected = false;

  public override waitForEvents(
    probeId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ) {
    if (!this.injected) {
      this.injected = true;
      this.ingest({
        serviceId: "orders",
        sdk: "node",
        agentStatus: { state: "green" },
        events: [
          {
            probeId,
            type: "counter",
            ts: new Date().toISOString(),
            delta: 1,
          },
        ],
      });
    }
    return super.waitForEvents(probeId, timeoutMs, signal);
  }
}

describe("broker validation and storage", () => {
  it("strictly rejects malformed requests and mismatched events", async () => {
    const broker = await buildBroker();
    openBrokers.push(broker);

    const invalidCreate = await broker.inject({
      method: "POST",
      url: "/v1/probes",
      payload: {
        serviceId: "orders",
        type: "log",
        file: "src/orders.ts",
        line: 0,
        template: "order=${order.id}",
        createdBy: "test",
        unexpected: true,
      },
    });
    expect(invalidCreate.statusCode).toBe(400);
    expect(invalidCreate.json()).toMatchObject({
      error: { code: "invalid_request" },
    });

    const malformedJson = await broker.inject({
      method: "POST",
      url: "/v1/probes",
      headers: { "content-type": "application/json" },
      payload: '{"serviceId":',
    });
    expect(malformedJson.statusCode).toBe(400);
    expect(malformedJson.json()).toMatchObject({
      error: { code: "invalid_request" },
    });

    const unknownQuery = await broker.inject({
      method: "GET",
      url: "/v1/services?unexpected=true",
    });
    expect(unknownQuery.statusCode).toBe(400);

    const created = await broker.inject({
      method: "POST",
      url: "/v1/probes",
      payload: {
        serviceId: "orders",
        type: "counter",
        file: "src/orders.ts",
        line: 19,
        createdBy: "test",
      },
    });
    const probe = created.json<{ probe: ProbeDefinition }>().probe;

    const mismatched = await broker.inject({
      method: "POST",
      url: "/v1/ingest",
      payload: {
        serviceId: "orders",
        sdk: "node",
        agentStatus: { state: "green" },
        events: [
          {
            probeId: probe.id,
            type: "log",
            ts: new Date().toISOString(),
            message: "wrong event for a counter",
            level: "info",
          },
        ],
      },
    });
    expect(mismatched.statusCode).toBe(400);
    expect(mismatched.json()).toMatchObject({
      error: {
        code: "invalid_request",
        message: expect.stringContaining("does not match"),
      },
    });
  });

  it("normalizes and round-trips optional source commit metadata", async () => {
    const broker = await buildBroker();
    openBrokers.push(broker);
    const sourceCommit = "ABCDEF1234567890";

    const created = await broker.inject({
      method: "POST",
      url: "/v1/probes",
      payload: {
        serviceId: "orders",
        sourceCommit,
        type: "counter",
        file: "src/orders.ts",
        line: 19,
        createdBy: "test",
      },
    });
    expect(created.statusCode).toBe(201);
    const probe = created.json<{ probe: ProbeDefinition }>().probe;
    expect(probe.sourceCommit).toBe(sourceCommit.toLowerCase());

    const listed = await broker.inject({
      method: "GET",
      url: "/v1/probes?serviceId=orders",
    });
    expect(listed.json()).toMatchObject({
      probes: [
        {
          probe: {
            id: probe.id,
            sourceCommit: sourceCommit.toLowerCase(),
          },
        },
      ],
    });

    const data = await broker.inject({
      method: "GET",
      url: `/v1/probes/${probe.id}/data`,
    });
    expect(data.json()).toMatchObject({
      probe: { id: probe.id, sourceCommit: sourceCommit.toLowerCase() },
    });

    const polled = await broker.inject({
      method: "GET",
      url: "/v1/services/orders/probes?since=0",
    });
    expect(polled.json()).toMatchObject({
      probes: [{ id: probe.id, sourceCommit: sourceCommit.toLowerCase() }],
    });

    const invalid = await broker.inject({
      method: "POST",
      url: "/v1/probes",
      payload: {
        serviceId: "orders",
        sourceCommit: "not-a-git-object",
        type: "counter",
        file: "src/orders.ts",
        line: 19,
        createdBy: "test",
      },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it("caps each event ring at 500 oldest-first", async () => {
    const broker = await buildBroker();
    openBrokers.push(broker);
    const probe = createCounter(broker.liveprobeState);
    const timestamp = new Date().toISOString();

    const response = await broker.inject({
      method: "POST",
      url: "/v1/ingest",
      payload: {
        serviceId: "orders",
        sdk: "node",
        agentStatus: { state: "green" },
        events: Array.from({ length: 501 }, (_, index) => ({
          probeId: probe.id,
          type: "counter",
          ts: timestamp,
          delta: index + 1,
        })),
      },
    });

    expect(response.statusCode).toBe(202);
    const events = broker.liveprobeState.getEvents(probe.id);
    expect(events).toHaveLength(500);
    expect(events[0]).toMatchObject({ delta: 2 });
    expect(events[499]).toMatchObject({ delta: 501 });
  });

  it("cleans long-poll listeners on activity, timeout, abort, and disposal", async () => {
    const state = new BrokerState();
    const probe = createCounter(state);

    const activity = state.waitForActivity(probe.id, 1_000);
    expect(state.pendingLongPollCount(probe.id)).toBe(1);
    state.ingest({
      serviceId: "orders",
      sdk: "node",
      agentStatus: { state: "green" },
      events: [
        {
          probeId: probe.id,
          type: "counter",
          ts: new Date().toISOString(),
          delta: 1,
        },
      ],
    });
    await expect(activity).resolves.toBe("activity");
    expect(state.pendingLongPollCount()).toBe(0);

    await expect(state.waitForEvents(probe.id, 1_000)).resolves.toBe(
      "activity",
    );
    expect(state.pendingLongPollCount()).toBe(0);

    await expect(state.waitForActivity(probe.id, 5)).resolves.toBe("timeout");
    expect(state.pendingLongPollCount()).toBe(0);

    const abortController = new AbortController();
    const aborted = state.waitForActivity(
      probe.id,
      1_000,
      abortController.signal,
    );
    abortController.abort();
    await expect(aborted).resolves.toBe("aborted");
    expect(state.pendingLongPollCount()).toBe(0);

    const disposed = state.waitForActivity(probe.id, 1_000);
    state.dispose();
    await expect(disposed).resolves.toBe("aborted");
    expect(state.pendingLongPollCount()).toBe(0);
  });
});

describe("poll and long-poll edge cases", () => {
  it("returns the active set when an HTTP poll cursor is ahead", async () => {
    const state = new BrokerState();
    const probe = createCounter(state);
    const broker = await buildBroker({ state });
    openBrokers.push(broker);

    const current = await broker.inject({
      method: "GET",
      url: `/v1/services/orders/probes?since=${probe.version}`,
    });
    expect(current.json()).toEqual({
      version: probe.version,
      unchanged: true,
    });

    const ahead = await broker.inject({
      method: "GET",
      url: `/v1/services/orders/probes?since=${probe.version + 100}`,
    });
    expect(ahead.statusCode).toBe(200);
    expect(ahead.json()).toMatchObject({
      version: probe.version,
      probes: [{ id: probe.id }],
    });
  });

  it("does not miss an event arriving before listener registration", async () => {
    const state = new EventBeforeRegistrationState();
    const probe = createCounter(state);
    const broker = await buildBroker({ state });
    openBrokers.push(broker);

    const startedAt = Date.now();
    const response = await broker.inject({
      method: "GET",
      url: `/v1/probes/${probe.id}/data?waitSeconds=2`,
    });

    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(state.injected).toBe(true);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      events: [{ probeId: probe.id, type: "counter", delta: 1 }],
    });
    expect(state.pendingLongPollCount()).toBe(0);
  });
});

describe("TTL and configurable persistence", () => {
  it("expires probes once, advances version, and appends one status event", async () => {
    let now = Date.parse("2026-07-19T18:30:00.000Z");
    const state = new BrokerState({ clock: () => now });
    const probe = createCounter(state, 1);

    expect(state.pollProbes("orders", 0)).toMatchObject({
      version: 1,
      probes: [{ id: probe.id }],
    });
    const expiryWait = state.waitForEvents(probe.id, 1_000);
    expect(state.pendingLongPollCount(probe.id)).toBe(1);
    now += 1_001;
    expect(state.expireDueProbes()).toBe(1);
    await expect(expiryWait).resolves.toBe("activity");
    expect(state.expireDueProbes()).toBe(0);
    expect(state.pollProbes("orders", 1)).toEqual({
      version: 2,
      probes: [],
    });
    expect(state.getStatus(probe.id)).toMatchObject({ status: "expired" });
    expect(state.getEvents(probe.id)).toEqual([
      {
        probeId: probe.id,
        type: "status",
        ts: "2026-07-19T18:30:01.001Z",
        status: "expired",
      },
    ]);
    expect(state.pendingLongPollCount()).toBe(0);
  });

  it("writes and restores an explicitly configured snapshot", async () => {
    const directory = await mkdtemp(join(tmpdir(), "liveprobe-broker-"));
    const path = join(directory, "state.json");
    try {
      const first = await buildBroker({
        persistence: { path, intervalMs: 60_000 },
      });
      openBrokers.push(first);
      const created = await first.inject({
        method: "POST",
        url: "/v1/probes",
        payload: {
          serviceId: "orders",
          sourceCommit: "ABCDEF1234567890",
          type: "metric",
          file: "src/orders.ts",
          line: 20,
          metricPath: "order.total",
          createdBy: "test",
        },
      });
      expect(created.statusCode).toBe(201);
      await first.close();
      openBrokers.splice(openBrokers.indexOf(first), 1);

      const restored = await buildBroker({
        persistence: { path, intervalMs: 60_000 },
      });
      openBrokers.push(restored);
      const listed = await restored.inject({
        method: "GET",
        url: "/v1/probes?serviceId=orders",
      });
      expect(listed.json()).toMatchObject({
        probes: [
          {
            probe: {
              sourceCommit: "abcdef1234567890",
            },
          },
        ],
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
