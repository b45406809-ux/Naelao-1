import type { PrebuiltOpContext, PrebuiltScript } from "./index.js";
import {
  BrowserDemonstrationStore,
  replayBrowserDemonstration,
} from "../browser-demonstrations.js";
function store(c: PrebuiltOpContext) {
  return new BrowserDemonstrationStore(c.env.scriptsBucket, c.env);
}
async function execute(
  a: Record<string, unknown>,
  c: PrebuiltOpContext,
  test: boolean
) {
  const library = store(c),
    name = String(a.name ?? ""),
    current = await library.read(name);
  if (!current) throw new Error("demonstration_not_found");
  if (
    !test &&
    (current.skill.status !== "enabled" ||
      current.skill.validation?.digest !== current.skill.digest)
  )
    throw new Error("demonstration_not_enabled");
  if (!c.env.runId) throw new Error("demonstration_run_identity_required");
  const connectionId = String(a.connection_id ?? "");
  const values =
    a.values && typeof a.values === "object" && !Array.isArray(a.values)
      ? (a.values as Record<string, unknown>)
      : {};
  const parameters = [
    ...new Set(
      current.skill.steps.flatMap((step) =>
        step.type === "type" || step.type === "select" ? [step.parameter] : []
      )
    ),
  ].sort();
  if (
    !connectionId ||
    parameters.some(
      (key) =>
        typeof values[key] !== "string" || (values[key] as string).length > 8192
    )
  )
    throw new Error("demonstration_parameter_missing_or_too_large");
  const invocationIdentity = JSON.stringify([
    c.env.taskId ?? c.env.rootRunId ?? c.env.runId,
    current.skill.digest,
    connectionId,
    parameters.map((key) => [key, values[key]]),
  ]);
  const runHash = Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(invocationIdentity)
      )
    ),
    (b) => b.toString(16).padStart(2, "0")
  ).join("");
  const replayId = (test ? "test:" : "run:") + runHash;
  const claim = await library.claimReplay(name, replayId);
  if ("result" in claim) return claim.result;
  try {
    const result = await replayBrowserDemonstration(
      current.skill,
      { connectionId, values, replayId: replayId.slice(0, 100) },
      async (op, p) => {
        if (op !== "browser.close") {
          const latest = await library.read(name);
          if (
            !latest ||
            latest.skill.digest !== current.skill.digest ||
            (!test && latest.skill.status !== "enabled")
          )
            throw new Error("demonstration_disabled_or_changed");
        }
        return c.run(op, p);
      }
    );
    if (test)
      await library.validated(
        name,
        current.skill.digest,
        connectionId,
        c.env.runId
      );
    await library.finishReplay(claim.key, result);
    return {
      ...result,
      status: test ? "validated" : "completed",
      requires_explicit_enable: test,
    };
  } catch (e) {
    await library.finishReplay(claim.key, null);
    throw e;
  }
}
export const browserDemonstrations: PrebuiltScript = {
  name: "browser-demonstrations",
  domain: "browser",
  requires_tier: 4,
  description:
    "Learn reusable browser skills from demonstrations: scoped drafts, actual replay tests and explicitly enabled workflows. Stable semantic targets; no stored credentials or expiring handles.",
  manual_markdown: `# Learning browser skills
A demonstration is private to its authenticated author and exact Space or Project workspace. Draft it as bounded semantic steps: first {type:"navigate"} uses the supplied authorized website connection; clicks and assertions use target:{role,name}; type/select steps use a named parameter instead of recorded input. The final step must assert a unique expected element. Never capture passwords, OTPs, cookies, session handles, arbitrary code or terminal commands.
Use skill.demo.test on an explicitly authorized test account with example values; it actually performs the steps through ordinary browser grants/approvals and requires the final assertion. Passing syntax alone never validates a skill. Tests may perform real actions; use synthetic test data and respect ordinary action approvals. The authenticated user enables a successfully tested version from Apps; a worker cannot enable its own draft. Only then use skill.demo.run. A changed/ambiguous page stops the replay, and an interrupted replay is held for review rather than repeated. Every action re-observes and resolves a unique semantic target. No peer messaging or new model provider is introduced. Uploaded videos require a configured multimodal analyzer and the same review/test/enable gates.`,
  operations: {
    "skill.demo.draft": (a, c) =>
      store(c).draft(
        String(a.name ?? ""),
        String(a.description ?? ""),
        a.steps,
        "manual"
      ),
    "skill.demo.list": (_a, c) => store(c).list(),
    "skill.demo.read": async (a, c) =>
      (await store(c).read(String(a.name ?? "")))?.skill ?? null,
    "skill.demo.test": (a, c) => execute(a, c, true),
    "skill.demo.run": (a, c) => execute(a, c, false),
  },
  paramHints: {
    "skill.demo.draft":
      "{name,description,steps}: stage 2..32 semantic browser steps, navigate first and assert last; inputs are parameters, never literals.",
    "skill.demo.list":
      "List the current user’s demonstration skills in this exact assistant workspace, with draft/validated/enabled status.",
    "skill.demo.read": "{name}: inspect steps and current validation evidence.",
    "skill.demo.test":
      "{name,connection_id,values:{parameter:string}}: perform an actual test through current permissions and ordinary action approvals. Use a test account. Does not enable.",
    "skill.demo.run":
      "{name,connection_id,values:{parameter:string}}: replay an explicitly enabled tested skill; page drift/ambiguous targets stop the task.",
  },
};
