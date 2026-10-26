/** Security and cognition primitives for AVOS plan features 21-50. */

import type { FastDecisionGateway } from "./fast-decision.js";

const encoder = new TextEncoder();

function bytesToBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(
    normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")
  );
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return bytesToBase64Url(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)))
  );
}

async function verifyHmac(
  secret: string,
  value: string,
  signature: string
): Promise<boolean> {
  let bytes: Uint8Array;
  try {
    bytes = base64UrlToBytes(signature);
  } catch {
    return false;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  return crypto.subtle.verify(
    "HMAC",
    key,
    new Uint8Array(bytes).buffer,
    encoder.encode(value)
  );
}

// Features 21, 25, 26, 28: credentials remain beyond the script boundary.
export type ConnectorScope = "space" | "project" | "user";
export interface ConnectorBinding {
  tenantId: string;
  alias: string;
  connectorId: string;
  scope: ConnectorScope;
  spaceId: string;
  projectId?: string;
  userId?: string;
  grantedScopes: string[];
}

export class ConnectorBindingMatrix {
  constructor(private readonly bindings: ConnectorBinding[]) {
    const keys = new Set<string>();
    for (const binding of bindings) {
      if (
        !binding.tenantId ||
        !binding.spaceId ||
        !binding.alias ||
        !binding.connectorId ||
        (binding.scope === "user" && !binding.userId) ||
        (binding.scope === "project" && !binding.projectId)
      )
        throw new Error("invalid_connector_binding");
      const key = [
        binding.tenantId,
        binding.spaceId,
        binding.scope,
        binding.projectId ?? "_",
        binding.userId ?? "_",
        binding.alias,
      ].join(":");
      if (keys.has(key)) throw new Error("ambiguous_connector_binding");
      keys.add(key);
    }
  }

  resolve(
    alias: string,
    context: {
      tenantId: string;
      spaceId: string;
      projectId?: string;
      userId?: string;
    }
  ): ConnectorBinding | null {
    const candidates = this.bindings.filter(
      (binding) =>
        binding.alias === alias &&
        binding.tenantId === context.tenantId &&
        binding.spaceId === context.spaceId
    );
    return (
      candidates.find(
        (binding) =>
          binding.scope === "user" &&
          Boolean(context.userId) &&
          binding.userId === context.userId
      ) ??
      candidates.find(
        (binding) =>
          binding.scope === "project" &&
          Boolean(context.projectId) &&
          binding.projectId === context.projectId
      ) ??
      candidates.find((binding) => binding.scope === "space") ??
      null
    );
  }
}

export interface ReauthorizationCard {
  type: "incremental_reauthorization";
  connectorId: string;
  missingScopes: string[];
}

export function verifyConnectorScopes(
  binding: ConnectorBinding,
  required: string[]
): { ok: true } | { ok: false; card: ReauthorizationCard } {
  const granted = new Set(binding.grantedScopes);
  const missingScopes = required.filter((scope) => !granted.has(scope));
  return missingScopes.length === 0
    ? { ok: true }
    : {
        ok: false,
        card: {
          type: "incremental_reauthorization",
          connectorId: binding.connectorId,
          missingScopes,
        },
      };
}

export interface OutboundCredentialProvider {
  authorization(
    alias: string,
    context: { tenantId: string; spaceId: string; userId?: string }
  ): Promise<string>;
}

/** Injects authorization only into the outbound request; the value is never returned to scripts. */
export async function authorizedOutboundFetch(
  provider: OutboundCredentialProvider,
  alias: string,
  context: { tenantId: string; spaceId: string; userId?: string },
  request: Request
): Promise<Response> {
  const authorization = await provider.authorization(alias, context);
  const headers = new Headers(request.headers);
  headers.set("authorization", authorization);
  return fetch(new Request(request, { headers }));
}

// Feature 22: destructive mutation interception.
const DESTRUCTIVE_PATTERNS = [
  /\bdrop\s+(table|database|schema)\b/i,
  /\btruncate\s+table\b/i,
  /\bdelete\s+from\s+[^;]+(?:;|$)/i,
  /\brm\s+(?:-[^\s]*r[^\s]*f|-rf|-fr)\b/i,
  /\bgit\s+reset\s+--hard\b/i,
];

export function requiresMutationGrant(command: string): boolean {
  const candidates = [command];
  try {
    candidates.push(decodeURIComponent(command));
  } catch {
    /* malformed input remains suspicious below */
  }
  for (const token of command.split(/\s+/)) {
    if (/^[A-Za-z0-9+/]{12,}={0,2}$/.test(token)) {
      try {
        candidates.push(
          new TextDecoder().decode(
            Uint8Array.from(atob(token), (c) => c.charCodeAt(0))
          )
        );
      } catch {
        /* not base64 */
      }
    }
  }
  return candidates.some((candidate) =>
    DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(candidate)) ||
    /\bdependency_manifest_edit\b/i.test(candidate) ||
    /\bapi\s+request\s+(?:POST|PUT|PATCH|DELETE)\b/i.test(candidate) ||
    // New third-party dependencies alter the project's supply-chain contract. Require the
    // same scoped human grant used by other high-impact mutations. Frozen/clean installs
    // remain available for dependencies already represented by the checked-in lockfile.
    /\b(?:npm\s+(?:install|i)\b|pnpm\s+(?:add|dlx)\b|yarn\s+(?:add|dlx)\b|npx\s+(?!--no-install\b)|pip3?\s+install\s+(?![^;&|]*(?:^|\s)(?:-r|--requirement)(?:\s|=))[^;&|]+|python(?:3(?:\.\d+)?)?\s+-m\s+pip\s+install\s+(?![^;&|]*(?:^|\s)(?:-r|--requirement)(?:\s|=))[^;&|]+|cargo\s+(?:add|install)\b|bunx\b)/i.test(candidate)
  );
}

