/** Edge mutation firewall. It has no Node dependencies and runs in Workers. */
export type MutationKind = "sql" | "shell";
export interface MutationFinding {
  kind: MutationKind;
  action: string;
  resource: string;
  reason: string;
}
export interface WriteGuardOptions {
  kind?: MutationKind | "auto";
  token?: string;
  secret: string;
  resourceId: string;
  now?: number;
}
export interface GatekeeperClaims {
  actions: string[];
  resources: string[];
  exp: number;
  nonce?: string;
}
const MAX_GATEKEEPER_TOKEN_BYTES = 32 * 1024;
const MAX_GATEKEEPER_GRANT_ITEMS = 128;
const MAX_GATEKEEPER_GRANT_ITEM_CHARS = 256;
const MAX_MUTATION_INPUT_CHARS = 1_000_000;

export class WriteGuardViolation extends Error {
  readonly code = "WRITE_GUARD_DENIED";
  constructor(readonly finding: MutationFinding) {
    super(
      `WriteGuard blocked ${finding.reason} on ${finding.resource}; provide a valid x-gatekeeper-token`
    );
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
  const raw = atob(
    value
      .replaceAll("-", "+")
      .replaceAll("_", "/")
      .padEnd(Math.ceil(value.length / 4) * 4, "=")
  );
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}
export async function signGatekeeperToken(
  claims: GatekeeperClaims,
  secret: string
): Promise<string> {
  if (typeof secret !== "string" || !secret || secret.length > 4096)
    throw new Error("gatekeeper_secret_required");
  if (!isValidGatekeeperClaims(claims))
    throw new Error("gatekeeper_claims_invalid");
  const payload = b64url(enc.encode(JSON.stringify(claims)));
  if (payload.length > MAX_GATEKEEPER_TOKEN_BYTES)
    throw new Error("gatekeeper_token_too_large");
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return `${payload}.${b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(payload))))}`;
}
export async function verifyGatekeeperToken(
  token: string,
  secret: string,
  action: string,
  resource: string,
  now = Date.now()
): Promise<boolean> {
  try {
    if (
      typeof token !== "string" ||
      token.length > MAX_GATEKEEPER_TOKEN_BYTES ||
      typeof secret !== "string" ||
      !secret ||
      secret.length > 4096 ||
      typeof action !== "string" ||
      !action ||
      action.length > MAX_GATEKEEPER_GRANT_ITEM_CHARS ||
      typeof resource !== "string" ||
      !resource ||
      resource.length > MAX_GATEKEEPER_GRANT_ITEM_CHARS ||
      !Number.isSafeInteger(now)
    )
      return false;
    const parts = token.split(".");
    const payload = parts[0];
    const signature = parts[1];
    if (parts.length !== 2 || !payload || !signature) return false;
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );
    if (
      !(await crypto.subtle.verify(
        "HMAC",
        key,
        decode(signature),
        enc.encode(payload)
      ))
    )
      return false;
    const claims = JSON.parse(
      new TextDecoder().decode(decode(payload))
    ) as GatekeeperClaims;
    return (
      isValidGatekeeperClaims(claims) &&
      claims.exp > now &&
      Array.isArray(claims.actions) &&
      (claims.actions.includes(action) ||
        claims.actions.includes("destructive_write")) &&
      Array.isArray(claims.resources) &&
      claims.resources.includes(resource)
    );
  } catch {
    return false;
  }
}

