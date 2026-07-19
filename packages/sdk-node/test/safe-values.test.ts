import { describe, expect, it } from "vitest";

import {
  matchesCondition,
  renderTemplate,
  resolveDotPath,
} from "../src/safe-values.js";

describe("safe dot paths", () => {
  it("resolves own data properties and array indices", () => {
    const value = { user: { tiers: ["free", "pro"] } };
    expect(resolveDotPath(value, "user.tiers.1")).toEqual({ found: true, value: "pro" });
    expect(resolveDotPath(value, "user.missing")).toEqual({ found: false });
  });

  it("does not walk prototypes or invoke accessors", () => {
    let calls = 0;
    const prototype = { inherited: "no" };
    const value = Object.create(prototype) as Record<string, unknown>;
    Object.defineProperty(value, "danger", {
      enumerable: true,
      get() {
        calls += 1;
        return "executed";
      },
    });

    expect(resolveDotPath(value, "inherited")).toEqual({ found: false });
    expect(resolveDotPath(value, "danger")).toEqual({ found: false });
    expect(resolveDotPath(value, "__proto__.inherited")).toEqual({ found: false });
    expect(calls).toBe(0);
  });
});

describe("conditions", () => {
  const root = { user: { tier: "free", score: 10, active: true, empty: null } };

  it.each([
    ["eq", "tier", "free", true],
    ["ne", "tier", "pro", true],
    ["gt", "score", 9, true],
    ["gte", "score", 10, true],
    ["lt", "score", 11, true],
    ["lte", "score", 10, true],
  ] as const)("supports %s", (op, key, value, expected) => {
    expect(matchesCondition(root, { path: `user.${key}`, op, value })).toBe(expected);
  });

  it("makes missing and invalid ordering operands false, including ne", () => {
    expect(matchesCondition(root, { path: "user.missing", op: "ne", value: "x" })).toBe(
      false,
    );
    expect(matchesCondition(root, { path: "user.tier", op: "gt", value: "a" })).toBe(false);
  });
});

describe("templates", () => {
  it("interpolates primitives without stringifying or executing objects", () => {
    expect(
      renderTemplate("tier=${user.tier} obj=${user} no=${missing}", {
        user: { tier: "free" },
      }),
    ).toBe("tier=free obj=[object] no=[unavailable]");
  });

  it("supports redaction hooks and output caps", () => {
    expect(
      renderTemplate("token=${auth.token}", { auth: { token: "secret" } }, {
        maxLength: 15,
        shouldRedact: (path) => path.endsWith("token"),
      }),
    ).toBe("token=[REDACTED");
  });
});
