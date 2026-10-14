import { describe, expect, it, vi } from "vitest";
import { deployedContainerCatalogue } from "../container-catalogue.js";
import { runtimeDiscovery } from "./runtime-discovery.js";

const pin = (hex: string, binding: "DOCUMENT_SANDBOX" | "MEDIA_SANDBOX" = "MEDIA_SANDBOX") => ({
  image: `registry.example/${binding.toLowerCase()}@sha256:${hex.repeat(64)}`,
  binding, memoryMb: 4096, cpuCores: 0.5, schedulingPolicy: "default", networkPolicy: "none",
});

describe("runtime discovery and deployment approval", () => {
  it("advertises only fixed bindings with one exact approved digest", () => {
    const catalogue = deployedContainerCatalogue(JSON.stringify([pin("a")]), ["MEDIA_SANDBOX"]);
    expect(catalogue.find(item => item.id === "ffmpeg")).toMatchObject({ available: true,
      image: expect.stringContaining("@sha256:"), exported_binaries: ["ffmpeg", "ffprobe"] });
    expect(catalogue.find(item => item.id === "libreoffice")?.available).toBe(false);
    expect(catalogue.find(item => item.id === "postgres-16")?.available).toBe(false);
    expect(deployedContainerCatalogue(JSON.stringify([pin("a"), pin("b")]), ["MEDIA_SANDBOX"])
      .find(item => item.id === "ffmpeg")?.available).toBe(false);
    expect(deployedContainerCatalogue(JSON.stringify([pin("a")]), []).find(item => item.id === "ffmpeg")?.available).toBe(false);
  });

  it("proposes an approved runtime without installing or allocating it", async () => {
    const fetch = vi.fn();
    const ctx = { env: { tenantId: "tenant", spaceId: "space", projectId: "project",
      containerRuntimeInventory: async () => ({ installed: [], catalogue: deployedContainerCatalogue(JSON.stringify([pin("a")]), ["MEDIA_SANDBOX"]) }),
      fastDecision: { choice: fetch } }, run: async () => undefined } as never;
    const result = await runtimeDiscovery.operations["runtime.find"]({ binary: "ffmpeg" }, ctx) as Record<string, unknown>;
    expect(result).toMatchObject({ status: "installation_required", binary: "ffmpeg", recommended: "ffmpeg",
      requires_human_approval: true, scope: "PROJECT_SHARED", project_id: "project" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns only actor-scoped installed commands and rejects invalid binary names", async () => {
    const installed = { tenantId: "tenant", spaceId: "space", projectId: "project", installationId: "instance-1",
      extensionId: "ext_runtime_ffmpeg", contract: { id: "ffmpeg", image: pin("a").image, exportedBinaries: ["ffmpeg", "ffprobe"] } };
    const ctx = { env: { tenantId: "tenant", spaceId: "space", projectId: "project", containerRuntimeInventory: async () => ({ installed: [installed], catalogue: [] }) }, run: async () => undefined } as never;
    expect(await runtimeDiscovery.operations["runtime.find"]({ binary: "ffmpeg" }, ctx)).toMatchObject({ status: "installed", candidates: [{ command: "ext_runtime_ffmpeg/ffmpeg/ffmpeg" }] });
    await expect(runtimeDiscovery.operations["runtime.find"]({ binary: "../ffmpeg" }, ctx)).rejects.toThrow("runtime_binary_invalid");
  });
});