export interface CapabilityGrant {
  subject: string;
  resources: string[];
  actions: string[];
  expiresAt: number;
  nonce: string;
  singleUse?: boolean;
}

export async function mintCapabilityGrant(
  grant: CapabilityGrant,
  secret: string
): Promise<string> {
  const payload = bytesToBase64Url(encoder.encode(JSON.stringify(grant)));
  return `${payload}.${await hmac(secret, payload)}`;
}

export async function verifyCapabilityGrant(
  token: string,
  secret: string,
  requirement: { subject: string; resource: string; action: string },
  now = Date.now()
): Promise<CapabilityGrant | null> {
  const [payload, signature, extra] = token.split(".");
  if (
    !payload ||
    !signature ||
    extra ||
    payload.length > 16_384 ||
    !(await verifyHmac(secret, payload, signature))
  )
    return null;
  let grant: CapabilityGrant;
  try {
    grant = JSON.parse(
      new TextDecoder().decode(base64UrlToBytes(payload))
    ) as CapabilityGrant;
  } catch {
    return null;
  }
  if (
    !Array.isArray(grant.resources) ||
    !Array.isArray(grant.actions) ||
    typeof grant.subject !== "string" ||
    typeof grant.nonce !== "string" ||
    !grant.nonce ||
    !Number.isSafeInteger(grant.expiresAt)
  )
    return null;
  if (grant.expiresAt <= now || grant.subject !== requirement.subject)
    return null;
  if (
    !grant.resources.includes(requirement.resource) ||
    !grant.actions.includes(requirement.action)
  )
    return null;
  return grant;
}

export async function enforceWriteGuard(
  command: string,
  grantToken: string | undefined,
  secret: string,
  requirement: { subject: string; resource: string },
  now = Date.now()
): Promise<void> {
  if (!requiresMutationGrant(command)) return;
  if (
    !grantToken ||
    !(await verifyCapabilityGrant(
      grantToken,
      secret,
      { ...requirement, action: "destructive_write" },
      now
    ))
  ) {
    throw new Error("destructive_mutation_denied");
  }
}

/**
 * Deterministic signatures remain authoritative. System One may only tighten the gate by asking
 * for a grant on an ambiguous mutation; it can never waive a deterministic requirement.
 */
