import { describe, it, expect } from "vitest";
import spacesWorker from "../../workers/spaces/src/index.js";
import { SpaceDO } from "../../workers/spaces/src/do/SpaceDO.js";
import { makeStatefulDoNamespace } from "./helpers/fake-do-namespace.js";
import { mintInternalToken } from "@naelao/http";

// F-36: project_members.assistant_mode clamps what an assistant may do when acting ON BEHALF OF a
// specific user. INVARIANT: never more than that user's own project role.

const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const PLATFORM_SECRET = "test-platform-secret";
function makeEnv() { return { PLATFORM_SECRET, ENVIRONMENT: "test", SPACE_DO: makeStatefulDoNamespace(SpaceDO) }; }
async function h(): Promise<Record<string, string>> {
  return { "content-type": "application/json", "x-naelao-tenant-id": "t1", "x-naelao-internal-token": await mintInternalToken(PLATFORM_SECRET, "t1") };
}
function req(path: string, hdr: Record<string, string>, init?: RequestInit): Request {
  return new Request(`https://spaces.naelao.com${path}`, { ...init, headers: { ...hdr, ...(init?.headers as Record<string, string> | undefined) } });
}
async function mkProject(env: ReturnType<typeof makeEnv>): Promise<string> {
  const res = await spacesWorker.fetch(req(`/spaces/s1/projects`, await h(), { method: "POST", body: JSON.stringify({ space_id: "s1", name: "P" }) }), env as never, execCtx);
  return (await res.json() as { id: string }).id;
}
async function addMember(env: ReturnType<typeof makeEnv>, pid: string, userId: string, role: string, assistantMode?: string) {
  return spacesWorker.fetch(req(`/spaces/s1/projects/${pid}/members`, await h(), { method: "POST", body: JSON.stringify({ user_id: userId, role, assistant_mode: assistantMode }) }), env as never, execCtx);
}
async function effectiveRole(env: ReturnType<typeof makeEnv>, pid: string, userId: string): Promise<string | null> {
  const res = await spacesWorker.fetch(req(`/spaces/s1/projects/${pid}/assistant-access?user_id=${userId}`, await h()), env as never, execCtx);
  return (await res.json() as { effective_role: string | null }).effective_role;
}

describe("F-36: assistant_mode per-user access clamp", () => {
  it("'inherit' (default) → effective role equals the user's own role", async () => {
    const env = makeEnv();
    const pid = await mkProject(env);
    await addMember(env, pid, "u1", "editor");
    expect(await effectiveRole(env, pid, "u1")).toBe("editor");
  });

  it("'read_only' clamps an owner down to viewer", async () => {
    const env = makeEnv();
    const pid = await mkProject(env);
    await addMember(env, pid, "u1", "owner", "read_only");
    expect(await effectiveRole(env, pid, "u1")).toBe("viewer");
  });

  it("'none' → zero access (null) even for an owner", async () => {
    const env = makeEnv();
    const pid = await mkProject(env);
    await addMember(env, pid, "u1", "owner", "none");
    expect(await effectiveRole(env, pid, "u1")).toBeNull();
  });

  it("a non-member user resolves to null (fail closed)", async () => {
    const env = makeEnv();
    const pid = await mkProject(env);
    expect(await effectiveRole(env, pid, "stranger")).toBeNull();
  });

  it("no acting user (empty) → null (the clamp is not its job; dispatch falls back to base grant)", async () => {
    const env = makeEnv();
    const pid = await mkProject(env);
    expect(await effectiveRole(env, pid, "")).toBeNull();
  });

  it("rejects an invalid assistant_mode with 400", async () => {
    const env = makeEnv();
    const pid = await mkProject(env);
    const res = await addMember(env, pid, "u1", "editor", "bogus");
    expect(res.status).toBe(400);
  });
});
