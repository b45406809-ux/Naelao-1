import { describe, expect, it } from "vitest";
import { NaelaoAgentDO } from "./NaelaoAgentDO.js";

describe("worker run access revalidation", () => {
  it.each([
    { label: "revoked", status: 200, body: { effective_role: null }, errorCode: "assistant_access_denied" },
    { label: "unavailable", status: 503, body: {}, errorCode: "assistant_access_unverified" },
  ])("fails closed when current Project assistant access is $label", async ({ status, body, errorCode }) => {
    const requests: Request[] = [];
    const spacesWorker = { fetch: async (request: Request) => {
      requests.push(request);
      return Response.json(body, { status });
    } };
    const instance = new NaelaoAgentDO({
      storage: { sql: { exec: () => ({ toArray: () => [], rowsWritten: 0 }) } },
      id: { toString: () => "worker-do" },
    } as never, { PLATFORM_SECRET: "test-signing-key", SPACES_WORKER: spacesWorker } as never);
    const gate = await (instance as unknown as { enforceRunGates(options: Record<string, unknown>): Promise<
      { ok: true } | { ok: false; response: Response }
    > }).enforceRunGates({ tenantId: "tenant", spaceId: "space", projectId: "project", userId: "member",
      callerRole: "product_end_user" });

    expect(gate.ok).toBe(false);
    if (gate.ok) throw new Error("expected Project access to be denied");
    expect(await gate.response.json()).toMatchObject({ error_code: errorCode });
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0]!.url).pathname).toBe("/spaces/space/projects/project/assistant-access");
    expect(new URL(requests[0]!.url).searchParams.get("user_id")).toBe("member");
  });
});
