import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import { z, ZodError } from "zod";

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const DEFAULT_TTL_SECONDS = 1_800;
const DEFAULT_RING_CAPACITY = 500;
const DEFAULT_TTL_SWEEP_INTERVAL_MS = 10_000;
const DEFAULT_SNAPSHOT_INTERVAL_MS = 15_000;

const serviceIdSchema = z.string().trim().min(1).max(200);
const probeIdSchema = z
  .string()
  .regex(/^prb_[0-9A-HJKMNP-TV-Z]{26}$/, "invalid probe id");
const sourceFileSchema = z.string().trim().min(1).max(4_096);
const sourceCommitSchema = z
  .string()
  .trim()
  .regex(
    /^[0-9a-fA-F]{7,64}$/,
    "must be a 7-64 character hexadecimal Git object ID",
  )
  .transform((value) => value.toLowerCase());
const dotPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_024)
  .regex(/^[^.]+(?:\.[^.]+)*$/, "must be a dot path with non-empty segments");
const timestampSchema = z.string().datetime({ offset: true });
const jsonScalarSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

export const ConditionSchema = z
  .object({
    path: dotPathSchema,
    op: z.enum(["eq", "ne", "gt", "gte", "lt", "lte"]),
    value: jsonScalarSchema,
  })
  .strict();

const createCommonShape = {
  serviceId: serviceIdSchema,
  sourceCommit: sourceCommitSchema.optional(),
  file: sourceFileSchema,
  line: z.number().int().positive(),
  condition: ConditionSchema.optional(),
  ttlSeconds: z.number().int().positive().default(DEFAULT_TTL_SECONDS),
  createdBy: z.string().trim().min(1).max(500),
} as const;

export const CreateProbeSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...createCommonShape,
      type: z.literal("snapshot"),
      watchPaths: z.array(dotPathSchema).max(100).optional(),
      hitLimit: z.number().int().positive().default(1),
    })
    .strict(),
  z
    .object({
      ...createCommonShape,
      type: z.literal("log"),
      template: z.string().min(1).max(16_384),
      hitLimit: z.number().int().positive().default(100),
    })
    .strict(),
  z
    .object({
      ...createCommonShape,
      type: z.literal("counter"),
      hitLimit: z.number().int().positive().default(10_000),
    })
    .strict(),
  z
    .object({
      ...createCommonShape,
      type: z.literal("metric"),
      metricPath: dotPathSchema,
      hitLimit: z.number().int().positive().default(10_000),
    })
    .strict(),
]);

const definitionCommonShape = {
  id: probeIdSchema,
  serviceId: serviceIdSchema,
  sourceCommit: sourceCommitSchema.optional(),
  file: sourceFileSchema,
  line: z.number().int().positive(),
  condition: ConditionSchema.optional(),
  ttlSeconds: z.number().int().positive(),
  hitLimit: z.number().int().positive(),
  version: z.number().int().positive(),
  createdBy: z.string().trim().min(1).max(500),
} as const;

export const ProbeDefinitionSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...definitionCommonShape,
      type: z.literal("snapshot"),
      watchPaths: z.array(dotPathSchema).max(100).optional(),
    })
    .strict(),
  z
    .object({
      ...definitionCommonShape,
      type: z.literal("log"),
      template: z.string().min(1).max(16_384),
    })
    .strict(),
  z
    .object({
      ...definitionCommonShape,
      type: z.literal("counter"),
    })
    .strict(),
  z
    .object({
      ...definitionCommonShape,
      type: z.literal("metric"),
      metricPath: dotPathSchema,
    })
    .strict(),
]);

export type CreateProbeInput = z.infer<typeof CreateProbeSchema>;
export type ProbeDefinition = z.infer<typeof ProbeDefinitionSchema>;
export type ProbeType = ProbeDefinition["type"];

export type SerializedNode =
  | { t: "str"; v: string }
  | { t: "num"; v: number }
  | { t: "bool"; v: boolean }
  | { t: "null"; v: null }
  | { t: "fn" }
  | { t: "redacted" }
  | {
      t: "truncated";
      v: "depth" | "array" | "props" | "string" | "circular" | "unsupported";
    }
  | {
      t: "obj";
      c: Record<string, SerializedNode>;
      m?: { t: "truncated"; v: "props" } | undefined;
    }
  | {
      t: "arr";
      c: SerializedNode[];
      m?: { t: "truncated"; v: "array" } | undefined;
    };