export async function enforceWriteGuardWithSentry(
  command: string,
  grantToken: string | undefined,
  secret: string,
  requirement: { subject: string; resource: string },
  gateway?: FastDecisionGateway,
  now = Date.now(),
): Promise<boolean> {
  let required = requiresMutationGrant(command);
  if (!required && gateway) {
    try {
      const decision = await gateway.noul({
        state: { command },
        instructions: "Does this command perform a destructive, irreversible, broad, or privilege-changing mutation that requires explicit human authorization?",
        criteria: { true: "A mutation grant is required before execution.", false: "The command is read-only or narrowly reversible." },
        policyCode: "write_guard_ambiguous_mutation",
        threshold: 0.9,
      });
      required = decision.value && (decision.confidence ?? 0) >= 0.9;
    } catch {
      // Provider failure cannot weaken deterministic policy; ambiguous commands keep the
      // deterministic result and proceed to the ordinary sandbox/role gates.
    }
  }
  if (!required) return false;
  if (!grantToken || !(await verifyCapabilityGrant(grantToken, secret, { ...requirement, action: "destructive_write" }, now))) {
    throw new Error("destructive_mutation_denied");
  }
  return true;
}

// Features 23-24: virtual commands and durable synthesized parsers.
export type VirtualCommandHandler = (args: string[]) => Promise<unknown>;
export interface VirtualCommandStore {
  get(name: string): Promise<string | null>;
  put(name: string, source: string): Promise<void>;
}

export interface VirtualCliScope {
  tenantId: string;
  spaceId: string;
  projectId?: string;
  userId?: string;
}

