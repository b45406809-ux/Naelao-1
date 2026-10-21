import { describe, expect, it } from "vitest";
import { LAUNCHPAD_MANIFEST } from "../../spaces/src/launchpad-manifest.js";
import { provisionSpace, type Env } from "./index.js";
import type { ProvisionMessage } from "./message-contract.js";

const message: ProvisionMessage = {
  type: "space_provision",
  spaceId: "space-a",
  tenantId: "tenant-a",
  spaceTypeId: "launchpad",
  spaceName: "Acme",
  requestedAt: "2026-10-21T00:00:00.000Z",
};

function makeEnv(failingPath: "registry" | "install-record"): { env: Env; calls: string[]; sql: string[] } {
  const calls: string[] = [];
  const sql: string[] = [];
  const manifest = {
    ...LAUNCHPAD_MANIFEST,
    backend: { ...LAUNCHPAD_MANIFEST.backend, r2Prefixes: [], scriptAgentsEnabled: false },
    ui: { ...LAUNCHPAD_MANIFEST.ui, externalPortal: undefined },
  };
  const env = {
    ENVIRONMENT: "test",
    PLATFORM_SECRET: "provisioner-test-secret",
    PLATFORM_DB: {
      prepare(query: string) {
        sql.push(query);
        return {
          bind() {
            return {
              async first() { return { status: "provisioning" }; },
              async run() { return { meta: { changes: 1 } }; },
            };
          },
        };
      },
    },
    SPACES_KV: { async put() {}, async delete() {} },
    SCRIPTS_R2: { async put() {}, async list() { return { objects: [], truncated: false }; } },
    SPACES_WORKER: {
      async fetch(request: Request) {
        const url = new URL(request.url);
        calls.push(`${request.method} ${url.pathname}`);
        if (url.pathname === "/internal/space-types/launchpad") return Response.json(manifest);
        if (request.method === "GET" && url.pathname === "/spaces/space-a/agent-definitions") {
          return Response.json({ data: [] });
        }
        if (failingPath === "registry" && url.pathname === "/spaces/space-a/registry") {
          return new Response("registry unavailable", { status: 503 });
        }
        if (failingPath === "install-record" && url.pathname === "/internal/space-types-record-install/launchpad") {
          return new Response("registry unavailable", { status: 503 });
        }
        return new Response(null, { status: 200 });
      },
    },
  } as unknown as Env;
  return { env, calls, sql };
}

describe("provisioning required registry routes", () => {
  it.each([
    ["registry", "/spaces/space-a/registry"],
    ["install-record", "/internal/space-types-record-install/launchpad"],
  ] as const)("rolls back instead of activating when %s fails", async (failingPath, failedRoute) => {
    const { env, calls, sql } = makeEnv(failingPath);
    await expect(provisionSpace(message, env)).rejects.toThrow(/failed/);
    expect(calls).toContain(`POST ${failedRoute}`);
    if (failingPath === "registry") {
      expect(calls).not.toContain("POST /internal/space-types-record-install/launchpad");
    }
    expect(sql.some((query) => /SET status = 'active'/.test(query))).toBe(false);
    expect(sql.some((query) => /SET status = 'error'/.test(query))).toBe(true);
  });
});