export const SerializedNodeSchema: z.ZodType<SerializedNode> = z.lazy(() =>
  z.discriminatedUnion("t", [
    z.object({ t: z.literal("str"), v: z.string() }).strict(),
    z.object({ t: z.literal("num"), v: z.number().finite() }).strict(),
    z.object({ t: z.literal("bool"), v: z.boolean() }).strict(),
    z.object({ t: z.literal("null"), v: z.null() }).strict(),
    z.object({ t: z.literal("fn") }).strict(),
    z.object({ t: z.literal("redacted") }).strict(),
    z
      .object({
        t: z.literal("truncated"),
        v: z.enum([
          "depth",
          "array",
          "props",
          "string",
          "circular",
          "unsupported",
        ]),
      })
      .strict(),
    z
      .object({
        t: z.literal("obj"),
        c: z.record(z.string(), SerializedNodeSchema),
        m: z
          .object({
            t: z.literal("truncated"),
            v: z.literal("props"),
          })
          .strict()
          .optional(),
      })
      .strict(),
    z
      .object({
        t: z.literal("arr"),
        c: z.array(SerializedNodeSchema),
        m: z
          .object({
            t: z.literal("truncated"),
            v: z.literal("array"),
          })
          .strict()
          .optional(),
      })
      .strict(),
  ]),
);

const stackFrameSchema = z
  .object({
    fn: z.string().max(1_024),
    file: z.string().max(4_096),
    line: z.number().int().positive(),
  })
  .strict();

export const StatusNameSchema = z.enum([
  "armed",
  "error",
  "hit-limit-reached",
  "suspended",
  "expired",
]);

const eventCommonShape = {
  probeId: probeIdSchema,
  ts: timestampSchema,
} as const;

export const ProbeEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...eventCommonShape,
      type: z.literal("snapshot"),
      variables: SerializedNodeSchema,
      watches: z.record(z.string(), SerializedNodeSchema),
      stack: z.array(stackFrameSchema).max(8),
    })
    .strict(),
  z
    .object({
      ...eventCommonShape,
      type: z.literal("log"),
      message: z.string().max(65_536),
      level: z.enum(["debug", "info", "warn", "error"]),
    })
    .strict(),
  z
    .object({
      ...eventCommonShape,
      type: z.literal("counter"),
      delta: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      ...eventCommonShape,
      type: z.literal("metric"),
      count: z.number().int().positive(),
      sum: z.number().finite(),
      min: z.number().finite(),
      max: z.number().finite(),
      last: z.number().finite(),
    })
    .strict()
    .superRefine((event, context) => {
      if (event.min > event.max) {
        context.addIssue({
          code: "custom",
          message: "metric min must be less than or equal to max",
          path: ["min"],
        });
      }
    }),
  z
    .object({
      ...eventCommonShape,
      type: z.literal("status"),
      status: StatusNameSchema,
      detail: z.string().max(4_096).optional(),
    })
    .strict(),
]);

export type ProbeEvent = z.infer<typeof ProbeEventSchema>;
export type ProbeStatusName = z.infer<typeof StatusNameSchema>;

export const AgentStatusSchema = z
  .object({
    state: z.enum(["green", "red"]),
    detail: z.string().max(4_096).optional(),
  })
  .strict();

export const IngestSchema = z
  .object({
    serviceId: serviceIdSchema,
    sdk: z.enum(["node", "python", "jvm"]),
    agentStatus: AgentStatusSchema,
    events: z.array(ProbeEventSchema).max(10_000),
  })
  .strict();

export type AgentSdk = z.infer<typeof IngestSchema>["sdk"];
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export interface ProbeStatus {
  status: ProbeStatusName;
  updatedAt: string;
  detail?: string | undefined;
}

export interface ServiceRecord {
  serviceId: string;
  lastSeen: string;
  sdk?: AgentSdk | undefined;
  agentStatus?: AgentStatus | undefined;
}

interface StoredProbe {
  probe: ProbeDefinition;
  expiresAt: number;
  expired: boolean;
}

type ActivityReason = "activity" | "timeout" | "aborted";
type ActivityListener = (reason: ActivityReason) => void;

export interface BrokerStateOptions {
  clock?: () => number;
  idGenerator?: (now: number) => string;
  ringCapacity?: number;
}

