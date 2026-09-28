import type { PrebuiltScript } from "./index.js";

export const CABINET_WORKERS = [
  "project_manager_worker",
  "treasury_worker",
  "identity_worker",
  "comms_worker",
] as const;

export type CabinetWorkerId = typeof CABINET_WORKERS[number];

/** Exact operation grants. Prefix matching is deliberately forbidden. */
export const CABINET_CAPABILITIES: Readonly<Record<CabinetWorkerId, ReadonlySet<string>>> = Object.freeze({
  project_manager_worker: new Set(["project.create", "project.archive", "project.create_from_template"]),
  treasury_worker: new Set(["wallet.get_balance", "wallet.request_payout", "billing.audit"]),
  identity_worker: new Set(["member.invite", "role.set_rank", "gatekeeper.issue_capability_token"]),
  comms_worker: new Set(["notify.email", "notify.slack", "notify.discord", "notify.whatsapp", "notify.telegram", "notify.apns", "notify.fcm", "announcement.publish"]),
});

export class CabinetCapabilityViolationError extends Error {
  constructor(workerId: CabinetWorkerId, operation: string) {
    super(`Capability violation: ${workerId} cannot invoke '${operation}'`);
    this.name = "CabinetCapabilityViolationError";
  }
}

function workerId(value: unknown): CabinetWorkerId {
  if (typeof value === "string" && (CABINET_WORKERS as readonly string[]).includes(value)) return value as CabinetWorkerId;
  throw new Error("Unknown executive cabinet worker");
}

function task(value: unknown): { operation: string; params: Record<string, unknown> } {
  let parsed = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); } catch { throw new Error("Cabinet task must be structured JSON"); }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Cabinet task must be an object");
  const input = parsed as Record<string, unknown>;
  if (typeof input["operation"] !== "string" || !input["operation"].trim()) throw new Error("Cabinet task.operation is required");
  const params = input["params"];
  if (params !== undefined && (!params || typeof params !== "object" || Array.isArray(params))) throw new Error("Cabinet task.params must be an object");
  return { operation: input["operation"], params: (params ?? {}) as Record<string, unknown> };
}

export const executiveCabinet: PrebuiltScript = {
  name: "executive-cabinet",
  description: "Delegate one structured administrative operation to a capability-isolated cabinet worker.",
  domain: "orchestration",
  requires_tier: 2,
  operations: {
    delegate_to_space_worker: async (args, context) => {
      const id = workerId(args["worker_id"]);
      const delegated = task(args["task"]);
      if (!CABINET_CAPABILITIES[id].has(delegated.operation)) {
        throw new CabinetCapabilityViolationError(id, delegated.operation);
      }
      // The worker receives only a closure for its already-authorized operation. It never
      // receives the parent context or a general-purpose run function.
      return context.run(delegated.operation, delegated.params);
    },
  },
  paramHints: {
    delegate_to_space_worker: "worker_id (required cabinet worker id), task ({ operation, params }, required).",
  },
};
