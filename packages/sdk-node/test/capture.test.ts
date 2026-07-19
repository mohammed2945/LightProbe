import { describe, expect, it } from "vitest";

import { CAPTURE_TRUNCATED_VALUE } from "../src/capture-marker.js";
import { capturePaused, type RawCapture } from "../src/capture.js";
import {
  matchesCondition,
  renderTemplate,
  resolveDotPath,
} from "../src/safe-values.js";
import { serialize } from "../src/serializer.js";
import type { PausedEvent } from "../src/types.js";

const paused: PausedEvent = {
  hitBreakpoints: ["bp-1"],
  callFrames: [
    {
      callFrameId: "frame-1",
      functionName: "work",
      location: { scriptId: "script-1", lineNumber: 4 },
      scopeChain: [
        {
          type: "local",
          object: { type: "object", objectId: "scope-1" },
        },
      ],
    },
  ],
};

describe("capture object budget", () => {
  it("materializes an explicit truncation marker without reading over budget", () => {
    const requested: string[] = [];
    let captured: RawCapture | undefined;
    capturePaused(
      {
        getProperties({ objectId }, callback) {
          requested.push(objectId);
          callback(null, {
            result: [
              {
                name: "child",
                enumerable: true,
                value: { type: "object", objectId: "child-1" },
              },
            ],
          });
        },
      } as never,
      paused,
      {
        maxArray: 3,
        maxDepth: 5,
        maxObjects: 1,
        maxProps: 50,
        maxStackFrames: 8,
        redactKeys: [],
        scriptPath: () => "/app/work.js",
      },
      (error, result) => {
        expect(error).toBeNull();
        captured = result;
      },
    );

    expect(requested).toEqual(["scope-1"]);
    expect(captured?.variables["child"]).toBe(CAPTURE_TRUNCATED_VALUE);
    expect(serialize(captured?.variables)).toEqual({
      t: "obj",
      c: {
        child: { t: "truncated", v: "props" },
      },
    });

    const nested = resolveDotPath(captured?.variables, "child.value");
    expect(nested.found).toBe(false);
    expect(nested.truncated).toBe(true);
    expect(nested.value).toBe(CAPTURE_TRUNCATED_VALUE);
    expect(serialize(nested.value)).toEqual({ t: "truncated", v: "props" });
    expect(
      matchesCondition(captured?.variables, {
        path: "child.value",
        op: "eq",
        value: "anything",
      }),
    ).toBe(false);
    expect(renderTemplate("value=${child.value}", captured?.variables)).toBe(
      "value=[truncated]",
    );
  });
});
