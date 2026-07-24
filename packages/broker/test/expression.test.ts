import { describe, expect, it } from "vitest";

import {
  BrokerState,
  CreateProbeSchema,
  compileExpression,
  compileTemplate,
} from "../src/index.js";

function capableState(): BrokerState {
  const state = new BrokerState();
  state.ingest({
    serviceId: "orders",
    sdk: "node",
    commitSha: "abcdef1234567890",
    commitSource: "config",
    capabilities: ["expression-ast-v1", "frame-locals-v1"],
    agentStatus: { state: "green" },
    events: [],
  });
  return state;
}

describe("safe expression compiler", () => {
  it("compiles fixed references, arithmetic, comparison, and boolean logic", () => {
    expect(
      compileExpression(
        '(order.total - order["discount"]) >= 100 && user.active == true',
      ),
    ).toEqual({
      source:
        '(order.total - order["discount"]) >= 100 && user.active == true',
      ast: {
        type: "binary",
        operator: "and",
        left: {
          type: "binary",
          operator: "gte",
          left: {
            type: "binary",
            operator: "subtract",
            left: { type: "reference", path: ["order", "total"] },
            right: { type: "reference", path: ["order", "discount"] },
          },
          right: { type: "literal", value: 100 },
        },
        right: {
          type: "binary",
          operator: "eq",
          left: { type: "reference", path: ["user", "active"] },
          right: { type: "literal", value: true },
        },
      },
    });
  });

  it("supports fixed array indices and unary operators", () => {
    expect(compileExpression("!items[0].disabled || -balance < 0")).toMatchObject({
      ast: {
        type: "binary",
        operator: "or",
        left: {
          type: "unary",
          operator: "not",
          operand: {
            type: "reference",
            path: ["items", 0, "disabled"],
          },
        },
      },
    });
  });

  it.each([
    "user.isAdmin()",
    "items[index]",
    "user.constructor",
    "user.__proto__.admin",
    "this.user",
    "new User()",
    "value = 1",
    "user?.tier",
    "/secret/",
  ])("rejects executable or dynamic syntax: %s", (source) => {
    expect(() => compileExpression(source)).toThrow(/invalid safe expression/);
  });

  it("leaves legacy dot-path templates unchanged and compiles advanced ones", () => {
    expect(compileTemplate("user=${user.id}")).toBeUndefined();
    expect(compileTemplate("net=${order.total - order.discount}")).toEqual([
      { type: "text", value: "net=" },
      {
        type: "expression",
        expression: {
          source: "order.total - order.discount",
          ast: {
            type: "binary",
            operator: "subtract",
            left: { type: "reference", path: ["order", "total"] },
            right: { type: "reference", path: ["order", "discount"] },
          },
        },
      },
    ]);
  });

  it("compiles probe expressions only for capable services", () => {
    const input = CreateProbeSchema.parse({
      serviceId: "orders",
      type: "metric",
      file: "src/orders.ts",
      line: 19,
      metricExpression: "endedAt - startedAt",
      createdBy: "test",
    });

    expect(() => new BrokerState().createProbe(input)).toThrow(
      /does not report expression-ast-v1/,
    );
    expect(capableState().createProbe(input)).toMatchObject({
      type: "metric",
      metricExpression: {
        source: "endedAt - startedAt",
        ast: { type: "binary", operator: "subtract" },
      },
    });
  });

  it("requires one metric source and mutually exclusive conditions", () => {
    const state = capableState();
    expect(() =>
      state.createProbe(
        CreateProbeSchema.parse({
          serviceId: "orders",
          type: "metric",
          file: "src/orders.ts",
          line: 19,
          createdBy: "test",
        }),
      ),
    ).toThrow(/exactly one/);

    expect(() =>
      state.createProbe(
        CreateProbeSchema.parse({
          serviceId: "orders",
          type: "counter",
          file: "src/orders.ts",
          line: 19,
          condition: { path: "user.tier", op: "eq", value: "paid" },
          conditionExpression: 'user.tier == "paid"',
          createdBy: "test",
        }),
      ),
    ).toThrow(/mutually exclusive/);
  });

  it("gates per-frame locals on an explicit agent capability", () => {
    const input = CreateProbeSchema.parse({
      serviceId: "orders",
      type: "snapshot",
      file: "src/orders.ts",
      line: 19,
      includeStackLocals: true,
      stackFrameLimit: 2,
      createdBy: "test",
    });
    expect(() => new BrokerState().createProbe(input)).toThrow(
      /does not report frame-locals-v1/,
    );
    expect(capableState().createProbe(input)).toMatchObject({
      includeStackLocals: true,
      stackFrameLimit: 2,
    });
  });

  it("uses the capability intersection across active agent replicas", () => {
    let now = Date.parse("2026-07-23T12:00:00.000Z");
    const state = new BrokerState({ clock: () => now });
    const heartbeat = (
      agentId: string,
      capabilities: string[],
    ): void => {
      state.ingest({
        serviceId: "orders",
        sdk: "node",
        agentId,
        commitSha: "abcdef1234567890",
        commitSource: "config",
        capabilities,
        agentStatus: { state: "green" },
        events: [],
      });
    };
    heartbeat("legacy-replica", []);
    heartbeat("upgraded-replica", [
      "log-levels-v1",
      "expression-ast-v1",
      "frame-locals-v1",
      "future-capability-v2",
    ]);

    expect(state.listServices()[0]?.capabilities).toEqual([]);
    expect(() =>
      state.createProbe(
        CreateProbeSchema.parse({
          serviceId: "orders",
          type: "metric",
          file: "src/orders.ts",
          line: 19,
          metricExpression: "endedAt - startedAt",
          createdBy: "test",
        }),
      ),
    ).toThrow(/does not report expression-ast-v1/);

    now += 45_001;
    heartbeat("upgraded-replica", [
      "log-levels-v1",
      "expression-ast-v1",
      "frame-locals-v1",
      "future-capability-v2",
    ]);
    expect(state.listServices()[0]?.capabilities).toEqual([
      "log-levels-v1",
      "expression-ast-v1",
      "frame-locals-v1",
      "future-capability-v2",
    ]);
    expect(
      state.createProbe(
        CreateProbeSchema.parse({
          serviceId: "orders",
          type: "metric",
          file: "src/orders.ts",
          line: 19,
          metricExpression: "endedAt - startedAt",
          createdBy: "test",
        }),
      ),
    ).toMatchObject({ type: "metric" });
  });

  it("does not trust persisted capabilities before a live heartbeat", () => {
    const first = capableState();
    const restored = new BrokerState();

    restored.loadSnapshot(first.snapshot());

    expect(restored.listServices()[0]?.capabilities).toEqual([]);
  });
});