export class VirtualCli {
  private readonly commands = new Map<string, VirtualCommandHandler>();
  constructor(
    private readonly store?: VirtualCommandStore,
    private readonly scope?: VirtualCliScope
  ) {}
  private storageName(name: string): string {
    if (!this.scope) return name;
    const { tenantId, spaceId, projectId = "_", userId = "_" } = this.scope;
    if (
      ![tenantId, spaceId, projectId, userId].every((v) =>
        /^[A-Za-z0-9_-]+$/.test(v)
      )
    )
      throw new Error("invalid_cli_scope");
    return `${tenantId}:${spaceId}:${projectId}:${userId}:${name}`;
  }
  register(name: string, handler: VirtualCommandHandler): void {
    if (!/^[a-z][a-z0-9_-]*$/i.test(name))
      throw new Error("invalid_command_name");
    this.commands.set(name, handler);
  }
  async registerSynthesized(
    name: string,
    source: string,
    handler: VirtualCommandHandler
  ): Promise<void> {
    if (source.length > 4_096 || /\b(eval|Function|import\s*\()\b/.test(source))
      throw new Error("unsafe_synthesized_command");
    this.register(name, handler);
    await this.store?.put(this.storageName(name), source);
  }
  async run(command: string, args: string[] = []): Promise<unknown> {
    const handler = this.commands.get(command);
    if (!handler) throw new Error(`unknown_virtual_command:${command}`);
    return handler(args);
  }
}

// Features 29-33: prompt stripping, mention routing, and signed delegation.
export interface PromptTool {
  name: string;
  scope: ConnectorScope;
}
export function toolsForChannel(
  tools: PromptTool[],
  channel: "public" | "private"
): PromptTool[] {
  return channel === "public"
    ? tools.filter((tool) => tool.scope !== "user")
    : [...tools];
}

export function privateScratchpadCard(tool: string): {
  type: "private_scratchpad";
  requestedTool: string;
} {
  return { type: "private_scratchpad", requestedTool: tool };
}

export class SingleUseGrantStore {
  private readonly consumed = new Set<string>();
  consume(grant: CapabilityGrant, now = Date.now()): void {
    if (
      !grant.singleUse ||
      grant.expiresAt <= now ||
      this.consumed.has(grant.nonce)
    )
      throw new Error("ephemeral_grant_invalid");
    this.consumed.add(grant.nonce);
  }
}

export function parseMentionTurn(
  text: string,
  agents: Array<{ id: string; name: string }>
): { holder: string | null; referents: string[] } {
  const positions = agents
    .flatMap((agent) => {
      const index = text.toLowerCase().indexOf(`@${agent.name.toLowerCase()}`);
      return index < 0 ? [] : [{ id: agent.id, index }];
    })
    .sort((a, b) => a.index - b.index);
  return {
    holder: positions[0]?.id ?? null,
    referents: positions.slice(1).map((entry) => entry.id),
  };
}

export interface DelegationClaim extends CapabilityGrant {
  initiatorUserId: string;
  roleRank: number;
  parentTaskId?: string;
  depth: number;
}
export async function mintDelegation(
  claim: DelegationClaim,
  secret: string
): Promise<string> {
  return mintCapabilityGrant(claim, secret);
}

export function attenuateDelegation(
  parent: DelegationClaim,
  child: Omit<DelegationClaim, "initiatorUserId" | "roleRank">
): DelegationClaim {
  if (
    parent.depth >= 3 ||
    child.depth !== parent.depth + 1 ||
    child.expiresAt > parent.expiresAt ||
    child.resources.some((value) => !parent.resources.includes(value)) ||
    child.actions.some((value) => !parent.actions.includes(value))
  ) {
    throw new Error("delegation_cannot_expand_authority");
  }
  return {
    ...child,
    initiatorUserId: parent.initiatorUserId,
    roleRank: parent.roleRank,
  };
}

// Features 34-37: skills, catalog, and declarative hooks.
export interface TraceStep {
  operation: string;
  input: Record<string, unknown>;
  output: unknown;
}
export function distillTrace(
  name: string,
  steps: TraceStep[]
): { path: string; source: string } {
  if (!/^[a-z][a-z0-9-]*$/.test(name) || steps.length === 0)
    throw new Error("invalid_demonstration");
  const source = `export async function run(args, ctx) {\n${steps.map((step) => `  await ctx.cli.run([${JSON.stringify(step.operation)}, "--params", JSON.stringify(Object.fromEntries(${JSON.stringify(Object.keys(step.input))}.map(k => [k, args[k]])))]);`).join("\n")}\n}`;
  return { path: `/.avos/shared/skills/${name}.ts`, source };
}

export interface VideoSkillFrame {
  atMs: number;
  action: "click" | "type";
  value: string;
  x?: number;
  y?: number;
}
export function distillVideoSkill(
  name: string,
  transcript: string,
  frames: VideoSkillFrame[]
): { path: string; transcript: string; steps: VideoSkillFrame[] } {
  if (!transcript.trim() || frames.length === 0)
    throw new Error("invalid_video_demonstration");
  return {
    path: `/.avos/shared/skills/${name}.json`,
    transcript,
    steps: [...frames].sort((a, b) => a.atMs - b.atMs),
  };
}

export function commandCatalog(
  commands: Array<{ name: string; description: string; source: string }>
): Array<Omit<(typeof commands)[number], "source">> {
  return commands.map(({ name, description }) => ({ name, description }));
}

export interface ExecutionPipeline {
  preflight: Array<"load_project_truth" | "retrieve_memory" | "verify_scopes">;
  postTurn: Array<"run_tests" | "commit_turn" | "scan_egress">;
}
export function validatePipeline(
  pipeline: ExecutionPipeline
): ExecutionPipeline {
  return {
    preflight: [...pipeline.preflight],
    postTurn: [...pipeline.postTurn],
  };
}

// Feature 38: outbound DLP.
const SENSITIVE = [
  { kind: "ssn", expression: /\b\d{3}-\d{2}-\d{4}\b/g },
  { kind: "credit_card", expression: /\b(?:\d[ -]*?){13,19}\b/g },
  {
    kind: "private_key",
    expression:
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  },
] as const;
export function scrubEgress(value: string): {
  value: string;
  findings: string[];
} {
  const findings: string[] = [];
  let scrubbed = value;
  for (const rule of SENSITIVE)
    scrubbed = scrubbed.replace(rule.expression, () => {
      findings.push(rule.kind);
      return `[REDACTED:${rule.kind}]`;
    });
  return { value: scrubbed, findings };
}

/** Serializes first so secrets hidden in nested connector payloads cannot bypass DLP. */
export function scrubEgressPayload(value: unknown): {
  value: unknown;
  findings: string[];
} {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("egress_payload_not_serializable");
  const result = scrubEgress(encoded);
  return { value: JSON.parse(result.value), findings: result.findings };
}

// Features 40-41: deterministic prompt assembly and role firewall.
export interface PromptLayers {
  kernel: string;
  business: string;
  soul: string;
  founderDirectives: string;
}
function escapePromptLayer(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
export function assembleSystemPrompt(layers: PromptLayers): string {
  return `<kernel>${escapePromptLayer(layers.kernel)}</kernel>\n<business_context>${escapePromptLayer(layers.business)}</business_context>\n<soul>${escapePromptLayer(layers.soul)}</soul>\n<founder_directives>${escapePromptLayer(layers.founderDirectives)}</founder_directives>`;
}
export function enforceAgentFirewall(
  tool: string,
  allowed: ReadonlySet<string>
): void {
  if (!allowed.has(tool)) throw new Error(`agent_firewall_denied:${tool}`);
}
export function applyAgentFirewall<T extends { name: string }>(
  tools: T[],
  allowed: ReadonlySet<string>
): T[] {
  return tools.filter((tool) => allowed.has(tool.name));
}

// Features 42-49: planning, memory isolation, compaction and safe retrieval.
export interface DagTask {
  id: string;
  dependencies: string[];
  status: "pending" | "running" | "complete";
}
export function validateTaskDag(tasks: DagTask[]): void {
  const ids = new Set(tasks.map((task) => task.id));
  if (
    ids.size !== tasks.length ||
    tasks.some((task) => task.dependencies.some((id) => !ids.has(id)))
  )
    throw new Error("invalid_task_dag");
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error("cyclic_task_dag");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of tasks.find((task) => task.id === id)?.dependencies ?? [])
      visit(dep);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of tasks) visit(task.id);
}

