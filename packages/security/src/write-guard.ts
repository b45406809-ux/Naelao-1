/** Edge mutation firewall. It has no Node dependencies and runs in Workers. */
export type MutationKind = "sql" | "shell";
export interface MutationFinding { kind: MutationKind; action: string; resource: string; reason: string }
export interface WriteGuardOptions { kind?: MutationKind | "auto"; token?: string; secret: string; resourceId: string; now?: number }
export interface GatekeeperClaims { actions: string[]; resources: string[]; exp: number; nonce?: string }

export class WriteGuardViolation extends Error {
  readonly code = "WRITE_GUARD_DENIED";
  constructor(readonly finding: MutationFinding) {
    super(`WriteGuard blocked ${finding.reason} on ${finding.resource}; provide a valid x-gatekeeper-token`);
    this.name = "WriteGuardViolation";
  }
}
const enc = new TextEncoder();
function b64url(bytes: Uint8Array): string {
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function decode(value: string): Uint8Array {
  const raw = atob(value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "="));
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}
export async function signGatekeeperToken(claims: GatekeeperClaims, secret: string): Promise<string> {
  if (!secret) throw new Error("gatekeeper_secret_required");
  const payload = b64url(enc.encode(JSON.stringify(claims)));
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `${payload}.${b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(payload))))}`;
}
export async function verifyGatekeeperToken(token: string, secret: string, action: string, resource: string, now = Date.now()): Promise<boolean> {
  try {
    const parts = token.split(".");
    if (parts.length !== 2 || !secret || parts[0]!.length > 16_384) return false;
    const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    if (!(await crypto.subtle.verify("HMAC", key, decode(parts[1]!), enc.encode(parts[0]!)))) return false;
    const claims = JSON.parse(new TextDecoder().decode(decode(parts[0]!))) as GatekeeperClaims;
    return Number.isSafeInteger(claims.exp) && claims.exp > now && Array.isArray(claims.actions) &&
      (claims.actions.includes(action) || claims.actions.includes("destructive_write")) &&
      Array.isArray(claims.resources) && claims.resources.includes(resource);
  } catch { return false; }
}
/** Strip comments and literals before structural SQL checks (a small, deterministic AST lexer). */
function sqlShape(input: string): string {
  return input.replace(/--[^\n\r]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:''|[^'])*'/g, " ? ").replace(/"(?:""|[^"])*"/g, " identifier ").replace(/\s+/g, " ").trim();
}
export function findDestructiveMutation(input: string, kind: MutationKind | "auto" = "auto", resource = "*"): MutationFinding | null {
  const sql = sqlShape(input);
  if (kind !== "shell") {
    const drop = sql.match(/\bDROP\s+(?:TABLE|DATABASE)\s+(?:IF\s+EXISTS\s+)?([\w.`-]+)/i);
    if (drop) return { kind: "sql", action: "sql.drop", resource, reason: `DROP ${drop[1]}` };
    const alter = sql.match(/\bALTER\s+TABLE\s+([\w.`-]+)[\s\S]*?\bDROP\b/i);
    if (alter) return { kind: "sql", action: "sql.alter_drop", resource, reason: `ALTER TABLE DROP ${alter[1]}` };
    if (/\bTRUNCATE(?:\s+TABLE)?\b/i.test(sql)) return { kind: "sql", action: "sql.truncate", resource, reason: "TRUNCATE" };
    const write = sql.match(/\b(DELETE\s+FROM|UPDATE)\s+([\w.`-]+)([\s\S]*?)(?:;|$)/i);
    if (write && !/\bWHERE\b/i.test(write[3]!)) return { kind: "sql", action: "sql.unbounded_write", resource, reason: `${write[1]!.toUpperCase()} without WHERE` };
  }
  if (kind !== "sql") {
    const value = input.replace(/\\\s*\n/g, " ").replace(/\s+/g, " ");
    if (/\brm\s+(?=[^;&|\n]*-[A-Za-z]*r)(?=[^;&|\n]*-[A-Za-z]*f)[^;&|\n]*(?:^|\s)(?:\/|\/\*|~|~\/|\*)(?:\s|$)/i.test(value))
      return { kind: "shell", action: "shell.rm_root", resource, reason: "recursive forced removal of a catastrophic target" };
    if (/\bmkfs(?:\.[a-z0-9]+)?\b/i.test(value)) return { kind: "shell", action: "shell.mkfs", resource, reason: "filesystem formatting" };
    if (/\bdd\b[^;&|\n]*\bif\s*=\s*\/dev\/(?:zero|random|urandom)\b[^;&|\n]*\bof\s*=\s*\/dev\//i.test(value) || />\s*\/dev\/(?:sd|hd|vd|nvme|mmcblk)/i.test(value))
      return { kind: "shell", action: "shell.raw_device_write", resource, reason: "raw device overwrite" };
    if (/\bchmod\s+(?:-[A-Za-z]+\s+)*777\s+\/(?:\s|$)/i.test(value)) return { kind: "shell", action: "shell.chmod_root", resource, reason: "world-writable root" };
  }
  return null;
}
export async function inspectMutation(commandOrSql: string, options: WriteGuardOptions): Promise<void> {
  if (typeof commandOrSql !== "string") throw new Error("mutation_input_required");
  const finding = findDestructiveMutation(commandOrSql, options.kind, options.resourceId);
  if (!finding) return;
  if (options.token && await verifyGatekeeperToken(options.token, options.secret, finding.action, options.resourceId, options.now)) return;
  throw new WriteGuardViolation(finding);
}
