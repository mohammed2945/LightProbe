import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const serviceIdSchema = z.string().trim().min(1).max(200);
const sourceFileSchema = z.string().trim().min(1).max(4_096);
const commitHashSchema = z
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
  .regex(/^[^.]+(?:\.[^.]+)*$/, "must be a valid dot path");
const probeIdSchema = z
  .string()
  .regex(/^prb_[0-9A-HJKMNP-TV-Z]{26}$/, "must be a LiveProbe probe ID");
const scalarSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

export const McpConditionSchema = z
  .object({
    path: dotPathSchema.describe(
      "Dot path in captured variables, such as user.tier",
    ),
    op: z
      .enum(["eq", "ne", "gt", "gte", "lt", "lte"])
      .describe("Pure comparison performed after capture"),
    value: scalarSchema.describe("JSON scalar to compare without coercion"),
  })
  .strict();

const commonInputShape = {
  service_id: serviceIdSchema.describe("Target service from list_services"),
  commit_hash: commitHashSchema.describe(
    "User-supplied deployed commit SHA retained as audit metadata; not runtime proof",
  ),
  file: sourceFileSchema.describe(
    "Source path suffix as known by the target runtime",
  ),
  line: z.number().int().positive().describe("One-based source line"),
  condition: McpConditionSchema.optional().describe(
    "Optional read-only post-capture condition; no target code is evaluated",
  ),
  hit_limit: z.number().int().positive().optional(),
  ttl_seconds: z.number().int().positive().optional().default(1_800),
  created_by: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .optional()
    .default("mcp:liveprobe"),
} as const;

export const SetSnapshotProbeInputSchema = z
  .object({
    ...commonInputShape,
    watch_paths: z
      .array(dotPathSchema)
      .max(100)
      .optional()
      .describe("Extra dot paths to capture alongside local variables"),
  })
  .strict();

export const SetLogProbeInputSchema = z
  .object({
    ...commonInputShape,
    template: z
      .string()
      .min(1)
      .max(16_384)
      .describe(
        "Log template with optional ${dot.path} placeholders resolved read-only",
      ),
  })
  .strict();

export const SetCounterProbeInputSchema = z
  .object(commonInputShape)
  .strict();

export const SetMetricProbeInputSchema = z
  .object({
    ...commonInputShape,
    metric_path: dotPathSchema.describe(
      "Dot path that resolves to the numeric value to aggregate",
    ),
  })
  .strict();

export const ListServicesInputSchema = z.object({}).strict();
export const ListProbesInputSchema = z
  .object({
    service_id: serviceIdSchema.optional(),
  })
  .strict();
export const GetProbeDataInputSchema = z
  .object({
    probe_id: probeIdSchema,
    wait_seconds: z
      .number()
      .finite()
      .min(0)
      .max(30)
      .optional()
      .default(0)
      .describe(
        "Long-poll duration; returns immediately when retained data already exists",
      ),
  })
  .strict();
export const RemoveProbeInputSchema = z
  .object({
    probe_id: probeIdSchema,
  })
  .strict();

const conditionResponseSchema = z
  .object({
    path: z.string(),
    op: z.enum(["eq", "ne", "gt", "gte", "lt", "lte"]),
    value: scalarSchema,
  })
  .strict();

const definitionCommonShape = {
  id: probeIdSchema,
  serviceId: serviceIdSchema,
  sourceCommit: commitHashSchema.optional(),
  file: sourceFileSchema,
  line: z.number().int().positive(),
  condition: conditionResponseSchema.optional(),
  hitLimit: z.number().int().positive(),
  ttlSeconds: z.number().int().positive(),
  version: z.number().int().positive(),
  createdBy: z.string().min(1),
} as const;

export const BrokerProbeDefinitionSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...definitionCommonShape,
      type: z.literal("snapshot"),
      watchPaths: z.array(z.string()).optional(),
    })
    .strict(),
  z
    .object({
      ...definitionCommonShape,
      type: z.literal("log"),
      template: z.string(),
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
      metricPath: z.string(),
    })
    .strict(),
]);

const probeStatusSchema = z
  .object({
    status: z.enum([
      "armed",
      "error",
      "hit-limit-reached",
      "suspended",
      "expired",
    ]),
    updatedAt: z.string().datetime({ offset: true }),
    detail: z.string().optional(),
  })
  .strict();

