import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

const rules = [
  {
    name: "Node inspector mutation/evaluation",
    directory: "packages/sdk-node/src",
    extensions: new Set([".ts"]),
    pattern:
      /\b(?:Runtime\.evaluate|Runtime\.callFunctionOn|Runtime\.compileScript|Runtime\.runScript|Debugger\.evaluateOnCallFrame|Debugger\.setVariableValue|Debugger\.setReturnValue|Debugger\.setScriptSource|Debugger\.restartFrame)\b/u,
    forbiddenSample: 'session.post("Runtime.evaluate", { expression: "state.enabled = true" })',
    allowedSample: 'session.post("Runtime.getProperties", { objectId })',
  },
  {
    name: "Python frame mutation/evaluation",
    directory: "python/sdk/src/liveprobe",
    extensions: new Set([".py"]),
    pattern:
      /(?:\bctypes\b|PyFrame_LocalsToFast|\b(?:exec|eval|setattr|delattr)\s*\(|object\.__setattr__\s*\(|\.f_locals\s*(?:\[[^\]]+\])?\s*=)/u,
    forbiddenSample: 'frame.f_locals["enabled"] = True',
    allowedSample: "variables = dict(frame.f_locals)",
  },
  {
    name: "JDI target mutation/invocation",
    directory: "java/bridge/src/main/java",
    extensions: new Set([".java"]),
    pattern:
      /(?:\b(?:redefineClasses|forceEarlyReturn|popFrames|invokeMethod)\s*\(|\.setValues?\s*\()/u,
    allowedPattern: /^\s*(?:hostname|port)\.setValue\(/u,
    forbiddenSample: "frame.setValue(variable, replacement);",
    allowedSample: "hostname.setValue(address.host());",
  },
];

async function sourceFiles(directory, extensions) {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      paths.push(...(await sourceFiles(path, extensions)));
    } else if (entry.isFile() && extensions.has(extname(entry.name))) {
      paths.push(path);
    }
  }
  return paths;
}

const failures = [];
let filesScanned = 0;

for (const rule of rules) {
  if (!rule.pattern.test(rule.forbiddenSample)) {
    throw new Error(`${rule.name} guard does not detect its forbidden self-test`);
  }
  if (
    rule.pattern.test(rule.allowedSample) &&
    (rule.allowedPattern === undefined || !rule.allowedPattern.test(rule.allowedSample))
  ) {
    throw new Error(`${rule.name} guard rejects its allowed self-test`);
  }

  const directory = resolve(root, rule.directory);
  for (const path of await sourceFiles(directory, rule.extensions)) {
    filesScanned += 1;
    const lines = (await readFile(path, "utf8")).split(/\r?\n/u);
    lines.forEach((line, index) => {
      if (
        rule.pattern.test(line) &&
        (rule.allowedPattern === undefined || !rule.allowedPattern.test(line))
      ) {
        failures.push(
          `${relative(root, path)}:${String(index + 1)}: ${rule.name}: ${line.trim()}`,
        );
      }
    });
  }
}

if (failures.length > 0) {
  console.error("Read-only runtime audit failed:");
  for (const failure of failures) console.error(`  ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `Read-only runtime audit passed: ${String(filesScanned)} source files scanned; ` +
      `${String(rules.length)} guards self-tested.`,
  );
}
