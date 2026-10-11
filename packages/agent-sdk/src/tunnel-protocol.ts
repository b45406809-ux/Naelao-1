/** Named machine identity, distinct from preview-sharing Quick Tunnels. */
export interface MachineHardware {
  platform: "win32" | "linux" | "darwin"; arch: string; cpuCount: number; memoryBytes: number;
  capabilities: readonly string[]; models: readonly string[];
}
export interface MachineGrant {
  id: string; actorId: string; projectId?: string; expiresAt: number;
  roots: readonly { path: string; access: "read" | "write" | "readwrite" }[];
  commands: readonly string[]; inference: boolean;
}
export interface NamedMachine {
  schema: 1; tenantId: string; spaceId: string; machineId: string; name: string; ownerId: string;
  publicKey: JsonWebKey; keyVersion: number; status: "active" | "revoked" | "removed";
  sequence: number; hardware: MachineHardware; grants: readonly MachineGrant[];
  createdAt: number; updatedAt: number; heartbeatAt?: number;
}
export interface MachineProof {
  schema: 1; tenantId: string; spaceId: string; machineId: string; keyVersion: number;
  sequence: number; issuedAt: number; nonce: string; operation: "connect" | "rotate" | "remove";
  dataHash: string;
}
export const MACHINE_NAME = /^[a-z][a-z0-9-]{1,62}$/;
export const MACHINE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export function assertMachineIdentity(value: Pick<NamedMachine, "tenantId" | "spaceId" | "machineId">): void {
  for (const field of [value.tenantId, value.spaceId, value.machineId]) if (!MACHINE_ID.test(field)) throw new Error("tunnel_identity_invalid");
}
export function validateMachinePublicKey(key: JsonWebKey): void {
  if (!key || key.kty !== "OKP" || key.crv !== "Ed25519" || typeof key.x !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(key.x) || key.d !== undefined) throw new Error("tunnel_public_key_invalid");
}
export function validateMachineHardware(value: MachineHardware): void {
  if (!value || !["win32", "linux", "darwin"].includes(value.platform) || typeof value.arch !== "string" || value.arch.length > 32
    || !Number.isSafeInteger(value.cpuCount) || value.cpuCount < 1 || value.cpuCount > 1024 || !Number.isSafeInteger(value.memoryBytes) || value.memoryBytes < 1
    || !Array.isArray(value.capabilities) || value.capabilities.length > 64 || value.capabilities.some(item => !/^[a-z][a-z0-9_:.-]{0,127}$/.test(item))
    || !Array.isArray(value.models) || value.models.length > 64 || value.models.some(item => typeof item !== "string" || item.length > 128)) throw new Error("tunnel_hardware_invalid");
}
export function validateMachineGrants(grants: readonly MachineGrant[], now = Date.now()): void {
  if (!Array.isArray(grants) || grants.length > 64) throw new Error("tunnel_grants_invalid");
  const ids = new Set<string>();
  for (const grant of grants) {
    if (!grant || !MACHINE_ID.test(grant.id) || ids.has(grant.id) || !MACHINE_ID.test(grant.actorId) || grant.actorId === "system"
      || grant.projectId && !MACHINE_ID.test(grant.projectId) || !Number.isFinite(grant.expiresAt) || grant.expiresAt <= now
      || !Array.isArray(grant.commands) || grant.commands.length > 128 || grant.commands.some(cmd => typeof cmd !== "string" || !cmd.trim() || cmd.length > 8192)
      || typeof grant.inference !== "boolean" || !Array.isArray(grant.roots) || grant.roots.length > 32) throw new Error("tunnel_grant_invalid");
    ids.add(grant.id);
    for (const root of grant.roots) if (!root || typeof root.path !== "string" || root.path.length > 1024 || !/^(?:\/|[A-Za-z]:[\\/])/.test(root.path) || !["read", "write", "readwrite"].includes(root.access)) throw new Error("tunnel_root_grant_invalid");
  }
}
export function machineProofBytes(proof: MachineProof): Uint8Array {
  assertMachineIdentity(proof);
  if (proof.schema !== 1 || !Number.isSafeInteger(proof.keyVersion) || proof.keyVersion < 1 || !Number.isSafeInteger(proof.sequence) || proof.sequence < 1
    || !Number.isFinite(proof.issuedAt) || !/^[a-f0-9]{64}$/.test(proof.nonce) || !["connect", "rotate", "remove"].includes(proof.operation) || !/^[a-f0-9]{64}$/.test(proof.dataHash)) throw new Error("tunnel_proof_invalid");
  return new TextEncoder().encode(JSON.stringify(["naelao-machine-v1", proof.tenantId, proof.spaceId, proof.machineId, proof.keyVersion, proof.sequence, proof.issuedAt, proof.nonce, proof.operation, proof.dataHash]));
}
export async function verifyMachineProof(machine: NamedMachine, proof: MachineProof, signature: string, now = Date.now()): Promise<boolean> {
  try {
    if (machine.status !== "active" || machine.tenantId !== proof.tenantId || machine.spaceId !== proof.spaceId || machine.machineId !== proof.machineId
      || machine.keyVersion !== proof.keyVersion || proof.sequence <= machine.sequence || Math.abs(now - proof.issuedAt) > 30000 || !/^[A-Za-z0-9_-]{86}$/.test(signature)) return false;
    validateMachinePublicKey(machine.publicKey);
    const key = await crypto.subtle.importKey("jwk", machine.publicKey, { name: "Ed25519" }, false, ["verify"]);
    const bytes = Uint8Array.from(atob(signature.replaceAll("-", "+").replaceAll("_", "/") + "=="), c => c.charCodeAt(0));
    return await crypto.subtle.verify("Ed25519", key, bytes, machineProofBytes(proof));
  } catch { return false; }
}
export async function tunnelHash(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), n => n.toString(16).padStart(2, "0")).join("");
}
export function machineSocketKey(machine: Pick<NamedMachine, "tenantId" | "spaceId" | "machineId">): string {
  assertMachineIdentity(machine); return JSON.stringify([machine.tenantId, machine.spaceId, machine.machineId]);
}
