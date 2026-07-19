import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

const root = resolve(new URL("..", import.meta.url).pathname);
const requiredFiles = [
  "pom.xml",
  "Dockerfile",
  "docker-entrypoint.sh",
  "Makefile",
  "README.md",
  "scripts/e2e.sh",
  "scripts/smoke.sh",
  "src/main/java/io/liveprobe/demo/inventory/InventoryService.java",
  "src/main/java/io/liveprobe/demo/inventory/TrafficGenerator.java",
  "src/test/java/io/liveprobe/demo/inventory/InventoryEngineTest.java",
];

const contents = new Map();
for (const relativePath of requiredFiles) {
  contents.set(
    relativePath,
    await readFile(resolve(root, relativePath), "utf8"),
  );
}

const source = contents.get(
  "src/main/java/io/liveprobe/demo/inventory/InventoryService.java",
);
const markerMatches = source.match(/LIVEPROBE_BUG_LINE/g) ?? [];
assert(markerMatches.length === 1, "bug line marker must appear exactly once");
assert(
  /boolean reserveDecision = cachedStock >= requested; \/\/ LIVEPROBE_BUG_LINE/.test(
    source,
  ),
  "bug marker must remain on the stale-cache decision",
);
for (const local of [
  "cachedStock",
  "authoritativeStock",
  "staleCachedStock",
  "requestRole",
  "waveId",
  "requestOrdinal",
]) {
  assert(
    source.includes(local),
    `probe evidence local ${local} is missing from the target`,
  );
}

const pom = contents.get("pom.xml");
assert(
  /<maven\.compiler\.release>17<\/maven\.compiler\.release>/.test(pom),
  "Maven must compile for Java 17",
);
assert(/<debug>true<\/debug>/.test(pom), "Maven debug info must be enabled");
assert(
  /<debuglevel>lines,vars,source<\/debuglevel>/.test(pom),
  "Maven must emit full lines, vars, and source debug tables",
);
assert(
  /<artifactId>javalin<\/artifactId>/.test(pom),
  "Javalin dependency is missing",
);
assert(
  /<artifactId>junit-jupiter<\/artifactId>/.test(pom),
  "JUnit Jupiter dependency is missing",
);

const dockerfile = contents.get("Dockerfile");
const entrypoint = contents.get("docker-entrypoint.sh");
const smoke = contents.get("scripts/smoke.sh");
const tests = contents.get(
  "src/test/java/io/liveprobe/demo/inventory/InventoryEngineTest.java",
);
assert(
  /FROM [^\n]+ AS build/.test(dockerfile)
    && /COPY --from=build/.test(dockerfile),
  "Dockerfile must remain a multi-stage build",
);
assert(!/EXPOSE\s+5005/.test(dockerfile), "target image must not expose JDWP");
assert(
  !/(?:--publish|-p)\s+[^\n]*(?:5005|INTERNAL_JDWP_PORT)/.test(
    [...contents.values()].join("\n"),
  ),
  "no file may publish the diagnostic port",
);
assert(
  dockerfile.includes("ENABLE_INTERNAL_JDWP=false"),
  "container diagnostics must default to disabled",
);
assert(
  entrypoint.includes("ENABLE_INTERNAL_JDWP")
    && entrypoint.includes("address=*:${INTERNAL_JDWP_PORT:-5005}"),
  "container diagnostics must be enabled only through internal settings",
);
assert(
  smoke.includes('BUG=on PORT="$PORT"')
    && smoke.includes("TrafficGenerator")
    && smoke.includes("completedRequests"),
  "smoke test must start the app, run traffic, and check counters",
);
assert(
  smoke.includes("http://127.0.0.1:")
    && !/(broker|bridge|https?:\/\/(?!127\.0\.0\.1))/.test(smoke),
  "smoke test must use only the loopback service",
);
for (const endpoint of ["/health", "/reserve", "/stats"]) {
  assert(source.includes(`"${endpoint}"`), `missing endpoint ${endpoint}`);
}
assert(
  source.includes("[request] started")
    && source.includes("[request] completed")
    && source.includes("[reservation]"),
  "clear request and reservation logging is missing",
);
assert(
  tests.includes("new InventoryEngine(true")
    && tests.includes("new InventoryEngine(false"),
  "unit tests must cover BUG=on and BUG=off",
);

console.log("inventory-service structural validation passed");

function assert(condition, message) {
  if (!condition) {
    console.error(`validation failed: ${message}`);
    process.exit(1);
  }
}
