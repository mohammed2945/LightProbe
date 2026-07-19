import { describe, expect, it } from "vitest";

import { BrokerClient } from "../src/broker-client.js";
import type { AgentEvent, ProbeDefinition } from "../src/types.js";

const probe: ProbeDefinition = {
  id: "prb_1",
  serviceId: "payments/api",
  sourceCommit: "abcdef1234567890",
  type: "snapshot",
  file: "src/payments.js",
  line: 34,
  watchPaths: ["user.tier"],
  hitLimit: 1,
  ttlSeconds: 1800,
  version: 2,
  createdBy: "mcp:test",
};

describe("BrokerClient", () => {
  it("uses the documented poll URL and parses complete snapshots", async () => {
    let requested = "";
    const client = new BrokerClient("http://broker:7070", {
      fetch: (async (input: URL) => {
        requested = input.toString();
        return new Response(JSON.stringify({ version: 2, probes: [probe] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as never,
    });

    await expect(client.poll("payments/api", 1)).resolves.toEqual({
      version: 2,
      probes: [probe],
    });
    expect(requested).toBe("http://broker:7070/v1/services/payments%2Fapi/probes?since=1");
  });

  it("sends the exact ingest envelope", async () => {
    let body: unknown;
    let method = "";
    const client = new BrokerClient("https://broker.example/base", {
      fetch: (async (_input: URL, init: { body: string; method: string }) => {
        method = init.method;
        body = JSON.parse(init.body);
        return new Response(null, { status: 202 });
      }) as never,
    });
    const events: AgentEvent[] = [
      {
        probeId: "prb_1",
        type: "counter",
        ts: "2026-07-19T18:30:02.000Z",
        delta: 4,
      },
    ];

    await client.ingest("payments", { state: "green", detail: "1 probe armed" }, events);

    expect(method).toBe("POST");
    expect(body).toEqual({
      serviceId: "payments",
      sdk: "node",
      agentStatus: { state: "green", detail: "1 probe armed" },
      events,
    });
  });

  it("rejects malformed definitions instead of installing them", async () => {
    const client = new BrokerClient("http://broker", {
      fetch: (async () =>
        new Response(JSON.stringify({ version: 1, probes: [{ id: "bad" }] }), {
          status: 200,
        })) as never,
    });

    await expect(client.poll("payments", 0)).rejects.toThrow("invalid probe definition");
  });

  it("rejects non-http broker URLs", () => {
    expect(() => new BrokerClient("file:///tmp/broker")).toThrow("http or https");
  });
});
