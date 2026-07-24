import { isCaptureTruncated } from "./capture-marker.js";
import type {
  CompiledExpression,
  ExpressionNode,
  ExpressionPathSegment,
  JsonScalar,
  TemplateSegment,
} from "./types.js";

export type ExpressionResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

export interface ExpressionPolicy {
  isRedactedKey?: (key: string) => boolean;
  isRedactedValue?: (value: unknown) => boolean;
}

const BINARY_OPERATORS = new Set([
  "add",
  "subtract",
  "multiply",
  "divide",
  "modulo",
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "and",
  "or",
]);
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isScalar(value: unknown): value is JsonScalar {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && isPortableNumber(value))
  );
}

function isPortableNumber(value: number): boolean {
  return (
    Number.isFinite(value) &&
    (!Number.isInteger(value) || Number.isSafeInteger(value))
  );
}

function validPathSegment(value: unknown): value is ExpressionPathSegment {
  return (
    (typeof value === "string" &&
      value.length > 0 &&
      value.length <= 128 &&
      !FORBIDDEN_SEGMENTS.has(value)) ||
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
  );
}

function validateNode(
  node: unknown,
  state: { count: number },
  depth: number,
): node is ExpressionNode {
  state.count += 1;
  if (state.count > 100 || depth > 20 || !isRecord(node)) return false;
  if (node["type"] === "literal") {
    return isScalar(node["value"]) && Object.keys(node).length === 2;
  }
  if (node["type"] === "reference") {
    return (
      Array.isArray(node["path"]) &&
      node["path"].length > 0 &&
      node["path"].length <= 64 &&
      node["path"].every(validPathSegment) &&
      Object.keys(node).length === 2
    );
  }
  if (node["type"] === "unary") {
    return (
      (node["operator"] === "not" || node["operator"] === "negate") &&
      validateNode(node["operand"], state, depth + 1) &&
      Object.keys(node).length === 3
    );
  }
  if (node["type"] === "binary") {
    return (
      typeof node["operator"] === "string" &&
      BINARY_OPERATORS.has(node["operator"]) &&
      validateNode(node["left"], state, depth + 1) &&
      validateNode(node["right"], state, depth + 1) &&
      Object.keys(node).length === 4
    );
  }
  return false;
}

export function isCompiledExpression(value: unknown): value is CompiledExpression {
  return (
    isRecord(value) &&
    typeof value["source"] === "string" &&
    value["source"].length > 0 &&
    value["source"].length <= 4_096 &&
    validateNode(value["ast"], { count: 0 }, 0) &&
    Object.keys(value).length === 2
  );
}

export function isTemplateSegment(value: unknown): value is TemplateSegment {
  if (!isRecord(value) || typeof value["type"] !== "string") return false;
  if (value["type"] === "text") {
    return (
      typeof value["value"] === "string" &&
      value["value"].length <= 16_384 &&
      Object.keys(value).length === 2
    );
  }
  return (
    value["type"] === "expression" &&
    isCompiledExpression(value["expression"]) &&
    Object.keys(value).length === 2
  );
}

function resolvePath(
  root: unknown,
  path: readonly ExpressionPathSegment[],
  policy: ExpressionPolicy,
): ExpressionResult {
  let current = root;
  for (const segment of path) {
    const key = String(segment);
    if (policy.isRedactedKey?.(key) === true) {
      return { ok: false, error: "redacted" };
    }
    if (isCaptureTruncated(current)) {
      return { ok: false, error: "capture-truncated" };
    }
    if (typeof current !== "object" || current === null) {
      return { ok: false, error: "missing" };
    }
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      return { ok: false, error: "missing" };
    }
    current = descriptor.value;
  }
  if (isCaptureTruncated(current)) {
    return { ok: false, error: "capture-truncated" };
  }
  return safeResult(current, policy);
}

function numberPair(
  left: unknown,
  right: unknown,
): [number, number] | undefined {
  return typeof left === "number" &&
    isPortableNumber(left) &&
    typeof right === "number" &&
    isPortableNumber(right)
    ? [left, right]
    : undefined;
}

function numericError(left: unknown, right?: unknown): string {
  return [left, right].some(
    (value) => typeof value === "number" && !isPortableNumber(value),
  )
    ? "unsafe-number"
    : right === undefined
      ? "expected-number"
      : "expected-numbers";
}

function safeResult(
  value: unknown,
  policy: ExpressionPolicy,
): ExpressionResult {
  if (typeof value === "number" && !isPortableNumber(value)) {
    return { ok: false, error: "unsafe-number" };
  }
  return policy.isRedactedValue?.(value) === true
    ? { ok: false, error: "redacted" }
    : { ok: true, value };
}

