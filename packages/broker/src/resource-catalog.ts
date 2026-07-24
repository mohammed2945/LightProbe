import type { ResourceScope } from "./auth.js";

export interface ProjectRecord {
  tenantId: string;
  projectId: string;
  displayName: string;
  createdAt: string;
  archivedAt?: string | undefined;
}

export interface EnvironmentRecord extends ResourceScope {
  displayName: string;
  createdAt: string;
  archivedAt?: string | undefined;
}

export interface RegisteredServiceRecord {
  tenantId: string;
  projectId: string;
  serviceId: string;
  displayName: string;
  createdAt: string;
  archivedAt?: string | undefined;
}
