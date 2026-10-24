import { describe, it, expect } from "vitest";
import {
  fixture,
  scope,
} from "../../../../tests/fixtures/assistant-communications.js";
import { assistantConversation } from "./conversations.js";
function setup() {
  const f = fixture(),
    sessions = new Map<string, Record<string, unknown>>(),
    threads = new Map<string, Record<string, unknown>>();
  f.fetch.mockImplementation(async (r: Request) => {
    const path = new URL(r.url).pathname,
      user = r.headers.get("x-naelao-user-id");
    if (path.includes("assistant-access"))
      return Response.json({
        effective_role: user === "other" ? "editor" : "owner",
      });
    if (r.method === "POST" && path.endsWith("/threads")) {
      const b = (await r.json()) as Record<string, unknown>;
      threads.set(String(b.id), b);
      return Response.json(b);
    }
    if (r.method === "POST" && path.endsWith("/sessions")) {
      const b = (await r.json()) as Record<string, unknown>;
      sessions.set(String(b.id), { ...b, user });
      return Response.json(b);
    }
    if (path.includes("/sessions/")) {
      const b = sessions.get(path.split("/").pop()!);
      return b && b.user === user
        ? Response.json(b)
        : new Response(null, { status: 403 });
    }
    if (path.includes("/threads/"))
      return Response.json(threads.get(path.split("/").pop()!));
    return Response.json({ preferences: { enabled: { email: true } } });
  });
  return { ...f, sessions, threads };
}
describe("verified cross-channel assistant conversations", () => {
  it.each([undefined, "project"])(
    "uses one default conversation per user in assistant scope %s",
    async (project) => {
      const f = setup(),
        s = { ...scope, ...(project ? { projectId: project } : {}) };
      const id = await assistantConversation(f.env, s);
      expect(await assistantConversation(f.env, s)).toBe(id);
      expect(f.sessions.size).toBe(1);
      expect(f.threads.size).toBe(project ? 1 : 0);
    }
  );
  it("keeps two members' Project conversations private", async () => {
    const f = setup();
    const one = await assistantConversation(f.env, {
      ...scope,
      projectId: "project",
    });
    const two = await assistantConversation(f.env, {
      ...scope,
      userId: "other",
      projectId: "project",
    });
    expect(one).not.toBe(two);
    await expect(
      assistantConversation(
        f.env,
        { ...scope, userId: "other", projectId: "project" },
        one
      )
    ).rejects.toThrow("voice_session_unavailable");
  });
  it("binds a selected web conversation but rejects heartbeat sessions", async () => {
    const f = setup();
    f.sessions.set("web", { id: "web", user: scope.userId });
    expect(await assistantConversation(f.env, scope, "web")).toBe("web");
    expect(await assistantConversation(f.env, scope)).toBe("web");
    f.sessions.set("heartbeat", {
      id: "heartbeat",
      user: scope.userId,
      metadata: { session_kind: "heartbeat" },
    });
    await expect(
      assistantConversation(f.env, scope, "heartbeat")
    ).rejects.toThrow("heartbeat_is_not_a_conversation");
    expect(await assistantConversation(f.env, scope)).toBe("web");
  });
});
