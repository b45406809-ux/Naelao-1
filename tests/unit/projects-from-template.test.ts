import { describe, it, expect, vi } from "vitest";
import { app } from "../../workers/agents/src/index.js";
import type { AgentsEnv } from "../../workers/agents/src/index.js";
import { PROJECT_TEMPLATES } from "../../workers/agents/src/launchpad/project-templates.js";
import { mintInternalToken } from "@naelao/http";

const SECRET = "test-platform-secret";
const SPACE_ID = "space-1";
const TENANT_ID = "tenant-1";

function makeEnv(spacesFetch = vi.fn(async () => Response.json({ id: "unused" }))) {
  return {
    PLATFORM_SECRET: SECRET,
    SPACES_WORKER: { fetch: spacesFetch },
  } as unknown as AgentsEnv;
}

async function request(templateId: string, token?: string): Promise<Request> {
  const headers = new Headers({ "content-type": "application/json", "x-naelao-tenant-id": TENANT_ID });
  if (token) headers.set("x-naelao-internal-token", token);
  return new Request(`https://agents.naelao.com/spaces/${SPACE_ID}/projects/from-template`, {
    method: "POST", headers, body: JSON.stringify({ template_id: templateId }),
  });
}

describe("project template host boundary", () => {
  it("keeps product project presets out of the kernel catalog", async () => {
    expect(PROJECT_TEMPLATES).toEqual([]);
    const res = await app.fetch(new Request("https://agents.naelao.com/project-templates"), makeEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [], count: 0 });
  });

  it("requires a signed internal caller before resolving a project template", async () => {
    const calls = vi.fn(async () => Response.json({ id: "should-not-run" }));
    const res = await app.fetch(await request("whop-seller"), makeEnv(calls));
    expect(res.status).toBe(401);
    expect(calls).not.toHaveBeenCalled();
  });

  it("rejects retired built-in presets without creating or configuring a project", async () => {
    const calls = vi.fn(async () => Response.json({ id: "should-not-run" }));
    const token = await mintInternalToken(SECRET, TENANT_ID);
    const res = await app.fetch(await request("community-member-monitoring", token), makeEnv(calls));
    expect(res.status).toBe(404);
    expect(calls).not.toHaveBeenCalled();
  });
});
