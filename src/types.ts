export type StackId = 'arena' | 'gauntlet_a' | 'gauntlet_b';
export type EventKind = 'request' | 'error' | 'metric' | 'world_tick' | 'fault_started' | 'fault_cleared' | 'agent_action' | 'invariant_breach' | 'narration' | 'slice_ready' | 'probes_armed' | 'snapshot' | 'exonerated' | 'origin_found' | 'fix_proposed' | 'hypothesis' | 'probe_status';
export type FaultType = 'db_kill' | 'bad_deploy' | 'mem_leak' | 'surge_poison' | 'fare_corrupt' | 'double_dispatch';

export interface RequestPayload {
  route: string;
  status: number;
  latency_ms: number;
}

export interface ErrorPayload {
  message: string;
  stack_hint: string;
}

export interface MetricPayload {
  metric_name: string;
  value: number;
}

export interface AgentActionPayload {
  message: string;
}

export interface InvariantBreachPayload {
  invariant: string;
  detail: string;
}

export interface FaultPayload {
  fault: FaultType;
  durationMs?: number;
}

export interface NarrationPayload {
  text: string;
}

export interface WorldTickPayload {
  tick: number;
  surge: number;
  drivers: Array<{
    id: string;
    x: number;
    y: number;
    heading?: number;
    st: 'idle' | 'enroute' | 'ontrip';
  }>;
  riders: Array<{
    id: string;
    x: number;
    y: number;
    st: 'waiting' | 'matched' | 'riding' | 'stranded';
    eta_s?: number;
    quote?: number;
    driverId?: string;
  }>;
}

export type ArenaEventPayload = 
  | RequestPayload 
  | ErrorPayload 
  | MetricPayload 
  | WorldTickPayload 
  | FaultPayload 
  | AgentActionPayload 
  | InvariantBreachPayload 
  | NarrationPayload
  | OriginSliceReadyPayload
  | OriginProbesArmedPayload
  | OriginSnapshotPayload
  | OriginExoneratedPayload
  | OriginFoundPayload
  | OriginFixProposedPayload
  | any;

export interface ArenaEvent {
  ts: string;
  stack_id: StackId;
  service: string;
  trace_id?: string;
  kind: EventKind;
  payload: ArenaEventPayload;
}

export interface ActiveFault {
  ts: string;
  stack_id: StackId;
  fault: FaultType;
  cleared_at?: string;
}

export interface OriginSliceReadyPayload {
  slice: {
    nodes: Array<{ id: string; label: string; role: 'candidate' | 'manifestation' }>;
    edges: Array<{ from: string; to: string }>;
  };
}

export interface OriginProbesArmedPayload {
  node_ids: string[];
}

export interface OriginSnapshotPayload {
  node_id: string;
  trace_id: string;
  expr: string;
  value: string;
  population: 'failing' | 'passing';
}

export interface OriginExoneratedPayload {
  node_ids: string[];
  reason: string;
}

export interface OriginFoundPayload {
  origin: string;
  chain: string[];
  confidence: 'high' | 'medium' | 'low';
}

export interface OriginFixProposedPayload {
  title: string;
  diff_summary: string;
  witnessed: boolean;
  pr_url: string;
}

export type OriginEventPayload = 
  | OriginSliceReadyPayload
  | OriginProbesArmedPayload
  | OriginSnapshotPayload
  | OriginExoneratedPayload
  | OriginFoundPayload
  | OriginFixProposedPayload;

export interface OriginEvent {
  ts: string;
  stack_id: StackId;
  incident_id: string;
  kind: 'slice_ready' | 'probes_armed' | 'snapshot' | 'exonerated' | 'origin_found' | 'fix_proposed';
  payload: OriginEventPayload;
}

export interface StackHealthRow {
  stack_id: StackId;
  errors_10m: number;
  uptime_pct: number;
  stranded_now: number;
}

export interface DataSource {
  start(): void;
  stop(): void;
  subscribe(listener: (event: ArenaEvent) => void): () => void;
}
