/** Cloudflare durable_object-policy sizing. Only host-approved requirements reach this selector.
 * No `basic` alias: the runtime supports lite and standard-1..4; custom sizes start at 1 vCPU.
 */
export const DYNAMIC_PROFILES = {
  lite: { cpuCores: 1 / 16, memoryMb: 256, diskGb: 2 },
  "standard-1": { cpuCores: .5, memoryMb: 4096, diskGb: 8 },
  "standard-2": { cpuCores: 1, memoryMb: 6144, diskGb: 12 },
  "standard-3": { cpuCores: 2, memoryMb: 8192, diskGb: 16 },
  "standard-4": { cpuCores: 4, memoryMb: 12288, diskGb: 20 },
} as const;
export type DynamicProfile = keyof typeof DYNAMIC_PROFILES;
export const CLOUDFLARE_IMAGE_PIN = /^registry\.cloudflare\.com\/[a-f0-9]{32}\/[a-z0-9][a-z0-9._/-]{0,127}@sha256:[a-f0-9]{64}$/;
export function isDynamicProfile(value: unknown): value is DynamicProfile {
  return typeof value === "string" && Object.hasOwn(DYNAMIC_PROFILES, value);
}
export function selectDynamicProfile(cpuCores: number, memoryMb: number): DynamicProfile {
  if (!Number.isFinite(cpuCores) || cpuCores <= 0 || !Number.isSafeInteger(memoryMb) || memoryMb <= 0)
    throw new Error("container_resources_invalid");
  for (const [name, size] of Object.entries(DYNAMIC_PROFILES))
    if (size.cpuCores >= cpuCores && size.memoryMb >= memoryMb) return name as DynamicProfile;
  throw new Error("container_resources_unsupported");
}
export function dynamicPlanLimits(tier: string): { maxProfile: DynamicProfile; concurrency: number } {
  switch (tier) {
    case "growth": return { maxProfile: "standard-2", concurrency: 3 };
    case "business": return { maxProfile: "standard-3", concurrency: 10 };
    case "enterprise": return { maxProfile: "standard-4", concurrency: 25 };
    default: return { maxProfile: "standard-1", concurrency: 1 };
  }
}
export function assertDynamicPlan(profile: DynamicProfile, tier: string): void {
  const max = DYNAMIC_PROFILES[dynamicPlanLimits(tier).maxProfile];
  const requested = DYNAMIC_PROFILES[profile];
  if (requested.cpuCores > max.cpuCores || requested.memoryMb > max.memoryMb) throw new Error("container_subscription_resource_limit");
}
/** Upper-bound provider allocation estimate, full CPU + provisioned RAM/disk, plus 15%.
 * This is Naelao's published conservative allocation tariff, not measured provider CPU usage.
 * Rates verified 2026-10; stored on the reservation so changes never alter in-flight settlement.
 */
export function dynamicCreditsPerHour(profile: DynamicProfile): number {
  const s = DYNAMIC_PROFILES[profile];
  return 3600 * (s.cpuCores * .000020 + s.memoryMb / 1024 * .0000025 + s.diskGb * .00000007) * 115;
}
export function dynamicSandboxNamespace<T>(env: { DYNAMIC_CONTAINERS_ENABLED?: string; DYNAMIC_SANDBOX?: T; TOOL_SANDBOX?: T }): T | undefined {
  if (env.DYNAMIC_CONTAINERS_ENABLED === "true") {
    if (!env.DYNAMIC_SANDBOX) throw new Error("dynamic_container_binding_unavailable");
    return env.DYNAMIC_SANDBOX;
  }
  return env.TOOL_SANDBOX;
}
