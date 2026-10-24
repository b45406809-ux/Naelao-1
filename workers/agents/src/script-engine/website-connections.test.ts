import { describe, it, expect, vi } from "vitest";
import { buildCodeRunner } from "./code-runner.js";
const connections = [
  {
    id: "connection",
    name: "Website",
    start_url: "https://example.com/login",
    origins: ["https://example.com", "https://login.example.com"],
    agent_ids: [],
    project_id: "project",
  },
];
const input = {
  name: "browser-use.navigate",
  code: "",
  tier: 4 as const,
  args: { connection_id: "connection" },
  tenantId: "tenant",
  spaceId: "space",
  projectId: "project",
  userId: "user",
  agentId: "worker",
  runId: "run",
  maxTier: 5,
};
describe("assistant website accounts", () => {
  it("loads the host granted account with persistent Chromium", async () => {
    const seen: Record<string, unknown>[] = [];
    const browserWorker = {
      fetch: vi.fn(async (req: Request) => {
        seen.push(await req.json<Record<string, unknown>>());
        return Response.json({
          ok: true,
          result: {
            schema: 1,
            sessionId: "session",
            revision: "revision",
            url: connections[0]!.start_url,
            text: "Page",
            elements: [],
            engine: "chromium",
            features: { persistentLogin: true },
            untrusted: true,
            capturedAt: Date.now(),
            expiresAt: Date.now() + 30000,
          },
          engine_used: "chromium",
        });
      }),
    } as unknown as Fetcher;
    const runner = buildCodeRunner({
      platformSecret: "secret",
      browserWorker,
      authorizeBrowser: async () => true,
      listWebsiteConnections: async () => connections,
    });
    const result = await runner.run(input);
    expect(result.ok).toBe(true);
    expect(result.engine).toBe("chromium");
    expect(seen[0]?.scope).toMatchObject({
      connectionId: "connection",
      projectId: "project",
      authorizedOrigins: connections[0]!.origins,
    });
    expect(JSON.stringify(result.output)).not.toContain("cookies");
  });
  it("rejects invented connections and respects the runtime ceiling", async () => {
    const fetch = vi.fn();
    const runner = buildCodeRunner({
      platformSecret: "secret",
      browserWorker: { fetch } as unknown as Fetcher,
      authorizeBrowser: async () => true,
      listWebsiteConnections: async () => connections,
    });
    expect(
      (await runner.run({ ...input, args: { connection_id: "other" } })).error
    ).toContain("not_authorized");
    expect((await runner.run({ ...input, maxTier: 4 })).error).toContain(
      "ceiling"
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it("requires a live grant even to discover account metadata", async () => {
    const runner = buildCodeRunner({
      platformSecret: "secret",
      browserWorker: {} as Fetcher,
      authorizeBrowser: async () => false,
      listWebsiteConnections: async () => connections,
    });
    expect(
      (
        await runner.run({
          ...input,
          name: "browser-use.connections",
          args: {},
        })
      ).error
    ).toContain("not_authorized");
  });
});
