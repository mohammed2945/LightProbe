import type { ProbeCondition } from "./types.js";
import { isCaptureTruncated } from "./capture-marker.js";

export interface PathResult {
  found: boolean;
  truncated?: true;
  value?: unknown;
}

export function isValidDotPath(path: string): boolean {
  if (path.length === 0 || path.length > 1024) {
    return false;
  }
  const segments = path.split(".");
  return (
    segments.length <= 64 &&
    segments.every((segment) => segment.length > 0 && segment.length <= 128)
  );
}

/**
 * Resolves only own data properties. Prototype members and accessors are never
 * read, so a path supplied by the broker cannot execute application code.
 */
export function resolveDotPath(root: unknown, path: string): PathResult {
  if (!isValidDotPath(path)) {
    return { found: false };
  }

  let current = root;
  for (const segment of path.split(".")) {
    if (isCaptureTruncated(current)) {
      return { found: false, truncated: true, value: current };
    }
    if ((typeof current !== "object" || current === null) && !Array.isArray(current)) {
      return { found: false };
    }
    const descriptor = Object.getOwnPropertyDescriptor(current, segment);
    if (descriptor === undefined || !("value" in descriptor)) {
      return { found: false };
    }
    current = descriptor.value;
  }
  if (isCaptureTruncated(current)) {
    return { found: true, truncated: true, value: current };
  }
  return { found: true, value: current };
}

function isJsonScalar(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

export function matchesCondition(root: unknown, condition: ProbeCondition | undefined): boolean {
  if (condition === undefined) {
    return true;
  }
  const resolved = resolveDotPath(root, condition.path);
  if (!resolved.found || !isJsonScalar(resolved.value) || !isJsonScalar(condition.value)) {
    return false;
  }

  switch (condition.op) {
    case "eq":
      return resolved.value === condition.value;
    case "ne":
      return resolved.value !== condition.value;
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      if (typeof resolved.value !== "number" || typeof condition.value !== "number") {
        return false;
      }
      if (condition.op === "gt") return resolved.value > condition.value;
      if (condition.op === "gte") return resolved.value >= condition.value;
      if (condition.op === "lt") return resolved.value < condition.value;
      return resolved.value <= condition.value;
    }
  }
}

function renderValue(value: unknown): string {
  if (isCaptureTruncated(value)) return "[truncated]";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return "[array]";
  if (typeof value === "object") return "[object]";
  if (typeof value === "function") return "[function]";
  return "[unavailable]";
}

export function templatePaths(template: string): string[] {
  return [...template.matchAll(/\$\{([^{}]+)\}/gu)].map((match) => match[1] ?? "");
}

export function renderTemplate(
  template: string,
  root: unknown,
  options: {
    maxLength?: number;
    shouldRedact?: (path: string, value: unknown) => boolean;
  } = {},
): string {
  const rendered = template.replace(/\$\{([^{}]+)\}/gu, (_match, path: string) => {
    const resolved = resolveDotPath(root, path);
    if (
      (resolved.found || resolved.truncated === true) &&
      options.shouldRedact?.(path, resolved.value) === true
    ) {
      return "[REDACTED]";
    }
    if (resolved.truncated === true) {
      return "[truncated]";
    }
    return resolved.found ? renderValue(resolved.value) : "[unavailable]";
  });
  const maxLength = options.maxLength ?? 4096;
  if ([...rendered].length <= maxLength) {
    return rendered;
  }
  return [...rendered].slice(0, maxLength).join("");
}