export interface PersistenceOptions {
  path: string;
  intervalMs?: number;
}

export interface BuildBrokerOptions {
  logger?: FastifyServerOptions["logger"];
  state?: BrokerState;
  clock?: () => number;
  idGenerator?: (now: number) => string;
  ringCapacity?: number;
  ttlSweepIntervalMs?: number;
  persistence?: PersistenceOptions | false;
}

export interface StartBrokerOptions extends BuildBrokerOptions {
  host?: string;
  port?: number;
}

class BrokerHttpError extends Error {
  public constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BrokerHttpError";
  }
}

function encodeCrockford(value: bigint, length: number): string {
  let remaining = value;
  let output = "";
  for (let index = 0; index < length; index += 1) {
    const alphabetIndex = Number(remaining & 31n);
    output = `${CROCKFORD_BASE32[alphabetIndex]}${output}`;
    remaining >>= 5n;
  }
  return output;
}

/**
 * Generates a time-sortable, ULID-shaped identifier using cryptographic
 * randomness. It does not promise monotonic ordering for IDs created within
 * the same millisecond.
 */
export function createProbeId(now = Date.now()): string {
  if (!Number.isSafeInteger(now) || now < 0 || now > 0xffff_ffff_ffff) {
    throw new RangeError("now must fit in the ULID 48-bit timestamp field");
  }

  const timestamp = encodeCrockford(BigInt(now), 10);
  const randomness = encodeCrockford(
    BigInt(`0x${randomBytes(10).toString("hex")}`),
    16,
  );
  return `prb_${timestamp}${randomness}`;
}

const persistedStatusSchema = z
  .object({
    status: StatusNameSchema,
    updatedAt: timestampSchema,
    detail: z.string().max(4_096).optional(),
  })
  .strict();

const persistedServiceSchema = z
  .object({
    serviceId: serviceIdSchema,
    lastSeen: timestampSchema,
    sdk: z.enum(["node", "python", "jvm"]).optional(),
    agentStatus: AgentStatusSchema.optional(),
  })
  .strict();

const snapshotSchema = z
  .object({
    formatVersion: z.literal(1),
    savedAt: timestampSchema,
    probes: z.array(
      z
        .object({
          probe: ProbeDefinitionSchema,
          expiresAt: z.number().int().nonnegative(),
          expired: z.boolean(),
        })
        .strict(),
    ),
    serviceVersions: z.array(
      z.tuple([serviceIdSchema, z.number().int().nonnegative()]),
    ),
    events: z.array(
      z
        .object({
          probeId: probeIdSchema,
          values: z.array(ProbeEventSchema),
        })
        .strict(),
    ),
    services: z.array(persistedServiceSchema),
    statuses: z.array(z.tuple([probeIdSchema, persistedStatusSchema])),
  })
  .strict();

export class BrokerState {
  private readonly probes = new Map<string, StoredProbe>();
  private readonly serviceVersions = new Map<string, number>();
  private readonly events = new Map<string, ProbeEvent[]>();
  private readonly services = new Map<string, ServiceRecord>();
  private readonly statuses = new Map<string, ProbeStatus>();
  private readonly listeners = new Map<string, Set<ActivityListener>>();
  private readonly clock: () => number;
  private readonly idGenerator: (now: number) => string;
  private readonly ringCapacity: number;

  public constructor(options: BrokerStateOptions = {}) {
    this.clock = options.clock ?? Date.now;
    this.idGenerator = options.idGenerator ?? createProbeId;
    this.ringCapacity = options.ringCapacity ?? DEFAULT_RING_CAPACITY;
    if (!Number.isInteger(this.ringCapacity) || this.ringCapacity <= 0) {
      throw new RangeError("ringCapacity must be a positive integer");
    }
  }

  public now(): number {
    return this.clock();
  }

  public timestamp(): string {
    return new Date(this.now()).toISOString();
  }

  public createProbe(input: CreateProbeInput): ProbeDefinition {
    const now = this.now();
    let id = this.idGenerator(now);
    for (let attempt = 0; this.probes.has(id); attempt += 1) {
      if (attempt >= 10) {
        throw new Error("probe id generator repeatedly produced collisions");
      }
      id = this.idGenerator(now);
    }
    probeIdSchema.parse(id);

    const version = this.incrementServiceVersion(input.serviceId);
    const probe = ProbeDefinitionSchema.parse({ ...input, id, version });
    this.probes.set(id, {
      probe,
      expiresAt: now + probe.ttlSeconds * 1_000,
      expired: false,
    });
    this.events.set(id, []);
    return probe;
  }

