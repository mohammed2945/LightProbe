import { setTimeout as delay } from "node:timers/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildBroker,
  type ProbeEvent,
} from "../../broker/src/index.js";
import { FakeAgent } from "../../broker/src/fake-agent.js";
import {
  BrokerClient,
  createMcpServer,
  createToolHandlers,
} from "../src/index.js";

const openBrokers: Awaited<ReturnType<typeof buildBroker>>[] = [];
const DEPLOYED_COMMIT = "ABCDEF1234567890";
const NORMALIZED_COMMIT = DEPLOYED_COMMIT.toLowerCase();

afterEach(async () => {
  await Promise.all(openBrokers.splice(0).map((broker) => broker.close()));
});

async function startBroker(): Promise<{
  broker: Awaited<ReturnType<typeof buildBroker>>;
  brokerUrl: string;
}> {
  const broker = await buildBroker({ ttlSweepIntervalMs: 25 });
  openBrokers.push(broker);
  await broker.listen({ host: "127.0.0.1", port: 0 });
  const address = broker.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected broker to listen on a TCP port");
  }
  return {
    broker,
    brokerUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("condition was not met before timeout");
    }
    await delay(5);
  }
}

function dataEvents(events: Record<string, unknown>[]): ProbeEvent[] {
  return events.filter(
    (event) => event["type"] !== "status",
  ) as ProbeEvent[];
}

