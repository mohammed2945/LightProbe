import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  evaluateExpression,
  isCompiledExpression,
  renderExpressionTemplate,
} from "../src/safe-expression.js";
import type { CompiledExpression } from "../src/types.js";

const arithmetic: CompiledExpression = {
  source: "(order.total - order.discount) / 2",
  ast: {
    type: "binary",
    operator: "divide",
    left: {
      type: "binary",
      operator: "subtract",
      left: { type: "reference", path: ["order", "total"] },
      right: { type: "reference", path: ["order", "discount"] },
    },
    right: { type: "literal", value: 2 },
  },
};

describe("portable safe expressions", () => {
  it("matches the shared cross-runtime evaluator fixtures", async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL(
          "../../../spec/fixtures/expressions/evaluator.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as {
      cases: Array<{
        root: unknown;
        expression: CompiledExpression;
        expected: unknown;
      }>;
    };
    for (const testCase of fixture.cases) {
      expect(evaluateExpression(testCase.expression, testCase.root)).toEqual(
        testCase.expected,
      );
    }
  });

  it("evaluates bounded arithmetic and strict booleans", () => {
    expect(
      evaluateExpression(arithmetic, {
        order: { total: 120, discount: 20 },
      }),
    ).toEqual({ ok: true, value: 50 });
    expect(
      evaluateExpression(
        {
          source: "active && score >= 10",
          ast: {
            type: "binary",
            operator: "and",
            left: { type: "reference", path: ["active"] },
            right: {
              type: "binary",
              operator: "gte",
              left: { type: "reference", path: ["score"] },
              right: { type: "literal", value: 10 },
            },
          },
        },
        { active: true, score: 12 },
      ),
    ).toEqual({ ok: true, value: true });
  });

  it("does not walk prototypes or invoke accessors", () => {
    let calls = 0;
    const value = Object.create({ inherited: 1 }) as Record<string, unknown>;
    Object.defineProperty(value, "danger", {
      get() {
        calls += 1;
        return 1;
      },
    });
    expect(
      evaluateExpression(
        {
          source: "danger",
          ast: { type: "reference", path: ["danger"] },
        },
        value,
      ),
    ).toEqual({ ok: false, error: "missing" });
    expect(calls).toBe(0);
  });

  it("honors redacted keys and values", () => {
    const expression: CompiledExpression = {
      source: "password",
      ast: { type: "reference", path: ["password"] },
    };
    expect(
      evaluateExpression(expression, { password: "secret" }, {
        isRedactedKey: (key) => key === "password",
      }),
    ).toEqual({ ok: false, error: "redacted" });
    expect(
      renderExpressionTemplate(
        [{ type: "expression", expression }],
        { password: "secret" },
        4_096,
        { isRedactedValue: (value) => value === "secret" },
      ),
    ).toBe("<expression-error:redacted>");
    expect(
      evaluateExpression(
        {
          source: '"sec" + "ret"',
          ast: {
            type: "binary",
            operator: "add",
            left: { type: "literal", value: "sec" },
            right: { type: "literal", value: "ret" },
          },
        },
        {},
        { isRedactedValue: (value) => value === "secret" },
      ),
    ).toEqual({ ok: false, error: "redacted" });
  });

  it("rejects malformed or dangerous broker ASTs", () => {
    expect(
      isCompiledExpression({
        source: "user.constructor",
        ast: { type: "reference", path: ["user", "constructor"] },
      }),
    ).toBe(false);
    expect(
      isCompiledExpression({
        source: "call()",
        ast: { type: "call", name: "call" },
      }),
    ).toBe(false);
  });

  it("renders errors explicitly and caps template output", () => {
    expect(
      renderExpressionTemplate(
        [
          { type: "text", value: "net=" },
          { type: "expression", expression: arithmetic },
        ],
        { order: { total: 10, discount: 2 } },
      ),
    ).toBe("net=4");
    expect(
      renderExpressionTemplate(
        [{ type: "expression", expression: arithmetic }],
        {},
      ),
    ).toBe("<expression-error:missing>");
  });
});
