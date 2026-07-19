import type { UserTier } from "./payments.js";

interface TrafficConfig {
  targetUrl: string;
  intervalMs: number;
  requestLimit: number | null;
}

const TIERS: readonly UserTier[] = ["premium", "free", "enterprise", "free"];

function integerSetting(
  value: string | undefined,
  fallback: number,
  name: string,
  allowZero = false,
): number {
  const resolved = Number(value ?? String(fallback));
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(resolved) || resolved < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${String(minimum)}`);
  }
  return resolved;
}

function loadTrafficConfig(environment: NodeJS.ProcessEnv = process.env): TrafficConfig {
  const targetUrl = new URL(
    environment["TARGET_URL"] ?? "http://127.0.0.1:8080",
  );
  const requestLimit = integerSetting(
    environment["TRAFFIC_REQUESTS"],
    0,
    "TRAFFIC_REQUESTS",
    true,
  );
  return {
    targetUrl: targetUrl.toString().replace(/\/$/u, ""),
    intervalMs: integerSetting(
      environment["TRAFFIC_INTERVAL_MS"],
      250,
      "TRAFFIC_INTERVAL_MS",
    ),
    requestLimit: requestLimit === 0 ? null : requestLimit,
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function responseCode(value: unknown): string {
  if (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof value.error === "object" &&
    value.error !== null &&
    "code" in value.error &&
    typeof value.error.code === "string"
  ) {
    return value.error.code;
  }
  return "PaymentAccepted";
}

async function main(): Promise<void> {
  const config = loadTrafficConfig();
  let stopping = false;
  process.once("SIGINT", () => {
    stopping = true;
  });
  process.once("SIGTERM", () => {
    stopping = true;
  });

  let sequence = 0;
  while (
    !stopping &&
    (config.requestLimit === null || sequence < config.requestLimit)
  ) {
    sequence += 1;
    const tier = TIERS[(sequence - 1) % TIERS.length] ?? "free";
    const startedAt = performance.now();
    let status = 0;
    let code = "NetworkError";

    try {
      const response = await fetch(`${config.targetUrl}/pay`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-request-id": `traffic-${String(sequence).padStart(6, "0")}`,
        },
        body: JSON.stringify({
          user: {
            id: `${tier}-user-${String(sequence).padStart(6, "0")}`,
            tier,
          },
          amountCents: 2_500,
        }),
      });
      status = response.status;
      code = responseCode((await response.json()) as unknown);
    } catch (error: unknown) {
      code =
        error instanceof Error
          ? `NetworkError:${error.message.replace(/\s+/gu, "_")}`
          : "NetworkError";
    }

    const durationMs = Math.max(0, performance.now() - startedAt);
    process.stdout.write(
      `[traffic] request=${String(sequence)} tier=${tier} ` +
        `status=${String(status)} code=${code} durationMs=${durationMs.toFixed(1)}\n`,
    );
    if (!stopping) {
      await delay(config.intervalMs);
    }
  }
}

main().catch((error: unknown) => {
  console.error("[traffic] failed", error);
  process.exitCode = 1;
});