describe("Phase 1 MCP and fake-agent integration", () => {
  it("creates every probe type and exposes status transitions and data", async () => {
    const { broker, brokerUrl } = await startBroker();
    const handlers = createToolHandlers(new BrokerClient(brokerUrl));
    const fakeAgent = new FakeAgent({
      brokerUrl,
      serviceId: "checkout",
      pollIntervalMs: 10,
    });

    const snapshot = await handlers.set_snapshot_probe({
      service_id: "checkout",
      commit_hash: DEPLOYED_COMMIT,
      file: "src/checkout.ts",
      line: 20,
      watch_paths: ["cart.total"],
      hit_limit: 1,
    });
    const log = await handlers.set_log_probe({
      service_id: "checkout",
      commit_hash: DEPLOYED_COMMIT,
      file: "src/checkout.ts",
      line: 21,
      template: "total=${cart.total}",
      hit_limit: 1,
    });
    const counter = await handlers.set_counter_probe({
      service_id: "checkout",
      commit_hash: DEPLOYED_COMMIT,
      file: "src/checkout.ts",
      line: 22,
      hit_limit: 1,
    });
    const metric = await handlers.set_metric_probe({
      service_id: "checkout",
      commit_hash: DEPLOYED_COMMIT,
      file: "src/checkout.ts",
      line: 23,
      metric_path: "cart.total",
      hit_limit: 1,
    });

    expect([snapshot.type, log.type, counter.type, metric.type]).toEqual([
      "snapshot",
      "log",
      "counter",
      "metric",
    ]);
    expect(
      [snapshot, log, counter, metric].map((probe) => probe.sourceCommit),
    ).toEqual(Array.from({ length: 4 }, () => NORMALIZED_COMMIT));

    const longPollStartedAt = Date.now();
    const pendingData = handlers.get_probe_data({
      probe_id: snapshot.id,
      wait_seconds: 2,
    });
    await waitUntil(
      () => broker.liveprobeState.pendingLongPollCount(snapshot.id) === 1,
    );

    const armedTick = await fakeAgent.tick();
    expect(armedTick.armed).toHaveLength(4);
    const firstLongPoll = await pendingData;
    expect(Date.now() - longPollStartedAt).toBeLessThan(3_000);
    expect(firstLongPoll.events).toContainEqual(
      expect.objectContaining({ type: "status", status: "armed" }),
    );
    expect(broker.liveprobeState.pendingLongPollCount()).toBe(0);

    const armedList = await handlers.list_probes({
      service_id: "checkout",
    });
    expect(
      armedList.probes.map((entry) => entry.status?.status),
    ).toEqual(["armed", "armed", "armed", "armed"]);
    expect(
      armedList.probes.map((entry) => entry.probe.sourceCommit),
    ).toEqual(Array.from({ length: 4 }, () => NORMALIZED_COMMIT));

    const emittedTick = await fakeAgent.tick();
    expect(emittedTick.emitted).toHaveLength(4);

    const probes = [snapshot, log, counter, metric];
    for (const probe of probes) {
      const result = await handlers.get_probe_data({
        probe_id: probe.id,
      });
      expect(result.probe.sourceCommit).toBe(NORMALIZED_COMMIT);
      expect(dataEvents(result.events)).toContainEqual(
        expect.objectContaining({ type: probe.type }),
      );
    }

    const completedList = await handlers.list_probes({
      service_id: "checkout",
    });
    expect(
      completedList.probes.map((entry) => entry.status?.status),
    ).toEqual([
      "hit-limit-reached",
      "hit-limit-reached",
      "hit-limit-reached",
      "hit-limit-reached",
    ]);

    const services = await handlers.list_services();
    expect(services.services).toEqual([
      expect.objectContaining({
        serviceId: "checkout",
        sdk: "node",
        agentStatus: expect.objectContaining({ state: "green" }),
      }),
    ]);

    await expect(
      handlers.remove_probe({ probe_id: log.id }),
    ).resolves.toEqual({ removed: true, probeId: log.id });
    const afterRemoval = await handlers.list_probes({
      service_id: "checkout",
    });
    expect(afterRemoval.probes).toHaveLength(3);
  });

  it("validates tool inputs and cleans timeout listeners", async () => {
    const { broker, brokerUrl } = await startBroker();
    const handlers = createToolHandlers(new BrokerClient(brokerUrl));

    await expect(
      handlers.set_counter_probe({
        service_id: "checkout",
        commit_hash: DEPLOYED_COMMIT,
        file: "src/checkout.ts",
        line: 0,
      }),
    ).rejects.toThrow();
    await expect(
      handlers.set_counter_probe({
        service_id: "checkout",
        commit_hash: DEPLOYED_COMMIT,
        file: "src/checkout.ts",
        line: 20,
        unexpected: true,
      } as never),
    ).rejects.toThrow();

    const probe = await handlers.set_counter_probe({
      service_id: "checkout",
      commit_hash: DEPLOYED_COMMIT,
      file: "src/checkout.ts",
      line: 20,
    });
    const pending = handlers.get_probe_data({
      probe_id: probe.id,
      wait_seconds: 0.02,
    });
    await waitUntil(
      () => broker.liveprobeState.pendingLongPollCount(probe.id) === 1,
    );
    await expect(pending).resolves.toMatchObject({ events: [] });
    expect(broker.liveprobeState.pendingLongPollCount()).toBe(0);
  });

  it("requires and validates a deployed commit hash for every set tool", async () => {
    const { brokerUrl } = await startBroker();
    const handlers = createToolHandlers(new BrokerClient(brokerUrl));
    const tools: Array<{
      call: (input: Record<string, unknown>) => Promise<unknown>;
      input: Record<string, unknown>;
    }> = [
      {
        call: (input) => handlers.set_snapshot_probe(input as never),
        input: {
          service_id: "checkout",
          commit_hash: DEPLOYED_COMMIT,
          file: "src/checkout.ts",
          line: 20,
        },
      },
      {
        call: (input) => handlers.set_log_probe(input as never),
        input: {
          service_id: "checkout",
          commit_hash: DEPLOYED_COMMIT,
          file: "src/checkout.ts",
          line: 21,
          template: "checkout",
        },
      },
      {
        call: (input) => handlers.set_counter_probe(input as never),
        input: {
          service_id: "checkout",
          commit_hash: DEPLOYED_COMMIT,
          file: "src/checkout.ts",
          line: 22,
        },
      },
      {
        call: (input) => handlers.set_metric_probe(input as never),
        input: {
          service_id: "checkout",
          commit_hash: DEPLOYED_COMMIT,
          file: "src/checkout.ts",
          line: 23,
          metric_path: "cart.total",
        },
      },
    ];

    for (const tool of tools) {
      const missing = { ...tool.input };
      delete missing["commit_hash"];
      await expect(tool.call(missing)).rejects.toThrow();
      for (const invalid of [
        "abc123",
        "not-a-git-object",
        "a".repeat(65),
      ]) {
        await expect(
          tool.call({ ...tool.input, commit_hash: invalid }),
        ).rejects.toThrow();
      }
    }
  });

  it("publishes exactly the eight official MCP tools", async () => {
    const { brokerUrl } = await startBroker();
    const server = createMcpServer(new BrokerClient(brokerUrl));
    const client = new Client(
      { name: "liveprobe-integration-test", version: "1.0.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        "get_probe_data",
        "list_probes",
        "list_services",
        "remove_probe",
        "set_counter_probe",
        "set_log_probe",
        "set_metric_probe",
        "set_snapshot_probe",
      ]);
      for (const tool of tools.tools.filter(({ name }) =>
        name.startsWith("set_"),
      )) {
        expect(
          (tool.inputSchema as { required?: string[] }).required,
        ).toContain("commit_hash");
        expect(tool.description).toContain("ask the user");
        expect(tool.description).toContain("exists in the local repository");
        expect(tool.description).toContain("exact revision");
        expect(tool.description).toContain("user-supplied audit metadata");
        expect(tool.description).toContain("not runtime proof");
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});