export function runnableDagTasks(tasks: DagTask[]): DagTask[] {
  validateTaskDag(tasks);
  const complete = new Set(
    tasks.filter((task) => task.status === "complete").map((task) => task.id)
  );
  return tasks.filter(
    (task) =>
      task.status === "pending" &&
      task.dependencies.every((id) => complete.has(id))
  );
}

/** Hard worker envelope; callers cannot silently spill a planner transcript into workers. */
export function enforceWorkerContext(text: string, maxTokens = 2_000): string {
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 2_000)
    throw new Error("invalid_worker_token_budget");
  const estimatedTokens = Math.ceil(
    new TextEncoder().encode(text).byteLength / 4
  );
  if (estimatedTokens > maxTokens)
    throw new Error("worker_context_budget_exceeded");
  return text;
}

export interface MemoryChunk {
  id: string;
  spaceId: string;
  projectId: string;
  roleMask: number;
  similarity: number;
  content: string;
}
export function gateMemory(
  chunks: MemoryChunk[],
  query: { spaceId: string; projectId: string; roleMask: number },
  threshold = 0.8
): MemoryChunk[] {
  return chunks.filter(
    (chunk) =>
      chunk.spaceId === query.spaceId &&
      chunk.projectId === query.projectId &&
      (chunk.roleMask & query.roleMask) !== 0 &&
      chunk.similarity > threshold
  );
}
export function contextEnvelope(chunks: MemoryChunk[]): string {
  return chunks
    .map(
      (chunk) =>
        `<context_chunk id="${chunk.id.replace(/[^a-zA-Z0-9_-]/g, "")}" trust="untrusted">${chunk.content.replace(/<\/context_chunk>/gi, "&lt;/context_chunk&gt;")}</context_chunk>`
    )
    .join("\n");
}

export interface ThreadTurn {
  id: string;
  content: string;
}
export function compactContext(
  turns: ThreadTurn[],
  summary: string,
  threshold = 25
): { promptTurns: ThreadTurn[]; archived: ThreadTurn[]; projectTruth: string } {
  if (turns.length <= threshold)
    return { promptTurns: [...turns], archived: [], projectTruth: summary };
  const recent = turns.slice(-10);
  return {
    promptTurns: recent,
    archived: turns.slice(0, -10),
    projectTruth: summary,
  };
}

export function freshThreadContext(
  kernel: string,
  projectTruth: string
): string[] {
  return [kernel, projectTruth];
}

// Feature 50: Cohere Parse v5 request contract used by the knowledge worker adapter.
export interface ParseV5Request {
  model: "parse-v5.0";
  document: Uint8Array;
  output: "markdown";
}
export function createParseV5Request(document: Uint8Array): ParseV5Request {
  if (document.byteLength === 0) throw new Error("empty_document");
  return { model: "parse-v5.0", document, output: "markdown" };
}
