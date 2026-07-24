export type ProbeType = "snapshot" | "log" | "counter" | "metric";
export type LogLevel = "debug" | "info" | "warn" | "error";
export type ConditionOperator = "eq" | "ne" | "gt" | "gte" | "lt" | "lte";
export type JsonScalar = string | number | boolean | null;
export type ExpressionPathSegment = string | number;

export type ExpressionNode =
  | { type: "literal"; value: JsonScalar }
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

export interface ProbeCondition {
  path: string;
  op: ConditionOperator;
  value: JsonScalar;
}

export interface ProbeDefinition {
  id: string;
  serviceId: string;
  sourceCommit?: string;
  type: ProbeType;
  file: string;
  line: number;
  runtimeLocation?: string;
  runtimeLine?: number;
  runtimeColumn?: number;
  condition?: ProbeCondition;
  conditionExpression?: CompiledExpression;
  watchPaths?: string[];
  watchExpressions?: CompiledExpression[];
  includeStackLocals?: boolean;
  stackFrameLimit?: number;
  template?: string;
  logLevel?: LogLevel;
  templateSegments?: TemplateSegment[];
  metricPath?: string;
  metricExpression?: CompiledExpression;
  hitLimit: number;
  ttlSeconds: number;
  version: number;
  createdBy: string;
}

export interface SerializerConfig {
  maxDepth: number;
  maxArray: number;
  maxProps: number;
  maxString: number;
  maxStackFrames: number;
  redactKeys: readonly string[];
  redactValues: readonly string[];
}

export interface SerializerConfigInput {
  maxDepth?: number;
  maxArray?: number;
  maxProps?: number;
  maxString?: number;
  maxStackFrames?: number;
  redactKeys?: readonly string[];
  redactValues?: readonly string[];
}

export type TruncationReason =
  | "depth"
  | "array"
  | "props"
  | "string"
  | "circular"
  | "unsupported";

export type SanitizedNode =
  | { t: "str"; v: string }
  | { t: "num"; v: number }
  | { t: "bool"; v: boolean }
  | { t: "null"; v: null }
  | { t: "fn" }
  | { t: "redacted" }
  | { t: "truncated"; v: TruncationReason }
  | { t: "obj"; c: Record<string, SanitizedNode>; m?: { t: "truncated"; v: "props" } }
  | { t: "arr"; c: SanitizedNode[]; m?: { t: "truncated"; v: "array" } };

export interface StackFrame {
  fn: string;
  file: string;
  line: number;
  variables?: SanitizedNode;
}

interface EventBase {
  probeId: string;
  ts: string;
}

export interface SnapshotEvent extends EventBase {
  type: "snapshot";
  variables: SanitizedNode;
  watches: Record<string, SanitizedNode>;
  stack: StackFrame[];
}

export interface LogEvent extends EventBase {
  type: "log";
  message: string;
  level: LogLevel;
}

export interface CounterEvent extends EventBase {
  type: "counter";
  delta: number;
}

export interface MetricEvent extends EventBase {
  type: "metric";
  count: number;
  sum: number;
  min: number;
  max: number;
  last: number;
}

export type ProbeStatus = "armed" | "error" | "hit-limit-reached" | "suspended" | "expired";

export interface StatusEvent extends EventBase {
  type: "status";
  status: ProbeStatus;
  detail?: string;
}

export type AgentEvent = SnapshotEvent | LogEvent | CounterEvent | MetricEvent | StatusEvent;

export type SafetyReasonCode =
  | "event_loop_lag"
  | "pause_budget"
  | "rate_limited"
  | "instrumentation_failure"
  | "agent_worker_failure";

export interface SafetyLimits {
  maxProbeHitsPerSecond?: number;
  maxProbePauseMsPerSecond?: number;
  safetyCooldownMs?: number;
  maxTelemetryBytesPerSecond?: number;
  maxBufferedEventBytes?: number;
  maxEventLoopLagMs?: number;
}

export interface AgentStatus {
  state: "green" | "red";
  detail?: string;
  reasonCode?: SafetyReasonCode;
  limits?: SafetyLimits;
}

export interface PollResponse {
  version: number;
  unchanged?: true;
  probes?: ProbeDefinition[];
}

export interface InspectorError {
  code: string;
  message: string;
}

export interface ScriptParsedEvent {
  scriptId: string;
  url: string;
}

export interface RemoteObject {
  type: string;
  subtype?: string;
  value?: unknown;
  unserializableValue?: string;
  objectId?: string;
  description?: string;
}

export interface PropertyDescriptor {
  name: string;
  enumerable?: boolean;
  value?: RemoteObject;
  get?: RemoteObject;
  set?: RemoteObject;
}

export interface ScopeDescriptor {
  type: string;
  object: RemoteObject;
}

export interface CallFrameDescriptor {
  callFrameId: string;
  functionName: string;
  location: {
    scriptId: string;
    lineNumber: number;
    columnNumber?: number;
  };
  scopeChain: ScopeDescriptor[];
}

export interface PausedEvent {
  callFrames: CallFrameDescriptor[];
  hitBreakpoints?: string[];
}

export interface BreakpointLocation {
  scriptId: string;
  lineNumber: number;
  columnNumber?: number;
}

export interface SetBreakpointResult {
  breakpointId: string;
  locations: BreakpointLocation[];
}

export interface GetPropertiesResult {
  result: PropertyDescriptor[];
}
