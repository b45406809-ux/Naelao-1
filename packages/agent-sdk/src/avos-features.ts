/** Security and cognition primitives for AVOS plan features 21-50. */

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

// Features 21, 25, 26, 28: credentials remain beyond the script boundary.
export type ConnectorScope = "space" | "project" | "user";
export interface ConnectorBinding {
  alias: string;
  connectorId: string;
  scope: ConnectorScope;
  spaceId: string;
  projectId?: string;
  userId?: string;
  grantedScopes: string[];
}

export class ConnectorBindingMatrix {
  constructor(private readonly bindings: ConnectorBinding[]) {}

  resolve(
    alias: string,
    context: { spaceId: string; projectId?: string; userId?: string }
  ): ConnectorBinding | null {
    const candidates = this.bindings.filter(
      (binding) =>
        binding.alias === alias && binding.spaceId === context.spaceId
    );
    return (
      candidates.find(
        (binding) =>
          binding.scope === "user" && binding.userId === context.userId
      ) ??
      candidates.find(
        (binding) =>
          binding.scope === "project" && binding.projectId === context.projectId
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
  return DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command));
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
    signature !== (await hmac(secret, payload))
  )
    return null;
  const grant = JSON.parse(
    new TextDecoder().decode(base64UrlToBytes(payload))
  ) as CapabilityGrant;
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

// Features 23-24: virtual commands and durable synthesized parsers.
export type VirtualCommandHandler = (args: string[]) => Promise<unknown>;
export interface VirtualCommandStore {
  get(name: string): Promise<string | null>;
  put(name: string, source: string): Promise<void>;
}

export class VirtualCli {
  private readonly commands = new Map<string, VirtualCommandHandler>();
  constructor(private readonly store?: VirtualCommandStore) {}
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
    await this.store?.put(name, source);
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
  const source = `export async function run(args, ctx) {\n${steps.map((step) => `  await ctx.cli.run(${JSON.stringify(step.operation)}, ${JSON.stringify(Object.keys(step.input))}.map(k => String(args[k] ?? "")));`).join("\n")}\n}`;
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

// Features 40-41: deterministic prompt assembly and role firewall.
export interface PromptLayers {
  kernel: string;
  business: string;
  soul: string;
  founderDirectives: string;
}
export function assembleSystemPrompt(layers: PromptLayers): string {
  return `<kernel>${layers.kernel}</kernel>\n<business_context>${layers.business}</business_context>\n<soul>${layers.soul}</soul>\n<founder_directives>${layers.founderDirectives}</founder_directives>`;
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
