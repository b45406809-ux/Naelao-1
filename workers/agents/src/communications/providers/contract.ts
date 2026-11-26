// V-spec §8 provider adapter contract (MS-35 subset, plus MS-38 `listUpstreamResources`). Adapters live in providers/<provider>.ts.
// Only the members Naelao Email needs are declared here; optional members stay optional so later adapters can add them.

export type ProvisioningStrategy = "first_party" | "managed_master" | "native_subaccount" | "customer_connection";

export interface CapabilityDescriptor {
  /** Canonical operation name; matches the verified capability version's `operations_json`. */
  operation: string;
}

export interface OperationCtx {
  operation_id: string;
  /** Passed upstream as the provider idempotency key whenever the provider supports one (MR-ADP-2). */
  idempotency_key: string;
}

export interface ProviderResource {
  provider: string;
  service_id: string;
  resource_type: string;
  provider_resource_ref: string;
  status: "active" | "deleted";
  address?: string;
}

export interface Page<T> { items: T[]; /** Opaque; absent on the last page. */ next_cursor?: string }

export interface ProvisionReq {
  tenantId: string;
  region: string;
  /** The Billing reservation that covers this provision. Required: provisioning never runs unreserved. */
  reservationId: string;
  offeringId?: string;
  localPart?: string;
  displayName?: string;
  /** Billing scope of the requester. Needed (with `userId`) to enroll the resource in a subscription when MANAGED_SUBSCRIPTIONS_ENABLED. */
  spaceId?: string;
  projectId?: string | null;
  userId?: string;
}

export interface ProvisionResult { resource: ProviderResource; offering_id: string; capability_version: number }
export interface LookupReq { tenantId: string; provider_resource_ref: string }
export interface DeprovisionReq { tenantId: string; provider_resource_ref: string }
export interface AuthorizedExecution { tenantId: string; operation: string; provider_resource_ref: string; params?: Record<string, unknown> }
export interface ExecutionResult { operation: string; data: unknown }

export interface ProviderAdapterV1 {
  provider: string;
  capabilities(): CapabilityDescriptor[];
  provision?(req: ProvisionReq, op: OperationCtx): Promise<ProvisionResult>;
  lookup(req: LookupReq): Promise<ProviderResource | null>;
  deprovision?(req: DeprovisionReq, op: OperationCtx): Promise<void>;
  execute(req: AuthorizedExecution, op: OperationCtx): Promise<ExecutionResult>;
  /** MS-38 / MR-REC-2: read-only inventory of every resource the adapter's platform account holds upstream, one page per call. */
  listUpstreamResources?(cursor?: string): Promise<Page<ProviderResource>>;
}

/** MR-ADP-1: an unsupported operation throws; it never succeeds without doing anything. */
export class ProviderAdapterError extends Error {
  constructor(readonly code: string, message?: string) {
    super(message ? `${code}: ${message}` : code);
    this.name = "ProviderAdapterError";
  }
}

export const capabilityUnsupported = (operation: string) => new ProviderAdapterError("capability_unsupported", operation.slice(0, 80));
