import type { BrowserObservedElement } from "@naelao/agent-sdk";
import type { ScriptEngineEnv } from "./types.js";
export type DemoTarget = { role: string; name: string };
export type BrowserDemoStep =
  | { type: "navigate" }
  | { type: "click" | "assert"; target: DemoTarget }
  | { type: "type" | "select"; target: DemoTarget; parameter: string };
export interface BrowserDemoSkill {
  schema: 1;
  name: string;
  description: string;
  steps: BrowserDemoStep[];
  digest: string;
  status: "draft" | "validated" | "enabled";
  source: "browser" | "video" | "manual";
  createdAt: number;
  validation?: {
    digest: string;
    testedAt: number;
    connectionId: string;
    runId: string;
  };
}
const segment = (value: string) => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/.test(value))
    throw new Error("invalid_learning_scope");
  return value;
};
export function demonstrationRoot(
  env: Pick<ScriptEngineEnv, "spaceId" | "projectId" | "userId">
) {
  if (!env.userId)
    throw new Error("demonstration_authenticated_owner_required");
  return `spaces/${segment(env.spaceId)}/assistant-learning/${env.projectId ? "projects/" + segment(env.projectId) : "assistant"}/users/${segment(env.userId)}/`;
}
export function validateDemoSteps(value: unknown): BrowserDemoStep[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 32)
    throw new Error("demonstration_requires_2_to_32_steps");
  const result = value.map((raw, index): BrowserDemoStep => {
    const s = raw as Record<string, unknown>;
    if (!s || typeof s !== "object" || Array.isArray(s))
      throw new Error("invalid_demonstration_step");
    if (
      s.type === "navigate" &&
      index === 0 &&
      Object.keys(s).every((k) => k === "type")
    )
      return { type: "navigate" };
    if (!["click", "assert", "type", "select"].includes(String(s.type)))
      throw new Error("unsupported_demonstration_step");
    const t = s.target as DemoTarget;
    if (
      !t ||
      typeof t.role !== "string" ||
      typeof t.name !== "string" ||
      !t.role ||
      !t.name ||
      t.role.length > 80 ||
      t.name.length > 256 ||
      /[\0\r\n]/.test(t.name)
    )
      throw new Error("demonstration_semantic_target_required");
    if (
      Object.keys(s).some(
        (k) => !["type", "target", "parameter"].includes(k)
      ) ||
      Object.keys(t).some((k) => !["role", "name"].includes(k))
    )
      throw new Error("demonstration_literal_or_handle_not_allowed");
    const target = { role: t.role, name: t.name };
    if (s.type === "type" || s.type === "select") {
      if (
        typeof s.parameter !== "string" ||
        !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(s.parameter)
      )
        throw new Error("demonstration_input_parameter_required");
      if (
        /password|passcode|one.?time|otp|verification|security.?code|recovery.?code/i.test(
          t.name
        )
      )
        throw new Error(
          "demonstration_credentials_require_connection_or_private_verification"
        );
      return { type: s.type, target, parameter: s.parameter };
    }
    return { type: s.type as "click" | "assert", target };
  });
  if (result[0]!.type !== "navigate" || result.at(-1)!.type !== "assert")
    throw new Error("demonstration_requires_navigation_and_final_assertion");
  return result;
}
export async function demoDigest(steps: BrowserDemoStep[]) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(steps))
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}
export class BrowserDemonstrationStore {
  private readonly root: string;
  constructor(
    private bucket: R2Bucket,
    env: Pick<ScriptEngineEnv, "spaceId" | "projectId" | "userId">
  ) {
    this.root = demonstrationRoot(env);
  }
  private key(name: string) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(name))
      throw new Error("invalid_demonstration_name");
    return this.root + name + ".json";
  }
  async read(
    name: string
  ): Promise<{ skill: BrowserDemoSkill; etag: string } | null> {
    const object = await this.bucket.get(this.key(name));
    if (!object) return null;
    if (object.size > 64 * 1024) throw new Error("demonstration_too_large");
    const skill = await object.json<BrowserDemoSkill>();
    if (
      skill.schema !== 1 ||
      skill.name !== name ||
      !["draft", "validated", "enabled"].includes(skill.status)
    )
      throw new Error("invalid_demonstration_document");
    const steps = validateDemoSteps(skill.steps);
    if (skill.digest !== (await demoDigest(steps)))
      throw new Error("demonstration_digest_mismatch");
    return { skill: { ...skill, steps }, etag: object.etag };
  }
  async draft(
    name: string,
    description: string,
    steps: unknown,
    source: BrowserDemoSkill["source"] = "manual"
  ) {
    this.key(name);
    if (typeof description !== "string" || description.length > 2000)
      throw new Error("invalid_demonstration_description");
    const validated = validateDemoSteps(steps),
      skill: BrowserDemoSkill = {
        schema: 1,
        name,
        description,
        steps: validated,
        digest: await demoDigest(validated),
        status: "draft",
        source,
        createdAt: Date.now(),
      };
    const put = await this.bucket.put(this.key(name), JSON.stringify(skill), {
      onlyIf: { etagDoesNotMatch: "*" },
    });
    if (!put) throw new Error("demonstration_name_already_exists");
    return skill;
  }
  async list() {
    const items: Array<{ name: string; status: string; description: string }> =
      [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await this.bucket.list({
        prefix: this.root,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      for (const item of page.objects) {
        const name = item.key.slice(this.root.length).replace(/\.json$/, "");
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(name)) continue;
        const s = await this.read(name);
        if (s)
          items.push({
            name,
            status: s.skill.status,
            description: s.skill.description,
          });
      }
      if (!page.truncated) break;
      if (!page.cursor || seen.has(page.cursor))
        throw new Error("demonstration_cursor_invalid");
      seen.add(page.cursor);
      cursor = page.cursor;
      if (items.length >= 200) break;
    } while (cursor);
    return items;
  }
  async validated(
    name: string,
    digest: string,
    connectionId: string,
    runId: string
  ) {
    const current = await this.read(name);
    if (!current || current.skill.digest !== digest)
      throw new Error("demonstration_revision_changed");
    const next: BrowserDemoSkill = {
      ...current.skill,
      status: "validated",
      validation: { digest, testedAt: Date.now(), connectionId, runId },
    };
    if (
      !(await this.bucket.put(this.key(name), JSON.stringify(next), {
        onlyIf: { etagMatches: current.etag },
      }))
    )
      throw new Error("demonstration_revision_changed");
    return next;
  }
  async enable(name: string, enabled: boolean) {
    const current = await this.read(name);
    if (!current) throw new Error("demonstration_not_found");
    if (
      enabled &&
      (!current.skill.validation ||
        current.skill.validation.digest !== current.skill.digest ||
        current.skill.status === "draft")
    )
      throw new Error("demonstration_requires_successful_test");
    const next = {
      ...current.skill,
      status: enabled ? ("enabled" as const) : ("draft" as const),
    };
    if (
      !(await this.bucket.put(this.key(name), JSON.stringify(next), {
        onlyIf: { etagMatches: current.etag },
      }))
    )
      throw new Error("demonstration_revision_changed");
    return next;
  }
  async claimReplay(name: string, runId: string) {
    this.key(name);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/.test(runId))
      throw new Error("invalid_demonstration_run");
    const key = this.root + "replays/" + name + "_" + runId + ".json";
    const created = await this.bucket.put(
      key,
      JSON.stringify({ status: "running", at: Date.now() }),
      { onlyIf: { etagDoesNotMatch: "*" } }
    );
    if (created) return { key };
    const existing = await this.bucket.get(key);
    if (!existing || existing.size > 4096)
      throw new Error("demonstration_reconciliation_required");
    const result = await existing.json<{ status: string; result?: unknown }>();
    if (result.status === "completed") return { key, result: result.result };
    throw new Error("demonstration_reconciliation_required");
  }
  async finishReplay(key: string, result: unknown) {
    if (!key.startsWith(this.root + "replays/"))
      throw new Error("invalid_demonstration_run");
    await this.bucket.put(
      key,
      JSON.stringify({
        status: result ? "completed" : "indeterminate",
        at: Date.now(),
        ...(result ? { result } : {}),
      })
    );
  }
  async discard(name: string) {
    await this.bucket.delete(this.key(name));
  }
}
export function resolveDemoTarget(
  elements: readonly BrowserObservedElement[],
  target: DemoTarget,
  action: "click" | "type" | "select" | "assert"
) {
  const matches = elements.filter(
    (e) =>
      e.role === target.role &&
      e.name === target.name &&
      e.enabled &&
      (action === "assert" || e.permittedActions.includes(action))
  );
  if (matches.length !== 1)
    throw new Error(
      matches.length
        ? "demonstration_target_ambiguous"
        : "demonstration_page_changed"
    );
  return matches[0]!;
}
/** Re-observe before every step; handles/revisions never persist in a learned skill. Nested
 * operations retain the ordinary browser grants, mutation approvals, budgets and action journal. */
