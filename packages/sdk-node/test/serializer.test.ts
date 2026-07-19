import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { serialize } from "../src/serializer.js";

interface Fixture {
  input: unknown;
  config: Record<string, unknown>;
  expected: unknown;
}

function materialize(value: unknown, references = new Map<string, unknown>()): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => materialize(item, references));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }

  const tagged = value as Record<string, unknown>;
  if (tagged["$fixture"] === "function") {
    return (): void => {};
  }
  if (tagged["$fixture"] === "ref") {
    return references.get(String(tagged["id"]));
  }
  if (tagged["$fixture"] === "object" || tagged["$fixture"] === "array") {
    const container: Record<string, unknown> | unknown[] =
      tagged["$fixture"] === "array" ? [] : {};
    references.set(String(tagged["id"]), container);
    const source = tagged["value"];
    if (Array.isArray(container) && Array.isArray(source)) {
      container.push(...source.map((item) => materialize(item, references)));
    } else if (!Array.isArray(container) && typeof source === "object" && source !== null) {
      for (const [key, child] of Object.entries(source)) {
        container[key] = materialize(child, references);
      }
    }
    return container;
  }

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(tagged)) {
    output[key] = materialize(child, references);
  }
  return output;
}

const fixtureDirectory = fileURLToPath(
  new URL("../../../spec/fixtures/serializer/", import.meta.url),
);

describe("serialize", () => {
  for (const filename of readdirSync(fixtureDirectory).filter((name) => name.endsWith(".json"))) {
    it(`passes shared fixture ${filename}`, () => {
      const fixture = JSON.parse(
        readFileSync(new URL(filename, `file://${fixtureDirectory}/`), "utf8"),
      ) as Fixture;
      expect(serialize(materialize(fixture.input), fixture.config)).toEqual(fixture.expected);
    });
  }

  it("does not invoke getters and redacts before reading values", () => {
    let calls = 0;
    const raw = {};
    Object.defineProperties(raw, {
      visible: {
        enumerable: true,
        get() {
          calls += 1;
          return "executed";
        },
      },
      password: {
        enumerable: true,
        get() {
          calls += 1;
          return "secret";
        },
      },
    });

    expect(serialize(raw)).toEqual({
      t: "obj",
      c: {
        visible: { t: "str", v: "[getter]" },
        password: { t: "redacted" },
      },
    });
    expect(calls).toBe(0);
  });

  it("counts Unicode code points for string limits", () => {
    expect(serialize("😀a", { maxString: 2 })).toEqual({ t: "str", v: "😀a" });
    expect(serialize("😀ab", { maxString: 2 })).toEqual({
      t: "truncated",
      v: "string",
    });
  });
});
