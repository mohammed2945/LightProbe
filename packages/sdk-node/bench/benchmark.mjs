import { performance } from "node:perf_hooks";

const ITERATIONS = 50_000;
const SAMPLES = 200;

let counter = 0;
let consumedSnapshotActive = false;

function target(mode) {
  let checksum = 0;
  for (let index = 0; index < ITERATIONS; index += 1) {
    checksum = (checksum + ((index * 31) ^ (index >>> 2))) >>> 0;
    if (mode === "counter") counter += 1;
    if (mode === "consumed-snapshot" && consumedSnapshotActive) counter += checksum;
  }
  return checksum;
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function measure(mode) {
  for (let warmup = 0; warmup < 20; warmup += 1) target(mode);
  const samples = [];
  for (let sample = 0; sample < SAMPLES; sample += 1) {
    const started = performance.now();
    target(mode);
    samples.push(performance.now() - started);
  }
  return {
    p50: percentile(samples, 0.5),
    p99: percentile(samples, 0.99),
  };
}

const baseline = measure("baseline");
const rows = [
  ["baseline", baseline],
  ["counter bookkeeping", measure("counter")],
  ["snapshot consumed", measure("consumed-snapshot")],
].map(([name, result]) => ({
  scenario: name,
  "p50 ms": result.p50.toFixed(3),
  "p99 ms": result.p99.toFixed(3),
  "p99 delta": `${(((result.p99 - baseline.p99) / baseline.p99) * 100).toFixed(1)}%`,
}));

console.log(`LiveProbe hot-path benchmark: ${ITERATIONS.toLocaleString()} calls/sample`);
console.table(rows);
console.log(
  "Note: the active-breakpoint pause is intentionally excluded. Under the read-only " +
    "five-command protocol boundary, V8 always pauses before reporting a breakpoint hit; " +
    "the SDK can bound captures and resume immediately, but cannot make an active inspector " +
    "counter equivalent to an injected in-process increment.",
);
