export interface ExtensionResourceRequirementPreview {
  id: string;
  kind: "structured_data" | "objects" | "jobs" | "knowledge";
  scope: "installation" | "project" | "space";
  operations: Array<{ id: string; meteringUnit: string }>;
  limits: { requestsPerMinute: number; maxConcurrent: number; maxBytesPerOperation: number };
  targets: string[];
}

const ID = /^[a-z][a-z0-9._-]{1,63}$/;

/** Build a display-only projection of untrusted manifest resource declarations. */
export function previewExtensionResourceRequirements(value: unknown): { requirements: ExtensionResourceRequirementPreview[]; invalid: boolean } {
  if (value === undefined) return { requirements: [], invalid: false };
  if (!Array.isArray(value) || value.length > 32) return { requirements: [], invalid: true };
  const requirements: ExtensionResourceRequirementPreview[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return { requirements: [], invalid: true };
    const row = candidate as Record<string, unknown>;
    if (typeof row.id !== "string" || !ID.test(row.id)
      || !["structured_data", "objects", "jobs", "knowledge"].includes(String(row.kind)) || row.apiVersion !== "1.0"
      || typeof row.scope !== "string" || !["project", "installation", "space"].includes(row.scope)
      || !Array.isArray(row.operations) || row.operations.length < 1 || row.operations.length > 32
      || !row.operations.every(operation => operation && typeof operation === "object" && !Array.isArray(operation)
        && typeof (operation as Record<string, unknown>).id === "string" && ID.test((operation as Record<string, unknown>).id as string)
        && ["request", "byte", "job"].includes(String((operation as Record<string, unknown>).meteringUnit)))
      || !row.limits || typeof row.limits !== "object" || Array.isArray(row.limits)) return { requirements: [], invalid: true };
    const limits = row.limits as Record<string, unknown>;
    if (!Number.isSafeInteger(limits.requestsPerMinute) || Number(limits.requestsPerMinute) < 1 || Number(limits.requestsPerMinute) > 1000
      || !Number.isSafeInteger(limits.maxConcurrent) || Number(limits.maxConcurrent) < 1 || Number(limits.maxConcurrent) > 64
      || !Number.isSafeInteger(limits.maxBytesPerOperation) || Number(limits.maxBytesPerOperation) < 1 || Number(limits.maxBytesPerOperation) > 10 * 1024 * 1024)
      return { requirements: [], invalid: true };
    const targets: string[] = [];
    if (row.kind === "structured_data") {
      const binding = row.binding as Record<string, unknown> | undefined;
      if (row.scope !== "project" || !binding || typeof binding.gadgetId !== "string" || !ID.test(binding.gadgetId) || !Array.isArray(binding.tables)
        || binding.tables.length < 1 || binding.tables.length > 64 || new Set(binding.tables).size !== binding.tables.length
        || !binding.tables.every(table => typeof table === "string" && /^[a-z][a-z0-9_-]{0,62}$/.test(table))) return { requirements: [], invalid: true };
      targets.push(`${binding.gadgetId} · tables: ${(binding.tables as string[]).join(", ") || "none"}`);
    } else if (row.kind === "jobs") {
      const binding = row.binding as Record<string, unknown> | undefined;
      if (row.scope !== "project" || !binding || !Array.isArray(binding.workflowIds) || binding.workflowIds.length < 1 || binding.workflowIds.length > 32
        || new Set(binding.workflowIds).size !== binding.workflowIds.length || !binding.workflowIds.every(id => typeof id === "string" && ID.test(id))) return { requirements: [], invalid: true };
      targets.push(`workflows: ${(binding.workflowIds as string[]).join(", ") || "none"}`);
    } else if (row.kind === "knowledge") {
      const binding = row.binding as Record<string, unknown> | undefined;
      if (row.scope !== "project" || !binding || Object.keys(binding).some(key => key !== "publicationIds")
        || !Array.isArray(binding.publicationIds) || binding.publicationIds.length < 1 || binding.publicationIds.length > 16
        || new Set(binding.publicationIds).size !== binding.publicationIds.length
        || !binding.publicationIds.every(id => typeof id === "string" && /^[a-z][a-z0-9_-]{2,63}$/.test(id))) return { requirements: [], invalid: true };
      targets.push(`published Knowledge: ${(binding.publicationIds as string[]).join(", ")}`);
    } else if (row.binding !== undefined) {
      return { requirements: [], invalid: true };
    }
    requirements.push({ id: row.id, kind: row.kind as ExtensionResourceRequirementPreview["kind"], scope: row.scope as ExtensionResourceRequirementPreview["scope"],
      operations: (row.operations as Array<Record<string, string>>).map(operation => ({ id: operation.id!, meteringUnit: operation.meteringUnit! })),
      limits: { requestsPerMinute: limits.requestsPerMinute as number, maxConcurrent: limits.maxConcurrent as number,
        maxBytesPerOperation: limits.maxBytesPerOperation as number }, targets });
  }
  return { requirements, invalid: false };
}
