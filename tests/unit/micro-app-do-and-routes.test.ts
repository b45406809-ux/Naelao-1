import { describe, it, expect } from "vitest";
import { APP_STUDIO_KIND, getBusinessFeatureKind, creatableFeatureKindsForRole } from "@naelao/events";
import { microApp } from "../../workers/agents/src/script-engine/prebuilt/micro-app.js";
import { mintGatekeeperToken } from "@naelao/security";

describe("Micro-App & Prompt-to-Application Studio Engine", () => {
  const PLATFORM_SECRET = "secret_platform_test_key_gatekeeper_123456";

  it("Registers APP_STUDIO_KIND in business feature kinds catalog with correct parameters", () => {
    const kind = getBusinessFeatureKind("app_studio");
    expect(kind).toBeDefined();
    expect(kind?.kind).toBe("app_studio");
    expect(kind?.label).toBe("Micro-App & Tool Studio");
    expect(kind?.minCreationRole).toBe("editor");
    expect(kind?.viewportComponent).toBe("AppStudioCanvas");
    expect(kind?.allowedLadderTiers).toEqual([1, 2]);
    expect(kind?.prebuiltScripts).toContain("micro-app");

    // Check role filtering
    const viewerKinds = creatableFeatureKindsForRole("viewer");
    expect(viewerKinds.some((k) => k.kind === "app_studio")).toBe(false);

    const editorKinds = creatableFeatureKindsForRole("editor");
    expect(editorKinds.some((k) => k.kind === "app_studio")).toBe(true);
  });

  it("Provides micro-app prebuilt script with synthesis, deploy, query, and token minting operations", async () => {
    expect(microApp.name).toBe("micro-app");
    expect(microApp.domain).toBe("workspace");
    expect(microApp.requires_tier).toBe(1);

    const ops = Object.keys(microApp.operations);
    expect(ops).toContain("microapp.synthesize");
    expect(ops).toContain("microapp.deploy");
    expect(ops).toContain("microapp.query");
    expect(ops).toContain("microapp.insert");
    expect(ops).toContain("microapp.mint_token");

    // Test microapp.mint_token operation directly
    const mockCtx = {
      env: {
        spaceId: "sp_test_123",
        tenantId: "t_test_123",
        platformSecret: PLATFORM_SECRET,
        endUserId: "usr_alice",
      } as any,
      run: async () => ({}),
    };

    const mintOp = microApp.operations["microapp.mint_token"];
    const result = (await mintOp(
      {
        appId: "app_warehouse_tools",
        targetRole: "editor",
        grants: [
          { resource: "sqlite_db", target: "table:inventory", operations: ["read", "write"] },
        ],
      },
      mockCtx
    )) as { ok: boolean; token: string; appId: string; spaceId: string };

    expect(result.ok).toBe(true);
    expect(result.token.startsWith("gk_")).toBe(true);
    expect(result.appId).toBe("app_warehouse_tools");
  });

  it("microapp.synthesize calls spaces worker with structured deploy payload", async () => {
    let capturedUrl = "";
    let capturedBody: any = null;

    const mockSpacesWorker = {
      fetch: async (req: Request) => {
        capturedUrl = req.url;
        capturedBody = await req.json();
        return new Response(
          JSON.stringify({
            ok: true,
            appId: capturedBody.appId,
            spaceId: "sp_123",
            manifest: { title: capturedBody.title, version: 1 },
            gatekeeperToken: "gk_mock_token",
            appUrl: `/spaces/sp_123/micro-apps/${capturedBody.appId}/app`,
          }),
          { status: 201, headers: { "content-type": "application/json" } }
        );
      },
    } as unknown as Fetcher;

    const mockCtx = {
      env: {
        spaceId: "sp_123",
        tenantId: "t_123",
        platformSecret: PLATFORM_SECRET,
        endUserId: "usr_developer",
        spacesWorker: mockSpacesWorker,
      } as any,
      run: async () => ({}),
    };

    const synthOp = microApp.operations["microapp.synthesize"];
    const synthRes = (await synthOp(
      {
        title: "Leave Tracker",
        description: "Employee PTO and sick leave tracking app",
        schemaSql: "CREATE TABLE leave_requests (id TEXT PRIMARY KEY, employee TEXT, days INT);",
        initialData: [{ table: "leave_requests", records: [{ id: "l_1", employee: "Bob", days: 3 }] }],
      },
      mockCtx
    )) as any;

    expect(capturedUrl).toContain("/spaces/sp_123/micro-apps");
    expect(capturedBody.title).toBe("Leave Tracker");
    expect(capturedBody.schemaSql).toContain("CREATE TABLE leave_requests");
    expect(synthRes.ok).toBe(true);
    expect(synthRes.appUrl).toContain("/spaces/sp_123/micro-apps");
  });
});