export async function replayBrowserDemonstration(
  skill: BrowserDemoSkill,
  input: {
    connectionId: string;
    values: Record<string, unknown>;
    replayId: string;
  },
  run: (name: string, args: Record<string, unknown>) => Promise<unknown>
) {
  const steps = validateDemoSteps(skill.steps);
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,100}$/.test(input.replayId) ||
    !input.connectionId
  )
    throw new Error("demonstration_replay_identity_required");
  for (const step of steps)
    if (step.type === "type" || step.type === "select") {
      const value = input.values[step.parameter];
      if (
        typeof value !== "string" ||
        value.length > (step.type === "type" ? 8192 : 1024)
      )
        throw new Error("demonstration_parameter_missing_or_too_large");
    }
  let session: string | undefined,
    completed = 0;
  try {
    const nav = (await run("browser.navigate", {
      connection_id: input.connectionId,
      interactive: true,
    })) as Record<string, unknown>;
    if (typeof nav.session_id !== "string")
      throw new Error("demonstration_browser_session_missing");
    session = nav.session_id;
    completed = 1;
    for (let i = 1; i < steps.length; i++) {
      const step = steps[i]!;
      if (step.type === "navigate")
        throw new Error("invalid_demonstration_navigation");
      const view = (await run("browser.observe", {
        session_id: session,
        interactive: true,
      })) as Record<string, unknown>;
      if (
        typeof view.observation_revision !== "string" ||
        !Array.isArray(view.elements)
      )
        throw new Error("demonstration_observation_required");
      const target = resolveDemoTarget(
        view.elements as BrowserObservedElement[],
        step.target,
        step.type
      );
      if (step.type !== "assert")
        await run("browser." + step.type, {
          session_id: session,
          action_id: input.replayId + ":" + i,
          observation_revision: view.observation_revision,
          handle: target.handle,
          ...(step.type === "type"
            ? { text: input.values[step.parameter] }
            : step.type === "select"
              ? { value: input.values[step.parameter] }
              : {}),
        });
      completed++;
    }
    return { ok: true, completed, digest: skill.digest };
  } finally {
    if (session)
      await run("browser.close", { session_id: session }).catch(
        () => undefined
      );
  }
}
