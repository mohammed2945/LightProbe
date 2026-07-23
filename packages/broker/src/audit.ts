import type { BrokerPrincipal, ResourceScope } from "./auth.js";

export type AuditOutcome = "attempt" | "success" | "denied" | "error";

export type AuditMetadataValue = string | number | boolean | null;

export interface AuditEventRecord extends ResourceScope {
  auditId: string;
  occurredAt: string;
  requestId: string;
  actorType: BrokerPrincipal["type"];
  actorId: string;
  actorRole: BrokerPrincipal["role"];
  action: string;
  resourceType: string;
  resourceId?: string | undefined;
  outcome: AuditOutcome;
  statusCode?: number | undefined;
  errorCode?: string | undefined;
  metadata: Record<string, AuditMetadataValue>;
}

export interface AuditListOptions {
  limit: number;
  before?: string | undefined;
}
