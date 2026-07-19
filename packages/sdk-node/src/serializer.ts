import type {
  SanitizedNode,
  SerializerConfig,
  SerializerConfigInput,
} from "./types.js";
import { isCaptureTruncated } from "./capture-marker.js";

export const DEFAULT_REDACT_KEYS = Object.freeze([
  "password",
  "secret",
  "token",
  "authorization",
  "cookie",
  "key",
  "signature",
  "ssn",
  "creditcard",
]);

export const DEFAULT_SERIALIZER_CONFIG: Readonly<SerializerConfig> = Object.freeze({
  maxDepth: 3,
  maxArray: 3,
  maxProps: 50,
  maxString: 1024,
  maxStackFrames: 8,
  redactKeys: DEFAULT_REDACT_KEYS,
  redactValues: Object.freeze([]),
});

function normalizedLimit(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function uniquePatterns(defaults: readonly string[], extras: readonly string[] | undefined): string[] {
  const patterns: string[] = [];
  const seen = new Set<string>();
  for (const pattern of [...defaults, ...(extras ?? [])]) {
    const normalized = pattern.toLocaleLowerCase("en-US");
    if (normalized.length > 0 && !seen.has(normalized)) {
      seen.add(normalized);
      patterns.push(normalized);
    }
  }
  return patterns;
}

export function normalizeSerializerConfig(input: SerializerConfigInput = {}): SerializerConfig {
  return {
    maxDepth: normalizedLimit(input.maxDepth, DEFAULT_SERIALIZER_CONFIG.maxDepth, "maxDepth"),
    maxArray: normalizedLimit(input.maxArray, DEFAULT_SERIALIZER_CONFIG.maxArray, "maxArray"),
    maxProps: normalizedLimit(input.maxProps, DEFAULT_SERIALIZER_CONFIG.maxProps, "maxProps"),
    maxString: normalizedLimit(input.maxString, DEFAULT_SERIALIZER_CONFIG.maxString, "maxString"),
    maxStackFrames: normalizedLimit(
      input.maxStackFrames,
      DEFAULT_SERIALIZER_CONFIG.maxStackFrames,
      "maxStackFrames",
    ),
    redactKeys: uniquePatterns(DEFAULT_REDACT_KEYS, input.redactKeys),
    redactValues: [...new Set(input.redactValues ?? [])],
  };
}

export function isRedactedKey(key: string, config: SerializerConfig): boolean {
  const normalized = key.toLocaleLowerCase("en-US");
  return config.redactKeys.some((pattern) => normalized.includes(pattern));
}

function setSafe(
  target: Record<string, SanitizedNode>,
  key: string,
  value: SanitizedNode,
): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function serializeValue(
  raw: unknown,
  config: SerializerConfig,
  depth: number,
  activeAncestors: Set<object>,
): SanitizedNode {
  if (isCaptureTruncated(raw)) {
    return { t: "truncated", v: "props" };
  }
  if (typeof raw === "string" && config.redactValues.includes(raw)) {
    return { t: "redacted" };
  }
  if (depth > config.maxDepth) {
    return { t: "truncated", v: "depth" };
  }
  if (raw === null) {
    return { t: "null", v: null };
  }

  switch (typeof raw) {
    case "string":
      return [...raw].length > config.maxString
        ? { t: "truncated", v: "string" }
        : { t: "str", v: raw };
    case "number":
      return Number.isFinite(raw)
        ? { t: "num", v: raw }
        : { t: "truncated", v: "unsupported" };
    case "boolean":
      return { t: "bool", v: raw };
    case "function":
      return { t: "fn" };
    case "object":
      break;
    default:
      return { t: "truncated", v: "unsupported" };
  }

  const container = raw as object;
  if (activeAncestors.has(container)) {
    return { t: "truncated", v: "circular" };
  }
  activeAncestors.add(container);

  try {
    if (Array.isArray(raw)) {
      const childCount = Math.min(raw.length, config.maxArray);
      const children: SanitizedNode[] = [];
      for (let index = 0; index < childCount; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(raw, String(index));
        const value =
          descriptor === undefined
            ? undefined
            : "value" in descriptor
              ? descriptor.value
              : "[getter]";
        children.push(serializeValue(value, config, depth + 1, activeAncestors));
      }
      if (raw.length > config.maxArray) {
        return { t: "arr", c: children, m: { t: "truncated", v: "array" } };
      }
      return { t: "arr", c: children };
    }

    const allKeys = Object.keys(raw);
    const keys = allKeys.slice(0, config.maxProps);
    const children: Record<string, SanitizedNode> = {};
    for (const key of keys) {
      if (isRedactedKey(key, config)) {
        setSafe(children, key, { t: "redacted" });
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(raw, key);
      const value =
        descriptor === undefined
          ? undefined
          : "value" in descriptor
            ? descriptor.value
            : "[getter]";
      setSafe(children, key, serializeValue(value, config, depth + 1, activeAncestors));
    }
    if (allKeys.length > config.maxProps) {
      return { t: "obj", c: children, m: { t: "truncated", v: "props" } };
    }
    return { t: "obj", c: children };
  } finally {
    activeAncestors.delete(container);
  }
}

/**
 * Converts a raw in-process capture into the only value shape accepted by the
 * transport layer. Property accessors are represented without being invoked.
 */
export function serialize(raw: unknown, input: SerializerConfigInput = {}): SanitizedNode {
  return serializeValue(raw, normalizeSerializerConfig(input), 0, new Set<object>());
}