const serviceSchema = z
  .object({
    serviceId: serviceIdSchema,
    sdk: z.enum(["node", "python", "jvm"]).optional(),
    lastSeen: z.string().datetime({ offset: true }),
    agentStatus: z
      .object({
        state: z.enum(["green", "red"]),
        detail: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const probeEventResponseSchema = z.record(z.string(), z.json());

const createProbeResponseSchema = z
  .object({ probe: BrokerProbeDefinitionSchema })
  .strict();
const listServicesResponseSchema = z
  .object({ services: z.array(serviceSchema) })
  .strict();
const listProbesResponseSchema = z
  .object({
    probes: z.array(
      z
        .object({
          probe: BrokerProbeDefinitionSchema,
          status: probeStatusSchema.nullable(),
        })
        .strict(),
    ),
  })
  .strict();
const probeDataResponseSchema = z
  .object({
    probe: BrokerProbeDefinitionSchema,
    status: probeStatusSchema.nullable(),
    events: z.array(probeEventResponseSchema),
  })
  .strict();

export type BrokerProbeDefinition = z.infer<
  typeof BrokerProbeDefinitionSchema
>;
export type BrokerService = z.infer<typeof serviceSchema>;
export type BrokerProbeStatus = z.infer<typeof probeStatusSchema>;
export type BrokerProbeData = z.infer<typeof probeDataResponseSchema>;

type BrokerCondition = z.infer<typeof McpConditionSchema>;

export type BrokerCreateProbeInput =
  | {
      serviceId: string;
      sourceCommit: string;
      type: "snapshot";
      file: string;
      line: number;
      condition?: BrokerCondition;
      watchPaths?: string[];
      hitLimit?: number;
      ttlSeconds: number;
      createdBy: string;
    }
  | {
      serviceId: string;
      sourceCommit: string;
      type: "log";
      file: string;
      line: number;
      condition?: BrokerCondition;
      template: string;
      hitLimit?: number;
      ttlSeconds: number;
      createdBy: string;
    }
  | {
      serviceId: string;
      sourceCommit: string;
      type: "counter";
      file: string;
      line: number;
      condition?: BrokerCondition;
      hitLimit?: number;
      ttlSeconds: number;
      createdBy: string;
    }
  | {
      serviceId: string;
      sourceCommit: string;
      type: "metric";
      file: string;
      line: number;
      condition?: BrokerCondition;
      metricPath: string;
      hitLimit?: number;
      ttlSeconds: number;
      createdBy: string;
    };

export class BrokerClientError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "BrokerClientError";
  }
}

export interface BrokerClientOptions {
  fetchImplementation?: typeof fetch;
}

export class BrokerClient {
  private readonly baseUrl: string;
  private readonly fetchImplementation: typeof fetch;

  public constructor(
    brokerUrl: string,
    options: BrokerClientOptions = {},
  ) {
    const parsed = new URL(brokerUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("BROKER_URL must use http or https");
    }
    if (
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0
    ) {
      throw new Error(
        "BROKER_URL must not include credentials, query parameters, or a fragment",
      );
    }
    this.baseUrl = parsed.href.replace(/\/+$/, "");
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  public async createProbe(
    input: BrokerCreateProbeInput,
  ): Promise<BrokerProbeDefinition> {
    const result = await this.request(
      "POST",
      "/v1/probes",
      createProbeResponseSchema,
      input,
    );
    return result.probe;
  }

  public async listServices(): Promise<{ services: BrokerService[] }> {
    return this.request(
      "GET",
      "/v1/services",
      listServicesResponseSchema,
    );
  }

  public async listProbes(
    serviceId?: string,
  ): Promise<z.infer<typeof listProbesResponseSchema>> {
    const search =
      serviceId === undefined
        ? ""
        : `?${new URLSearchParams({ serviceId }).toString()}`;
    return this.request(
      "GET",
      `/v1/probes${search}`,
      listProbesResponseSchema,
    );
  }

  public async getProbeData(
    probeId: string,
    waitSeconds = 0,
  ): Promise<BrokerProbeData> {
    const search = new URLSearchParams({
      waitSeconds: String(waitSeconds),
    });
    return this.request(
      "GET",
      `/v1/probes/${encodeURIComponent(probeId)}/data?${search.toString()}`,
      probeDataResponseSchema,
    );
  }

  public async removeProbe(probeId: string): Promise<void> {
    await this.requestNoContent(
      "DELETE",
      `/v1/probes/${encodeURIComponent(probeId)}`,
    );
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
  ): Promise<T> {
    const response = await this.fetchImplementation(`${this.baseUrl}${path}`, {
      method,
      headers: {
        accept: "application/json",
        ...(body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      throw await this.toClientError(response);
    }
    return schema.parse(await response.json());
  }

  private async requestNoContent(
    method: "DELETE",
    path: string,
  ): Promise<void> {
    const response = await this.fetchImplementation(`${this.baseUrl}${path}`, {
      method,
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      throw await this.toClientError(response);
    }
    if (response.status !== 204) {
      throw new BrokerClientError(
        `broker returned HTTP ${response.status}; expected 204`,
        response.status,
      );
    }
  }

  private async toClientError(response: Response): Promise<BrokerClientError> {
    let message = `broker request failed with HTTP ${response.status}`;
    let code: string | undefined;
    try {
      const payload = z
        .object({
          error: z
            .object({
              code: z.string(),
              message: z.string(),
            })
            .strict(),
        })
        .strict()
        .parse(await response.json());
      message = payload.error.message;
      code = payload.error.code;
    } catch {
      // The status is still preserved when a proxy returns a non-protocol body.
    }
    return new BrokerClientError(
      message,
      response.status,
      ...(code === undefined ? [] : [code]),
    );
  }
}

type SetSnapshotInput = z.input<typeof SetSnapshotProbeInputSchema>;
type SetLogInput = z.input<typeof SetLogProbeInputSchema>;
type SetCounterInput = z.input<typeof SetCounterProbeInputSchema>;
type SetMetricInput = z.input<typeof SetMetricProbeInputSchema>;

export interface ToolHandlers {
  set_snapshot_probe(input: SetSnapshotInput): Promise<BrokerProbeDefinition>;
  set_log_probe(input: SetLogInput): Promise<BrokerProbeDefinition>;
  set_counter_probe(input: SetCounterInput): Promise<BrokerProbeDefinition>;
  set_metric_probe(input: SetMetricInput): Promise<BrokerProbeDefinition>;
  list_services(input?: unknown): Promise<{ services: BrokerService[] }>;
  list_probes(
    input: z.input<typeof ListProbesInputSchema>,
  ): Promise<z.infer<typeof listProbesResponseSchema>>;
  get_probe_data(
    input: z.input<typeof GetProbeDataInputSchema>,
  ): Promise<BrokerProbeData>;
  remove_probe(
    input: z.input<typeof RemoveProbeInputSchema>,
  ): Promise<{ removed: true; probeId: string }>;
}

function optionalCommonFields(input: {
  condition?: BrokerCondition | undefined;
  hit_limit?: number | undefined;
}): {
  condition?: BrokerCondition;
  hitLimit?: number;
} {
  return {
    ...(input.condition === undefined
      ? {}
      : { condition: input.condition }),
    ...(input.hit_limit === undefined ? {} : { hitLimit: input.hit_limit }),
  };
}

export function createToolHandlers(client: BrokerClient): ToolHandlers {
  return {
    async set_snapshot_probe(rawInput) {
      const input = SetSnapshotProbeInputSchema.parse(rawInput);
      return client.createProbe({
        serviceId: input.service_id,
        sourceCommit: input.commit_hash,
        type: "snapshot",
        file: input.file,
        line: input.line,
        ttlSeconds: input.ttl_seconds,
        createdBy: input.created_by,
        ...optionalCommonFields(input),
        ...(input.watch_paths === undefined
          ? {}
          : { watchPaths: input.watch_paths }),
      });
    },
    async set_log_probe(rawInput) {
      const input = SetLogProbeInputSchema.parse(rawInput);
      return client.createProbe({
        serviceId: input.service_id,
        sourceCommit: input.commit_hash,
        type: "log",
        file: input.file,
        line: input.line,
        template: input.template,
        ttlSeconds: input.ttl_seconds,
        createdBy: input.created_by,
        ...optionalCommonFields(input),
      });
    },
    async set_counter_probe(rawInput) {
      const input = SetCounterProbeInputSchema.parse(rawInput);
      return client.createProbe({
        serviceId: input.service_id,
        sourceCommit: input.commit_hash,
        type: "counter",
        file: input.file,
        line: input.line,
        ttlSeconds: input.ttl_seconds,
        createdBy: input.created_by,
        ...optionalCommonFields(input),
      });
    },
    async set_metric_probe(rawInput) {
      const input = SetMetricProbeInputSchema.parse(rawInput);
      return client.createProbe({
        serviceId: input.service_id,
        sourceCommit: input.commit_hash,
        type: "metric",
        file: input.file,
        line: input.line,
        metricPath: input.metric_path,
        ttlSeconds: input.ttl_seconds,
        createdBy: input.created_by,
        ...optionalCommonFields(input),
      });
    },
    async list_services(rawInput = {}) {
      ListServicesInputSchema.parse(rawInput);
      return client.listServices();
    },
    async list_probes(rawInput) {
      const input = ListProbesInputSchema.parse(rawInput);
      return client.listProbes(input.service_id);
    },
    async get_probe_data(rawInput) {
      const input = GetProbeDataInputSchema.parse(rawInput);
      return client.getProbeData(input.probe_id, input.wait_seconds);
    },
    async remove_probe(rawInput) {
      const input = RemoveProbeInputSchema.parse(rawInput);
      await client.removeProbe(input.probe_id);
      return { removed: true, probeId: input.probe_id };
    },
  };
}

function toolResult(value: unknown): {
  content: [{ type: "text"; text: string }];
} {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

const DEPLOYED_COMMIT_GUIDANCE =
  "Before creating this probe, if the deployed commit SHA is not already known, ask the user for it. When possible, validate that the revision exists in the local repository and inspect source at that exact revision before choosing file and line. commit_hash is user-supplied audit metadata, not runtime proof or runtime verification of the deployed code.";

export function createMcpServer(
  client: BrokerClient,
): McpServer {
  const handlers = createToolHandlers(client);
  const server = new McpServer({
    name: "liveprobe",
    version: "0.1.0",
  });

  server.registerTool(
    "set_snapshot_probe",
    {
      title: "Set snapshot probe",
      description: `${DEPLOYED_COMMIT_GUIDANCE} Use when you need local variables, selected watch paths, and a bounded stack from one source line. Snapshot probes default to one hit and never evaluate code in the target runtime.`,
      inputSchema: SetSnapshotProbeInputSchema,
      annotations: { destructiveHint: false },
    },
    async (input) => toolResult(await handlers.set_snapshot_probe(input)),
  );
  server.registerTool(
    "set_log_probe",
    {
      title: "Set dynamic log probe",
      description: `${DEPLOYED_COMMIT_GUIDANCE} Use to add a temporary diagnostic log at a source line without redeploying. \${dot.path} placeholders are resolved from captured data; no target-runtime expression is evaluated.`,
      inputSchema: SetLogProbeInputSchema,
      annotations: { destructiveHint: false },
    },
    async (input) => toolResult(await handlers.set_log_probe(input)),
  );
  server.registerTool(
    "set_counter_probe",
    {
      title: "Set counter probe",
      description: `${DEPLOYED_COMMIT_GUIDANCE} Use to measure how often a source line executes. Agents pre-aggregate hits, so this is preferable to snapshots on hot paths.`,
      inputSchema: SetCounterProbeInputSchema,
      annotations: { destructiveHint: false },
    },
    async (input) => toolResult(await handlers.set_counter_probe(input)),
  );
  server.registerTool(
    "set_metric_probe",
    {
      title: "Set metric probe",
      description: `${DEPLOYED_COMMIT_GUIDANCE} Use to aggregate count, sum, min, max, and last for one numeric dot path at a source line. Values are resolved read-only and pre-aggregated by the runtime agent.`,
      inputSchema: SetMetricProbeInputSchema,
      annotations: { destructiveHint: false },
    },
    async (input) => toolResult(await handlers.set_metric_probe(input)),
  );
  server.registerTool(
    "list_services",
    {
      title: "List live services",
      description:
        "List services recently seen by the broker, including runtime SDK, heartbeat time, and safety state. Use this before placing a probe to confirm the service ID.",
      inputSchema: ListServicesInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => toolResult(await handlers.list_services(input)),
  );
  server.registerTool(
    "list_probes",
    {
      title: "List probes",
      description:
        "List probe definitions and their latest status. Filter by service to diagnose armed, suspended, expired, line-not-found, or hit-limit states.",
      inputSchema: ListProbesInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => toolResult(await handlers.list_probes(input)),
  );
  server.registerTool(
    "get_probe_data",
    {
      title: "Get probe evidence",
      description:
        "Read retained probe events. Set wait_seconds (up to 30) to long-poll until the first event arrives, avoiding repeated polling while waiting for a line to execute.",
      inputSchema: GetProbeDataInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => toolResult(await handlers.get_probe_data(input)),
  );
  server.registerTool(
    "remove_probe",
    {
      title: "Remove probe",
      description:
        "Remove a probe when enough evidence has been collected. Deletion is idempotent and causes agents to uninstall it on their next poll.",
      inputSchema: RemoveProbeInputSchema,
      annotations: { destructiveHint: true },
    },
    async (input) => toolResult(await handlers.remove_probe(input)),
  );
  return server;
}

export async function startStdioServer(
  brokerUrl = process.env["BROKER_URL"] ?? "http://127.0.0.1:7070",
): Promise<McpServer> {
  const server = createMcpServer(new BrokerClient(brokerUrl));
  await server.connect(new StdioServerTransport());
  return server;
}

const executedPath = process.argv[1];
if (
  executedPath !== undefined &&
  import.meta.url === pathToFileURL(resolve(executedPath)).href
) {
  startStdioServer().catch((error: unknown) => {
    console.error("[liveprobe] MCP server failed", error);
    process.exitCode = 1;
  });
}