  public deleteProbe(id: string): boolean {
    const stored = this.probes.get(id);
    if (stored === undefined) {
      return false;
    }
    if (!stored.expired) {
      this.incrementServiceVersion(stored.probe.serviceId);
    }
    this.probes.delete(id);
    this.events.delete(id);
    this.statuses.delete(id);
    this.signalActivity(id);
    return true;
  }

  public listProbes(serviceId?: string): Array<{
    probe: ProbeDefinition;
    status: ProbeStatus | null;
  }> {
    this.expireDueProbes();
    const result: Array<{
      probe: ProbeDefinition;
      status: ProbeStatus | null;
    }> = [];
    for (const stored of this.probes.values()) {
      if (
        serviceId === undefined ||
        stored.probe.serviceId === serviceId
      ) {
        result.push({
          probe: stored.probe,
          status: this.statuses.get(stored.probe.id) ?? null,
        });
      }
    }
    return result;
  }

  public getProbe(id: string): ProbeDefinition | undefined {
    this.expireDueProbes();
    return this.probes.get(id)?.probe;
  }

  public pollProbes(
    serviceId: string,
    since: number,
  ):
    | { version: number; unchanged: true }
    | { version: number; probes: ProbeDefinition[] } {
    this.expireDueProbes();
    this.touchService(serviceId);
    const version = this.serviceVersions.get(serviceId) ?? 0;
    if (since === version) {
      return { version, unchanged: true };
    }
    const probes = [...this.probes.values()]
      .filter(
        (stored) =>
          stored.probe.serviceId === serviceId && !stored.expired,
      )
      .map((stored) => stored.probe);
    return { version, probes };
  }

  public ingest(input: z.infer<typeof IngestSchema>): number {
    this.expireDueProbes();
    for (const event of input.events) {
      const stored = this.probes.get(event.probeId);
      if (stored === undefined) {
        throw new BrokerHttpError(
          400,
          "invalid_request",
          `event references unknown probe ${event.probeId}`,
        );
      }
      if (stored.probe.serviceId !== input.serviceId) {
        throw new BrokerHttpError(
          400,
          "invalid_request",
          `probe ${event.probeId} does not belong to service ${input.serviceId}`,
        );
      }
      if (event.type !== "status" && event.type !== stored.probe.type) {
        throw new BrokerHttpError(
          400,
          "invalid_request",
          `event type ${event.type} does not match ${stored.probe.type} probe`,
        );
      }
      if (
        event.type === "metric" &&
        (event.sum < event.min * event.count ||
          event.sum > event.max * event.count)
      ) {
        throw new BrokerHttpError(
          400,
          "invalid_request",
          "metric sum is inconsistent with count, min, and max",
        );
      }
    }

    this.touchService(input.serviceId, input.sdk, input.agentStatus);
    for (const event of input.events) {
      this.appendEvent(event);
      if (event.type === "status") {
        const status: ProbeStatus = {
          status: event.status,
          updatedAt: event.ts,
          ...(event.detail === undefined ? {} : { detail: event.detail }),
        };
        this.statuses.set(event.probeId, status);
      }
    }
    return input.events.length;
  }

  public listServices(): ServiceRecord[] {
    return [...this.services.values()].sort((left, right) =>
      left.serviceId.localeCompare(right.serviceId),
    );
  }

  public getEvents(id: string): ProbeEvent[] {
    return [...(this.events.get(id) ?? [])];
  }

  public getStatus(id: string): ProbeStatus | null {
    return this.statuses.get(id) ?? null;
  }

