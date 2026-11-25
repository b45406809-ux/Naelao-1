import { afterEach, describe, expect, it, vi } from "vitest";
import { approveProjectExtensionResourceGrant, getProjectExtensionResourceGrants, getProjectExtensionResourceUsage, hasReviewableProjectExtensionResources, projectExtensionCapStatusLabel, projectExtensionSetupStatusLabel, reviewProjectExtensionUpdate, revokeProjectExtensionResourceGrant, setProjectExtensionResourceBudget } from "./api";

describe("Project extension resource grant caller", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("exposes jobs alongside object and structured-data requirements in the owner inventory", () => {
    expect(hasReviewableProjectExtensionResources([{ id: "queue", kind: "jobs", scope: "project", operations: [] }])).toBe(true);
    expect(hasReviewableProjectExtensionResources([{ id: "db", kind: "structured_data", scope: "project", operations: [] }])).toBe(true);
    expect(hasReviewableProjectExtensionResources([{ id: "files", kind: "objects", scope: "project", operations: [] }])).toBe(true);
    expect(hasReviewableProjectExtensionResources([])).toBe(false);
    expect(hasReviewableProjectExtensionResources(undefined)).toBe(false);
  });

  it("labels a jobs-only staging install as awaiting resource approval", () => {
    expect(projectExtensionSetupStatusLabel("staging", [{ id: "queue", kind: "jobs", scope: "project", operations: [] }]))
      .toBe("resource approval required");
    expect(projectExtensionSetupStatusLabel("staging", [])).toBe("setup incomplete");
    expect(projectExtensionSetupStatusLabel("active", [])).toBe("enabled");
    expect(projectExtensionSetupStatusLabel("disabled", [])).toBe("paused");
  });

  it("reads bounded job receipts through the authenticated exact-install usage route", async () => {
    const fetch = vi.fn(async () => Response.json({ installation_id: "install:1", generation: 3, operations: [], receipts: [] }));
    vi.stubGlobal("fetch", fetch);
    const result = await getProjectExtensionResourceUsage("space one", "project/1", "install:1", { sessionToken: "session-token", endUserId: "project-owner" });
    expect(result).toMatchObject({ installation_id: "install:1", generation: 3, operations: [], receipts: [] });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url).pathname).toBe("/v1/spaces/space%20one/projects/project%2F1/extension-installations/install%3A1/resource-grants/usage");
    expect(init.cache).toBe("no-store");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer session-token");
  });

  it("parses the estimate-only unit credits and cap status from the usage snapshot", async () => {
    const usage = { installation_id: "install:1", generation: 3, cap_status: "warning",
      estimated_unit_credits: { estimate_only: true, credits: 7, price_version: "ext-units-2026-11-25", breakdown: { invocations: 2, job_units: 3, bytes: 2 } },
      credit_usage: { window_start: "2026-11-01 00:00:00", unit: "internal_credits", settled_credits: 800, held_credits: 0, monthly_cap: 1000, remaining_credits: 200, budget_revision: 1 },
      resource_units: { window_start: "2026-11-01 00:00:00", invocations: 101, job_units: 3, request_response_bytes: 104857601 }, operations: [], receipts: [] };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(usage)));
    const result = await getProjectExtensionResourceUsage("space", "project", "install:1", { sessionToken: "session-token", endUserId: "project-owner" });
    expect(result.estimated_unit_credits).toEqual(usage.estimated_unit_credits);
    expect(result.cap_status).toBe("warning");
    expect(projectExtensionCapStatusLabel(result.cap_status)).toBe("at least 80% of the monthly cap is used");
    expect(projectExtensionCapStatusLabel("reached")).toContain("reached");
    expect(projectExtensionCapStatusLabel("ok")).toBe("within the monthly cap");
    expect(projectExtensionCapStatusLabel(null)).toBe("no monthly cap approved");
  });

  it("submits the exact install generation and current manifest pin for a read-only candidate review", async () => {
    const fetch = vi.fn(async () => Response.json({ installation_id: "install-1", installation_generation: 7,
      candidate: { version: "2.0.0", signature_verified: true }, apply_supported: false, mutates_installation: false }));
    vi.stubGlobal("fetch", fetch);
    await reviewProjectExtensionUpdate("space", "project", "install-1", { candidateVersion: "2.0.0", expectedGeneration: 7,
      expectedCurrentVersion: "1.0.0", expectedManifestSha256: "a".repeat(64) },
    { sessionToken: "session-token", endUserId: "project-owner" });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url).pathname).toBe("/v1/spaces/space/projects/project/extension-installations/install-1/update-review");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer session-token");
    expect(JSON.parse(String(init.body))).toEqual({ candidate_version: "2.0.0", expected_generation: 7,
      expected_current_version: "1.0.0", expected_manifest_sha256: "a".repeat(64) });
  });

  it("reads, approves and revokes through the authenticated exact-install route", async () => {
    const fetch = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetch);
    const session = { sessionToken: "session-token", endUserId: "project-owner" };
    await getProjectExtensionResourceGrants("space one", "project/1", "install:1", session);
    await approveProjectExtensionResourceGrant("space one", "project/1", "install:1", session,
      { requirement_id: "records", expected_revision: 0, operations: ["get"], tables: ["catalog"] });
    await approveProjectExtensionResourceGrant("space one", "project/1", "install:1", session,
      { requirement_id: "attachments", expected_revision: 0, operations: ["get"], tables: [] });
    await revokeProjectExtensionResourceGrant("space one", "project/1", "install:1", session,
      { requirement_id: "records", expected_revision: 1 });
    await setProjectExtensionResourceBudget("space one", "project/1", "install:1", session,
      { expected_revision: 0, max_run_credits: 25, monthly_credits: 250 });

    const calls = fetch.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls.map(([url]) => new URL(url).pathname)).toEqual([
      ...Array(4).fill("/v1/spaces/space%20one/projects/project%2F1/extension-installations/install%3A1/resource-grants"),
      "/v1/spaces/space%20one/projects/project%2F1/extension-installations/install%3A1/resource-grants/budget",
    ]);
    expect(new Headers(calls[0]![1].headers).get("authorization")).toBe("Bearer session-token");
    expect(calls[0]![1].cache).toBe("no-store");
    expect(calls[1]![1].method).toBe("PUT");
    expect(JSON.parse(String(calls[1]![1].body))).toEqual({ requirement_id: "records", expected_revision: 0, operations: ["get"], tables: ["catalog"] });
    expect(calls[2]![1].method).toBe("PUT");
    expect(JSON.parse(String(calls[2]![1].body))).toEqual({ requirement_id: "attachments", expected_revision: 0, operations: ["get"], tables: [] });
    expect(calls[3]![1].method).toBe("DELETE");
    expect(JSON.parse(String(calls[3]![1].body))).toEqual({ requirement_id: "records", expected_revision: 1 });
    expect(calls[4]![1].method).toBe("PUT");
    expect(new Headers(calls[4]![1].headers).get("authorization")).toBe("Bearer session-token");
    expect(JSON.parse(String(calls[4]![1].body))).toEqual({ expected_revision: 0, max_run_credits: 25, monthly_credits: 250 });
  });
});