function evaluateNode(
  node: ExpressionNode,
  root: unknown,
  policy: ExpressionPolicy,
): ExpressionResult {
  if (node.type === "literal") return safeResult(node.value, policy);
  if (node.type === "reference") return resolvePath(root, node.path, policy);
  if (node.type === "unary") {
    const operand = evaluateNode(node.operand, root, policy);
    if (!operand.ok) return operand;
    if (node.operator === "not") {
      return typeof operand.value === "boolean"
        ? { ok: true, value: !operand.value }
        : { ok: false, error: "expected-boolean" };
    }
    return typeof operand.value === "number" &&
      isPortableNumber(operand.value)
      ? safeResult(-operand.value, policy)
      : { ok: false, error: numericError(operand.value) };
  }

  const left = evaluateNode(node.left, root, policy);
  if (!left.ok) return left;
  if (node.operator === "and" || node.operator === "or") {
    if (typeof left.value !== "boolean") {
      return { ok: false, error: "expected-boolean" };
    }
    if (node.operator === "and" && !left.value) {
      return { ok: true, value: false };
    }
    if (node.operator === "or" && left.value) {
      return { ok: true, value: true };
    }
    const right = evaluateNode(node.right, root, policy);
    return right.ok && typeof right.value === "boolean"
      ? right
      : { ok: false, error: right.ok ? "expected-boolean" : right.error };
  }

  const right = evaluateNode(node.right, root, policy);
  if (!right.ok) return right;
  if (node.operator === "eq" || node.operator === "ne") {
    if (!isScalar(left.value) || !isScalar(right.value)) {
      return { ok: false, error: "expected-scalars" };
    }
    const equal =
      typeof left.value === typeof right.value && left.value === right.value;
    return { ok: true, value: node.operator === "eq" ? equal : !equal };
  }
  if (
    node.operator === "gt" ||
    node.operator === "gte" ||
    node.operator === "lt" ||
    node.operator === "lte"
  ) {
    const pair = numberPair(left.value, right.value);
    if (pair === undefined) {
      return { ok: false, error: numericError(left.value, right.value) };
    }
    const [a, b] = pair;
    if (node.operator === "gt") return { ok: true, value: a > b };
    if (node.operator === "gte") return { ok: true, value: a >= b };
    if (node.operator === "lt") return { ok: true, value: a < b };
    return { ok: true, value: a <= b };
  }
  if (
    node.operator === "add" &&
    typeof left.value === "string" &&
    typeof right.value === "string"
  ) {
    return safeResult(left.value + right.value, policy);
  }
  const pair = numberPair(left.value, right.value);
  if (pair === undefined) {
    return { ok: false, error: numericError(left.value, right.value) };
  }
  const [a, b] = pair;
  let value: number;
  if (node.operator === "add") value = a + b;
  else if (node.operator === "subtract") value = a - b;
  else if (node.operator === "multiply") value = a * b;
  else if (node.operator === "divide") {
    if (b === 0) return { ok: false, error: "division-by-zero" };
    value = a / b;
  } else {
    if (b === 0) return { ok: false, error: "division-by-zero" };
    value = a % b;
  }
  return Number.isFinite(value)
    ? safeResult(value, policy)
    : { ok: false, error: "non-finite-result" };
}

export function evaluateExpression(
  expression: CompiledExpression,
  root: unknown,
  policy: ExpressionPolicy = {},
): ExpressionResult {
  return evaluateNode(expression.ast, root, policy);
}

export function expressionPaths(
  expression: CompiledExpression,
): ExpressionPathSegment[][] {
  const paths: ExpressionPathSegment[][] = [];
  const visit = (node: ExpressionNode): void => {
    if (node.type === "reference") paths.push(node.path);
    else if (node.type === "unary") visit(node.operand);
    else if (node.type === "binary") {
      visit(node.left);
      visit(node.right);
    }
  };
  visit(expression.ast);
  return paths;
}

function renderExpressionValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return "[array]";
  if (typeof value === "object") return "[object]";
  return "[unavailable]";
}

export function renderExpressionTemplate(
  segments: readonly TemplateSegment[],
  root: unknown,
  maxLength = 4_096,
  policy: ExpressionPolicy = {},
): string {
  let rendered = "";
  for (const segment of segments) {
    rendered +=
      segment.type === "text"
        ? segment.value
        : (() => {
            const result = evaluateExpression(
              segment.expression,
              root,
              policy,
            );
            return result.ok
              ? renderExpressionValue(result.value)
              : `<expression-error:${result.error}>`;
          })();
    if ([...rendered].length >= maxLength) {
      return [...rendered].slice(0, maxLength).join("");
    }
  }
  return rendered;
}
