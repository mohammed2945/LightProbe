import jsep from "jsep";

export type ExpressionScalar = string | number | boolean | null;
export type ExpressionPathSegment = string | number;

export type ExpressionNode =
  | { type: "literal"; value: ExpressionScalar }
  | { type: "reference"; path: ExpressionPathSegment[] }
  | {
      type: "unary";
      operator: "not" | "negate";
      operand: ExpressionNode;
    }
  | {
      type: "binary";
      operator:
        | "add"
        | "subtract"
        | "multiply"
        | "divide"
        | "modulo"
        | "eq"
        | "ne"
        | "gt"
        | "gte"
        | "lt"
        | "lte"
        | "and"
        | "or";
      left: ExpressionNode;
      right: ExpressionNode;
    };

export interface CompiledExpression {
  source: string;
  ast: ExpressionNode;
}

export type TemplateSegment =
  | { type: "text"; value: string }
  | { type: "expression"; expression: CompiledExpression };

const MAX_SOURCE_LENGTH = 4_096;
const MAX_AST_DEPTH = 20;
const MAX_AST_NODES = 100;
const MAX_PATH_SEGMENTS = 64;
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const LEGACY_DOT_SEGMENT = /^(?:[A-Za-z_$][A-Za-z0-9_$]*|0|[1-9]\d*)$/u;

const binaryOperators = new Map<
  string,
  Extract<ExpressionNode, { type: "binary" }>["operator"]
>([
  ["+", "add"],
  ["-", "subtract"],
  ["*", "multiply"],
  ["/", "divide"],
  ["%", "modulo"],
  ["==", "eq"],
  ["===", "eq"],
  ["!=", "ne"],
  ["!==", "ne"],
  [">", "gt"],
  [">=", "gte"],
  ["<", "lt"],
  ["<=", "lte"],
  ["&&", "and"],
  ["||", "or"],
]);

function expressionError(message: string): Error {
  return new Error(`invalid safe expression: ${message}`);
}

function safeSegment(value: unknown): ExpressionPathSegment {
  if (typeof value === "string") {
    if (
      value.length === 0 ||
      value.length > 128 ||
      FORBIDDEN_SEGMENTS.has(value)
    ) {
      throw expressionError("property segment is not allowed");
    }
    return value;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  throw expressionError("computed properties require a string or integer literal");
}

function referencePath(node: jsep.Expression): ExpressionPathSegment[] {
  if (node.type === "Identifier") {
    return [safeSegment((node as jsep.Identifier).name)];
  }
  if (node.type !== "MemberExpression") {
    throw expressionError("member access must start at a local variable");
  }
  const member = node as jsep.MemberExpression;
  if (member.optional === true) {
    throw expressionError("optional chaining is not supported");
  }
  const base = referencePath(member.object);
  const segment = member.computed
    ? safeSegment(
        member.property.type === "Literal"
          ? (member.property as jsep.Literal).value
          : undefined,
      )
    : member.property.type === "Identifier"
      ? safeSegment((member.property as jsep.Identifier).name)
      : (() => {
          throw expressionError("property access must use a fixed name");
        })();
  const path = [...base, segment];
  if (path.length > MAX_PATH_SEGMENTS) {
    throw expressionError("property path is too deep");
  }
  return path;
}

function convert(
  node: jsep.Expression,
  state: { nodes: number },
  depth: number,
): ExpressionNode {
  state.nodes += 1;
  if (state.nodes > MAX_AST_NODES) {
    throw expressionError("expression has too many nodes");
  }
  if (depth > MAX_AST_DEPTH) {
    throw expressionError("expression is too deeply nested");
  }

  if (node.type === "Literal") {
    const value = (node as jsep.Literal).value;
    if (
      value !== null &&
      typeof value !== "string" &&
      typeof value !== "boolean" &&
      !(
        typeof value === "number" &&
        Number.isFinite(value) &&
        (!Number.isInteger(value) || Number.isSafeInteger(value))
      )
    ) {
      throw expressionError(
        "only finite JSON scalar literals within the safe integer range are supported",
      );
    }
    return { type: "literal", value: value as ExpressionScalar };
  }

  if (node.type === "Identifier" || node.type === "MemberExpression") {
    return { type: "reference", path: referencePath(node) };
  }

  if (node.type === "UnaryExpression") {
    const unary = node as jsep.UnaryExpression;
    const operator =
      unary.operator === "!"
        ? "not"
        : unary.operator === "-"
          ? "negate"
          : undefined;
    if (operator === undefined) {
      throw expressionError(`unary operator ${unary.operator} is not supported`);
    }
    return {
      type: "unary",
      operator,
      operand: convert(unary.argument, state, depth + 1),
    };
  }

  if (node.type === "BinaryExpression") {
    const binary = node as jsep.BinaryExpression;
    const operator = binaryOperators.get(binary.operator);
    if (operator === undefined) {
      throw expressionError(`binary operator ${binary.operator} is not supported`);
    }
    return {
      type: "binary",
      operator,
      left: convert(binary.left, state, depth + 1),
      right: convert(binary.right, state, depth + 1),
    };
  }

  throw expressionError(`${node.type} is not supported`);
}

export function compileExpression(source: string): CompiledExpression {
  const normalized = source.trim();
  if (normalized.length === 0 || normalized.length > MAX_SOURCE_LENGTH) {
    throw expressionError("source must contain 1 to 4096 characters");
  }
  let parsed: jsep.Expression;
  try {
    parsed = jsep(normalized);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw expressionError(detail);
  }
  return {
    source: normalized,
    ast: convert(parsed, { nodes: 0 }, 0),
  };
}

export function isLegacyDotPath(source: string): boolean {
  return (
    source.length > 0 &&
    source.length <= 1_024 &&
    source
      .split(".")
      .every(
        (segment) =>
          segment.length <= 128 &&
          LEGACY_DOT_SEGMENT.test(segment) &&
          !FORBIDDEN_SEGMENTS.has(segment),
      )
  );
}

export function compileTemplate(template: string): TemplateSegment[] | undefined {
  const matches = [...template.matchAll(/\$\{([^{}]+)\}/gu)];
  if (
    matches.length === 0 ||
    matches.every((match) => isLegacyDotPath((match[1] ?? "").trim()))
  ) {
    return undefined;
  }

  const segments: TemplateSegment[] = [];
  let cursor = 0;
  for (const match of matches) {
    const index = match.index;
    if (index > cursor) {
      segments.push({ type: "text", value: template.slice(cursor, index) });
    }
    segments.push({
      type: "expression",
      expression: compileExpression(match[1] ?? ""),
    });
    cursor = index + match[0].length;
  }
  if (cursor < template.length) {
    segments.push({ type: "text", value: template.slice(cursor) });
  }
  return segments;
}
