import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { InspectorClient } from "../src/inspector-client.js";

describe("InspectorClient", () => {
  it("can send exactly the five allowed protocol commands", () => {
    const commands: string[] = [];
    const session = {
      connect() {},
      disconnect() {},
      on() {
        return this;
      },
      removeListener() {
        return this;
      },
      post(
        method: string,
        _params: Record<string, unknown>,
        callback: (error: Error | null, result?: unknown) => void,
      ) {
        commands.push(method);
        if (method === "Debugger.setBreakpointByUrl") {
          callback(null, { breakpointId: "bp", locations: [] });
        } else if (method === "Runtime.getProperties") {
          callback(null, { result: [] });
        } else {
          callback(null, {});
        }
      },
    };
    const inspector = new InspectorClient(session as never);
    const done = (): void => {};

    inspector.enable(done);
    inspector.setBreakpointByUrl({ lineNumber: 1, url: "file:///app.js" }, done);
    inspector.removeBreakpoint({ breakpointId: "bp" }, done);
    inspector.resume(done);
    inspector.getProperties({ objectId: "object-1" }, done);

    expect(commands).toEqual([
      "Debugger.enable",
      "Debugger.setBreakpointByUrl",
      "Debugger.removeBreakpoint",
      "Debugger.resume",
      "Runtime.getProperties",
    ]);
  });

  it("contains neither forbidden protocol command in source", () => {
    const sourceDirectory = new URL("../src/", import.meta.url);
    const source = readdirSync(sourceDirectory)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => readFileSync(new URL(name, sourceDirectory), "utf8"))
      .join("\n");

    expect(source).not.toContain("evaluateOnCallFrame");
    expect(source).not.toContain("Runtime.evaluate");
  });

  it("turns synchronous session failures into callback errors", () => {
    const session = {
      connect() {},
      disconnect() {},
      on() {
        return this;
      },
      removeListener() {
        return this;
      },
      post() {
        throw new Error("session closed");
      },
    };
    const inspector = new InspectorClient(session as never);
    let error: Error | null = null;
    inspector.resume((received) => {
      error = received;
    });
    expect(error?.message).toBe("session closed");
  });
});