  public waitForActivity(
    probeId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ActivityReason> {
    return this.registerActivityListener(
      probeId,
      timeoutMs,
      signal,
      false,
    );
  }

  /**
   * Atomically waits only when a probe has no retained events.
   *
   * The listener is installed before the ring is checked. An event that
   * arrives before registration is observed by the post-registration check;
   * an event that arrives afterwards signals the installed listener.
   */
  public waitForEvents(
    probeId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ActivityReason> {
    return this.registerActivityListener(
      probeId,
      timeoutMs,
      signal,
      true,
    );
  }

  private registerActivityListener(
    probeId: string,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    resolveForRetainedEvents: boolean,
  ): Promise<ActivityReason> {
    if (timeoutMs <= 0) {
      return Promise.resolve("timeout");
    }

    return new Promise<ActivityReason>((resolvePromise) => {
      let settled = false;
      let timeout: NodeJS.Timeout | undefined;
      const listeners =
        this.listeners.get(probeId) ?? new Set<ActivityListener>();

      const finish = (reason: ActivityReason): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }
        listeners.delete(finish);
        if (listeners.size === 0) {
          this.listeners.delete(probeId);
        }
        signal?.removeEventListener("abort", onAbort);
        resolvePromise(reason);
      };
      const onAbort = (): void => {
        finish("aborted");
      };

      listeners.add(finish);
      this.listeners.set(probeId, listeners);
      timeout = setTimeout(() => {
        finish("timeout");
      }, timeoutMs);
      timeout.unref();

      if (signal?.aborted === true) {
        finish("aborted");
      } else {
        signal?.addEventListener("abort", onAbort, { once: true });
      }

      if (
        !settled &&
        resolveForRetainedEvents &&
        (this.events.get(probeId)?.length ?? 0) > 0
      ) {
        finish("activity");
      }
    });
  }

  public pendingLongPollCount(probeId?: string): number {
    if (probeId !== undefined) {
      return this.listeners.get(probeId)?.size ?? 0;
    }
    let total = 0;
    for (const listeners of this.listeners.values()) {
      total += listeners.size;
    }
    return total;
  }

  public expireDueProbes(): number {
    const now = this.now();
    let expired = 0;
    for (const stored of this.probes.values()) {
      if (!stored.expired && stored.expiresAt <= now) {
        stored.expired = true;
        expired += 1;
        this.incrementServiceVersion(stored.probe.serviceId);
        const status: ProbeStatus = {
          status: "expired",
          updatedAt: new Date(now).toISOString(),
        };
        this.statuses.set(stored.probe.id, status);
        this.appendEvent({
          probeId: stored.probe.id,
          type: "status",
          ts: status.updatedAt,
          status: "expired",
        });
      }
    }
    return expired;
  }

