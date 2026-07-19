import { describe, expect, it } from "vitest";

import { normalizeScriptPath, ScriptRegistry } from "../src/script-registry.js";

describe("ScriptRegistry", () => {
  it("matches file URLs by decoded path suffix", () => {
    const registry = new ScriptRegistry();
    registry.register({
      scriptId: "17",
      url: "file:///srv/payment%20service/dist/src/payments.js",
    });

    expect(registry.findBySuffix("src/payments.js")).toMatchObject({
      scriptId: "17",
      url: "file:///srv/payment%20service/dist/src/payments.js",
      path: "/srv/payment service/dist/src/payments.js",
    });
  });

  it("uses path boundaries and handles bundler URLs", () => {
    const registry = new ScriptRegistry();
    registry.register({ scriptId: "wrong", url: "webpack:///src/notpayments.js" });
    registry.register({ scriptId: "right", url: "webpack:///src/payments.js?cache=1" });

    expect(registry.findBySuffix("payments.js")?.scriptId).toBe("right");
    expect(registry.findBySuffix("other/payments.js")).toBeUndefined();
  });

  it("rejects equally specific suffix collisions", () => {
    const registry = new ScriptRegistry();
    registry.register({ scriptId: "one", url: "file:///srv/a/src/payments.js" });
    registry.register({ scriptId: "two", url: "file:///srv/b/src/payments.js" });

    expect(registry.findBySuffix("src/payments.js")).toBeUndefined();
    expect(registry.resolveBySuffix("src/payments.js")).toEqual({
      status: "ambiguous",
      matches: [
        {
          scriptId: "one",
          url: "file:///srv/a/src/payments.js",
          path: "/srv/a/src/payments.js",
        },
        {
          scriptId: "two",
          url: "file:///srv/b/src/payments.js",
          path: "/srv/b/src/payments.js",
        },
      ],
    });
  });

  it("normalizes Windows separators", () => {
    expect(normalizeScriptPath("C:\\app\\src\\index.js")).toBe("C:/app/src/index.js");
  });
});