function isValidGatekeeperClaims(value: unknown): value is GatekeeperClaims {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const claims = value as Partial<GatekeeperClaims>;
  return (
    Number.isSafeInteger(claims.exp) &&
    Array.isArray(claims.actions) &&
    claims.actions.length <= MAX_GATEKEEPER_GRANT_ITEMS &&
    claims.actions.every(
      (item) =>
        typeof item === "string" &&
        item.length > 0 &&
        item.length <= MAX_GATEKEEPER_GRANT_ITEM_CHARS
    ) &&
    Array.isArray(claims.resources) &&
    claims.resources.length <= MAX_GATEKEEPER_GRANT_ITEMS &&
    claims.resources.every(
      (item) =>
        typeof item === "string" &&
        item.length > 0 &&
        item.length <= MAX_GATEKEEPER_GRANT_ITEM_CHARS
    ) &&
    (claims.nonce === undefined ||
      (typeof claims.nonce === "string" &&
        claims.nonce.length <= MAX_GATEKEEPER_GRANT_ITEM_CHARS))
  );
}
interface SqlLexed {
  statements: string[][];
  invalid: boolean;
}

/** Small SQL lexer for deterministic deny rules; it is deliberately not described as an AST. */
function lexSql(input: string): SqlLexed {
  const statements: string[][] = [];
  let tokens: string[] = [];
  const flush = () => {
    if (tokens.length) statements.push(tokens);
    tokens = [];
  };
  for (let i = 0; i < input.length; ) {
    const ch = input.charAt(i);
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "-" && input[i + 1] === "-") {
      i += 2;
      while (i < input.length && input[i] !== "\n" && input[i] !== "\r") i++;
      continue;
    }
    if (ch === "/" && input[i + 1] === "*") {
      const end = input.indexOf("*/", i + 2);
      if (end < 0) return { statements, invalid: true };
      i = end + 2;
      continue;
    }
    if (ch === "'") {
      i++;
      let closed = false;
      while (i < input.length) {
        if (input[i] === "'" && input[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (input[i] === "'") {
          i++;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) return { statements, invalid: true };
      tokens.push("$LITERAL");
      continue;
    }
    if (ch === '"' || ch === "`" || ch === "[") {
      const endChar = ch === "[" ? "]" : ch;
      let value = "";
      i++;
      let closed = false;
      while (i < input.length) {
        if (input[i] === endChar) {
          if (input[i + 1] === endChar && endChar !== "]") {
            value += endChar;
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        value += input.charAt(i++);
      }
      if (!closed) return { statements, invalid: true };
      tokens.push(value.toUpperCase());
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let end = i + 1;
      while (end < input.length && /[A-Za-z0-9_$]/.test(input.charAt(end)))
        end++;
      tokens.push(input.slice(i, end).toUpperCase());
      i = end;
      continue;
    }
    if (ch === ";") {
      flush();
      i++;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let end = i + 1;
      while (end < input.length && /[0-9.]/.test(input.charAt(end))) end++;
      tokens.push(input.slice(i, end));
      i = end;
      continue;
    }
    tokens.push(ch);
    i++;
  }
  flush();
  return { statements, invalid: false };
}

function tokenSequence(
  tokens: readonly string[],
  sequence: readonly string[]
): number {
  for (let i = 0; i <= tokens.length - sequence.length; i++) {
    if (sequence.every((token, offset) => tokens[i + offset] === token))
      return i;
  }
  return -1;
}

export function findDestructiveMutation(
  input: string,
  kind: MutationKind | "auto" = "auto",
  resource = "*"
): MutationFinding | null {
  if (typeof input !== "string")
    return {
      kind: kind === "shell" ? "shell" : "sql",
      action: "mutation.input_invalid",
      resource,
      reason: "mutation input must be text",
    };
  if (input.length > MAX_MUTATION_INPUT_CHARS)
    return {
      kind: kind === "shell" ? "shell" : "sql",
      action: "mutation.input_too_large",
      resource,
      reason: "mutation input exceeds the inspection size limit",
    };
  if (kind !== "shell") {
    const parsed = lexSql(input);
    if (parsed.invalid)
      return {
        kind: "sql",
        action: "sql.invalid",
        resource,
        reason: "malformed SQL quoting or comment",
      };
    if (parsed.statements.length > 1)
      return {
        kind: "sql",
        action: "sql.multiple_statements",
        resource,
        reason: "multiple SQL statements are not allowed",
      };
    const tokens = parsed.statements[0] ?? [];
    if (
      tokenSequence(tokens, ["DROP", "TABLE"]) >= 0 ||
      tokenSequence(tokens, ["DROP", "DATABASE"]) >= 0
    ) {
      return {
        kind: "sql",
        action: "sql.drop",
        resource,
        reason: "DROP TABLE or DATABASE",
      };
    }
    const alterAt = tokenSequence(tokens, ["ALTER", "TABLE"]);
    if (
      alterAt >= 0 &&
      tokenSequence(tokens.slice(alterAt + 2), ["DROP"]) >= 0
    ) {
      return {
        kind: "sql",
        action: "sql.alter_drop",
        resource,
        reason: "ALTER TABLE DROP",
      };
    }
    if (tokenSequence(tokens, ["TRUNCATE"]) >= 0)
      return {
        kind: "sql",
        action: "sql.truncate",
        resource,
        reason: "TRUNCATE",
      };
    const deleteAt = tokenSequence(tokens, ["DELETE", "FROM"]);
    const updateAt = tokenSequence(tokens, ["UPDATE"]);
    const writeAt = deleteAt >= 0 ? deleteAt : updateAt;
    if (writeAt >= 0) {
      const whereAt = tokens.indexOf("WHERE", writeAt);
      const unboundedPredicate =
        whereAt >= 0 &&
        (tokens.slice(whereAt + 1).join("") === "1=1" ||
          tokens.slice(whereAt + 1).join("") === "TRUE");
      if (whereAt < 0 || unboundedPredicate)
        return {
          kind: "sql",
          action: "sql.unbounded_write",
          resource,
          reason: `${deleteAt >= 0 ? "DELETE" : "UPDATE"} has no restrictive WHERE predicate`,
        };
    }
  }
  if (kind !== "sql") {
    const value = input.replace(/\\\s*\n/g, " ").replace(/\s+/g, " ");
    if (
      /\brm\s+(?=[^;&|\n]*-[A-Za-z]*r)(?=[^;&|\n]*-[A-Za-z]*f)[^;&|\n]*(?:^|\s)(?:\/|\/\*|~|~\/|\*)(?:\s|$)/i.test(
        value
      )
    )
      return {
        kind: "shell",
        action: "shell.rm_root",
        resource,
        reason: "recursive forced removal of a catastrophic target",
      };
    if (/\bmkfs(?:\.[a-z0-9]+)?\b/i.test(value))
      return {
        kind: "shell",
        action: "shell.mkfs",
        resource,
        reason: "filesystem formatting",
      };
    if (
      /\bdd\b[^;&|\n]*\bif\s*=\s*\/dev\/(?:zero|random|urandom)\b[^;&|\n]*\bof\s*=\s*\/dev\//i.test(
        value
      ) ||
      />\s*\/dev\/(?:sd|hd|vd|nvme|mmcblk)/i.test(value)
    )
      return {
        kind: "shell",
        action: "shell.raw_device_write",
        resource,
        reason: "raw device overwrite",
      };
    if (/\bchmod\s+(?:-[A-Za-z]+\s+)*777\s+\/(?:\s|$)/i.test(value))
      return {
        kind: "shell",
        action: "shell.chmod_root",
        resource,
        reason: "world-writable root",
      };
  }
  return null;
}
export async function inspectMutation(
  commandOrSql: string,
  options: WriteGuardOptions
): Promise<void> {
  if (typeof commandOrSql !== "string")
    throw new Error("mutation_input_required");
  const finding = findDestructiveMutation(
    commandOrSql,
    options.kind,
    options.resourceId
  );
  if (!finding) return;
  if (
    options.token &&
    (await verifyGatekeeperToken(
      options.token,
      options.secret,
      finding.action,
      options.resourceId,
      options.now
    ))
  )
    return;
  throw new WriteGuardViolation(finding);
}
