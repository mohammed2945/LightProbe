export interface ServiceConfig {
  serviceId: string;
  brokerUrl: string;
  host: string;
  port: number;
  bugEnabled: boolean;
}

function nonEmpty(value: string | undefined, fallback: string, name: string): string {
  const resolved = value ?? fallback;
  if (resolved.trim().length === 0) {
    throw new Error(`${name} must be non-empty`);
  }
  return resolved.trim();
}

function port(value: string | undefined): number {
  const resolved = Number(value ?? "8080");
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > 65_535) {
    throw new Error("PORT must be an integer from 1 through 65535");
  }
  return resolved;
}

function bugEnabled(value: string | undefined): boolean {
  const resolved = value ?? "on";
  if (resolved !== "on" && resolved !== "off") {
    throw new Error("BUG must be either on or off");
  }
  return resolved === "on";
}

function brokerUrl(value: string | undefined): string {
  const resolved = nonEmpty(value, "http://127.0.0.1:7070", "BROKER_URL");
  const parsed = new URL(resolved);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("BROKER_URL must use http or https");
  }
  return parsed.toString().replace(/\/$/u, "");
}

export function loadServiceConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ServiceConfig {
  return {
    serviceId: nonEmpty(environment["SERVICE_ID"], "payment-service", "SERVICE_ID"),
    brokerUrl: brokerUrl(environment["BROKER_URL"]),
    host: nonEmpty(environment["HOST"], "0.0.0.0", "HOST"),
    port: port(environment["PORT"]),
    bugEnabled: bugEnabled(environment["BUG"]),
  };
}
