export type Agent37InstanceType = "default" | "performance" | "vm";
export type Agent37Region = "us" | "eu" | "ap-south";
export interface Agent37ResourceLimit { cpu: number; memoryMiB: number; minDiskGiB: number; maxDiskGiB: number; }
export interface Agent37TemplateConstraints {
  provider: "agent37";
  region: Agent37Region;
  instanceType: Agent37InstanceType;
  capabilities: ["exec", "files"] | ["files", "exec"];
  resources: Agent37ResourceLimit[];
}

const supportedResources: Agent37ResourceLimit[] = [
  { cpu: 2, memoryMiB: 4096, minDiskGiB: 2, maxDiskGiB: 12 },
  { cpu: 4, memoryMiB: 8192, minDiskGiB: 2, maxDiskGiB: 20 },
  { cpu: 4, memoryMiB: 16384, minDiskGiB: 2, maxDiskGiB: 40 },
  { cpu: 4, memoryMiB: 32768, minDiskGiB: 2, maxDiskGiB: 80 },
];

export function parseAgent37TemplateConstraints(value: unknown): Agent37TemplateConstraints {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_template_constraints");
  const input = value as Record<string, unknown>;
  if (input.provider !== "agent37" || !["us", "eu", "ap-south"].includes(String(input.region)) ||
      !["default", "performance", "vm"].includes(String(input.instanceType)) ||
      !Array.isArray(input.capabilities) || input.capabilities.length !== 2 ||
      !input.capabilities.includes("exec") || !input.capabilities.includes("files") || !Array.isArray(input.resources) ||
      input.resources.length < 1 || input.resources.length > supportedResources.length) throw new Error("invalid_template_constraints");
  if (input.region !== "us" && input.instanceType === "default") throw new Error("unsupported_region_instance_type");
  const resources = input.resources.map((resource) => {
    if (!resource || typeof resource !== "object" || Array.isArray(resource)) throw new Error("invalid_template_constraints");
    const row = resource as Record<string, unknown>;
    if (![row.cpu, row.memoryMiB, row.minDiskGiB, row.maxDiskGiB].every((n) => typeof n === "number" && Number.isSafeInteger(n))) throw new Error("invalid_template_constraints");
    const cpu = row.cpu as number, memoryMiB = row.memoryMiB as number, minDiskGiB = row.minDiskGiB as number, maxDiskGiB = row.maxDiskGiB as number;
    const supported = supportedResources.find((candidate) => candidate.cpu === cpu && candidate.memoryMiB === memoryMiB);
    if (!supported || minDiskGiB < supported.minDiskGiB || maxDiskGiB > supported.maxDiskGiB || minDiskGiB > maxDiskGiB)
      throw new Error("unsupported_template_resource_limit");
    return { cpu, memoryMiB, minDiskGiB, maxDiskGiB };
  });
  return { provider: "agent37", region: input.region as Agent37Region, instanceType: input.instanceType as Agent37InstanceType,
    capabilities: ["exec", "files"], resources };
}

export function agent37TemplateAllows(constraints: Agent37TemplateConstraints, input: {
  region: string; instanceType: string; resources: { cpu: number; memoryMiB: number; diskGiB: number };
}): boolean {
  return constraints.region === input.region && constraints.instanceType === input.instanceType &&
    constraints.resources.some((r) => r.cpu === input.resources.cpu && r.memoryMiB === input.resources.memoryMiB &&
      input.resources.diskGiB >= r.minDiskGiB && input.resources.diskGiB <= r.maxDiskGiB);
}

export function validateAgent37TemplateEvidence(input: {
  digest: unknown; constraints: unknown; evidenceUrls: unknown; validUntil: unknown; now?: Date;
}): { digest: string; constraints: Agent37TemplateConstraints; evidenceUrls: string[]; validUntil: string } {
  const digest = typeof input.digest === "string" ? input.digest : "";
  if (!/^(?:sha256:)?[a-f0-9]{64}$/.test(digest)) throw new Error("invalid_template_digest");
  const constraints = parseAgent37TemplateConstraints(input.constraints);
  if (!Array.isArray(input.evidenceUrls) || input.evidenceUrls.length < 1 || input.evidenceUrls.length > 8) throw new Error("template_evidence_required");
  const evidenceUrls = input.evidenceUrls.map((value) => {
    if (typeof value !== "string" || value.length > 2048) throw new Error("invalid_template_evidence");
    let url: URL;
    try { url = new URL(value); } catch { throw new Error("invalid_template_evidence"); }
    if (url.protocol !== "https:" || !["agent37.com", "www.agent37.com"].includes(url.hostname) || url.username || url.password || url.hash)
      throw new Error("invalid_template_evidence");
    return url.toString();
  });
  if (typeof input.validUntil !== "string" || !Number.isFinite(Date.parse(input.validUntil))) throw new Error("invalid_template_validity");
  const validUntil = new Date(input.validUntil).toISOString();
  const now = input.now ?? new Date();
  const expires = Date.parse(validUntil);
  if (expires <= now.getTime() || expires > now.getTime() + 90 * 24 * 60 * 60 * 1000) throw new Error("template_validity_out_of_range");
  return { digest, constraints, evidenceUrls, validUntil };
}