  public async restore(path: string): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return;
      }
      throw error;
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(raw) as unknown;
    } catch (error: unknown) {
      throw new Error(`invalid broker snapshot JSON at ${path}`, {
        cause: error,
      });
    }
    const snapshot = snapshotSchema.parse(decoded);

    this.probes.clear();
    this.serviceVersions.clear();
    this.events.clear();
    this.services.clear();
    this.statuses.clear();

    for (const stored of snapshot.probes) {
      this.probes.set(stored.probe.id, stored);
    }
    for (const [serviceId, version] of snapshot.serviceVersions) {
      this.serviceVersions.set(serviceId, version);
    }
    for (const entry of snapshot.events) {
      this.events.set(
        entry.probeId,
        entry.values.slice(-this.ringCapacity),
      );
    }
    for (const service of snapshot.services) {
      this.services.set(service.serviceId, service);
    }
    for (const [probeId, status] of snapshot.statuses) {
      this.statuses.set(probeId, status);
    }
    this.expireDueProbes();
  }

  public async persist(path: string): Promise<void> {
    const snapshot = snapshotSchema.parse({
      formatVersion: 1,
      savedAt: this.timestamp(),
      probes: [...this.probes.values()],
      serviceVersions: [...this.serviceVersions.entries()],
      events: [...this.events.entries()].map(([probeId, values]) => ({
        probeId,
        values,
      })),
      services: [...this.services.values()],
      statuses: [...this.statuses.entries()],
    });
    const target = resolve(path);
    const temporary = `${target}.${process.pid}.tmp`;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(temporary, `${JSON.stringify(snapshot)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, target);
  }

  public dispose(): void {
    for (const listeners of this.listeners.values()) {
      for (const listener of [...listeners]) {
        listener("aborted");
      }
    }
    this.listeners.clear();
  }

  private incrementServiceVersion(serviceId: string): number {
    const version = (this.serviceVersions.get(serviceId) ?? 0) + 1;
    this.serviceVersions.set(serviceId, version);
    return version;
  }

  private touchService(
    serviceId: string,
    sdk?: AgentSdk,
    agentStatus?: AgentStatus,
  ): void {
    const previous = this.services.get(serviceId);
    const service: ServiceRecord = {
      serviceId,
      lastSeen: this.timestamp(),
      ...(sdk === undefined
        ? previous?.sdk === undefined
          ? {}
          : { sdk: previous.sdk }
        : { sdk }),
      ...(agentStatus === undefined
        ? previous?.agentStatus === undefined
          ? {}
          : { agentStatus: previous.agentStatus }
        : { agentStatus }),
    };
    this.services.set(serviceId, service);
  }

  private appendEvent(event: ProbeEvent): void {
    const buffer = this.events.get(event.probeId) ?? [];
    buffer.push(event);
    if (buffer.length > this.ringCapacity) {
      buffer.splice(0, buffer.length - this.ringCapacity);
    }
    this.events.set(event.probeId, buffer);
    this.signalActivity(event.probeId);
  }

  private signalActivity(probeId: string): void {
    const listeners = this.listeners.get(probeId);
    if (listeners === undefined) {
      return;
    }
    for (const listener of [...listeners]) {
      listener("activity");
    }
  }
}

const pollParamsSchema = z
  .object({ serviceId: serviceIdSchema })
  .strict();
const pollQuerySchema = z
  .object({
    since: z.coerce.number().int().nonnegative().default(0),
  })
  .strict();
const probeParamsSchema = z.object({ id: probeIdSchema }).strict();
const listProbeQuerySchema = z
  .object({ serviceId: serviceIdSchema.optional() })
  .strict();
const dataQuerySchema = z
  .object({
    waitSeconds: z.coerce.number().finite().default(0),
  })
  .strict();
const emptyQuerySchema = z.object({}).strict();

export async function buildBroker(
  options: BuildBrokerOptions = {},
): Promise<FastifyInstance> {
  const state =
    options.state ??
    new BrokerState({
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(options.idGenerator === undefined
        ? {}
        : { idGenerator: options.idGenerator }),
      ...(options.ringCapacity === undefined
        ? {}
        : { ringCapacity: options.ringCapacity }),
    });
  const persistence = options.persistence ?? false;
  if (persistence !== false) {
    await state.restore(persistence.path);
  }

  const app = Fastify({
    logger: options.logger ?? false,
  });
  app.decorate("liveprobeState", state);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      const first = error.issues[0];
      const path =
        first === undefined || first.path.length === 0
          ? ""
          : `${first.path.join(".")}: `;
      void reply.status(400).send({
        error: {
          code: "invalid_request",
          message: `${path}${first?.message ?? "invalid request"}`,
        },
      });
      return;
    }
    if (error instanceof BrokerHttpError) {
      void reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message },
      });
      return;
    }
    if (
      error instanceof Error &&
      "statusCode" in error &&
      typeof error.statusCode === "number" &&
      error.statusCode >= 400 &&
      error.statusCode < 500
    ) {
      void reply.status(error.statusCode).send({
        error: {
          code: "invalid_request",
          message: error.message,
        },
      });
      return;
    }
    request.log.error({ err: error }, "broker request failed");
    void reply.status(500).send({
      error: {
        code: "internal_error",
        message: "internal broker error",
      },
    });
  });

  app.post("/v1/probes", async (request, reply) => {
    emptyQuerySchema.parse(request.query);
    const input = CreateProbeSchema.parse(request.body);
    const probe = state.createProbe(input);
    return reply.status(201).send({ probe });
  });

  app.delete("/v1/probes/:id", async (request, reply) => {
    emptyQuerySchema.parse(request.query);
    const { id } = probeParamsSchema.parse(request.params);
    state.deleteProbe(id);
    return reply.status(204).send();
  });

  app.get("/v1/probes", async (request) => {
    const { serviceId } = listProbeQuerySchema.parse(request.query);
    return { probes: state.listProbes(serviceId) };
  });

  app.get("/v1/services", async (request) => {
    emptyQuerySchema.parse(request.query);
    return { services: state.listServices() };
  });

  app.get(
    "/v1/services/:serviceId/probes",
    async (request) => {
      const { serviceId } = pollParamsSchema.parse(request.params);
      const { since } = pollQuerySchema.parse(request.query);
      return state.pollProbes(serviceId, since);
    },
  );

  app.post("/v1/ingest", async (request, reply) => {
    emptyQuerySchema.parse(request.query);
    const input = IngestSchema.parse(request.body);
    const accepted = state.ingest(input);
    return reply.status(202).send({ accepted });
  });

  app.get("/v1/probes/:id/data", async (request, reply) => {
    const { id } = probeParamsSchema.parse(request.params);
    const query = dataQuerySchema.parse(request.query);
    const waitSeconds = Math.min(30, Math.max(0, query.waitSeconds));
    let probe = state.getProbe(id);
    if (probe === undefined) {
      throw new BrokerHttpError(404, "not_found", `probe ${id} was not found`);
    }

    if (waitSeconds > 0) {
      const abortController = new AbortController();
      const abort = (): void => {
        abortController.abort();
      };
      request.raw.once("aborted", abort);
      request.raw.socket.once("close", abort);
      try {
        await state.waitForEvents(
          id,
          Math.round(waitSeconds * 1_000),
          abortController.signal,
        );
      } finally {
        request.raw.off("aborted", abort);
        request.raw.socket.off("close", abort);
      }
      probe = state.getProbe(id);
      if (probe === undefined) {
        throw new BrokerHttpError(
          404,
          "not_found",
          `probe ${id} was removed while waiting`,
        );
      }
    }

    return reply.send({
      probe,
      status: state.getStatus(id),
      events: state.getEvents(id),
    });
  });

  const ttlSweepIntervalMs =
    options.ttlSweepIntervalMs ?? DEFAULT_TTL_SWEEP_INTERVAL_MS;
  if (
    !Number.isInteger(ttlSweepIntervalMs) ||
    ttlSweepIntervalMs <= 0
  ) {
    throw new RangeError("ttlSweepIntervalMs must be a positive integer");
  }
  const ttlTimer = setInterval(() => {
    state.expireDueProbes();
  }, ttlSweepIntervalMs);
  ttlTimer.unref();

  let persistenceTimer: NodeJS.Timeout | undefined;
  let pendingPersistence: Promise<void> = Promise.resolve();
  if (persistence !== false) {
    const intervalMs =
      persistence.intervalMs ?? DEFAULT_SNAPSHOT_INTERVAL_MS;
    if (!Number.isInteger(intervalMs) || intervalMs <= 0) {
      clearInterval(ttlTimer);
      throw new RangeError(
        "persistence.intervalMs must be a positive integer",
      );
    }
    persistenceTimer = setInterval(() => {
      pendingPersistence = pendingPersistence
        .then(() => state.persist(persistence.path))
        .catch((error: unknown) => {
          app.log.error({ err: error }, "failed to persist broker snapshot");
        });
    }, intervalMs);
    persistenceTimer.unref();
  }

  app.addHook("onClose", async () => {
    clearInterval(ttlTimer);
    if (persistenceTimer !== undefined) {
      clearInterval(persistenceTimer);
      await pendingPersistence;
      await state.persist(persistence === false ? "" : persistence.path);
    }
    state.dispose();
  });

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    liveprobeState: BrokerState;
  }
}

export async function startBroker(
  options: StartBrokerOptions = {},
): Promise<FastifyInstance> {
  const app = await buildBroker(options);
  await app.listen({
    host: options.host ?? "127.0.0.1",
    port: options.port ?? 7_070,
  });
  return app;
}

function optionalPositiveInteger(
  value: string | undefined,
  name: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const port = optionalPositiveInteger(process.env["PORT"], "PORT") ?? 7_070;
  const snapshotIntervalMs = optionalPositiveInteger(
    process.env["LIVEPROBE_SNAPSHOT_INTERVAL_MS"],
    "LIVEPROBE_SNAPSHOT_INTERVAL_MS",
  );
  const persistencePath = process.env["LIVEPROBE_STATE_FILE"];
  const persistence =
    persistencePath === undefined || persistencePath.length === 0
      ? false
      : {
          path: persistencePath,
          ...(snapshotIntervalMs === undefined
            ? {}
            : { intervalMs: snapshotIntervalMs }),
        };
  const app = await startBroker({
    host: process.env["HOST"] ?? "0.0.0.0",
    port,
    logger: true,
    persistence,
  });
  app.log.info(
    {
      address: app.server.address(),
      persistence:
        persistence === false ? "disabled" : persistence.path,
    },
    "liveprobe broker listening",
  );
}

const executedPath = process.argv[1];
if (
  executedPath !== undefined &&
  import.meta.url === pathToFileURL(resolve(executedPath)).href
) {
  main().catch((error: unknown) => {
    console.error("[liveprobe] broker failed to start", error);
    process.exitCode = 1;
  });
}
