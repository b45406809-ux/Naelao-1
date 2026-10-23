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

  it("exposes custom FDE marketplace cards only as deployment-pinned TOOL_SANDBOX images", () => {
    const custom = { image: `registry.cloudflare.com/${"1".repeat(32)}/fde/pdf@sha256:${"c".repeat(64)}`, binding: "TOOL_SANDBOX",
      memoryMb: 4096, cpuCores: 0.5, schedulingPolicy: "durable_object", networkPolicy: "none",
      marketplace: { id: "pdf-processor", name: "PDF Processor", description: "Bounded PDF utility tools.", category: "compute", exportedBinaries: ["pdf-inspect"] } };
    const catalogue = deployedContainerCatalogue(JSON.stringify([custom]), ["TOOL_SANDBOX"], [custom.image]);
    expect(deployedContainerCatalogue(JSON.stringify([custom]), ["TOOL_SANDBOX"]).find(item => item.id === "pdf-processor")).toBeUndefined();
    expect(catalogue.find(item => item.id === "pdf-processor")).toMatchObject({ available: true,
      image: custom.image, exported_binaries: ["pdf-inspect"], install_manifest: { containers: [{ resources: { timeoutSeconds: 60 }, networkPolicy: "none" }] } });
    expect(deployedContainerCatalogue(JSON.stringify([custom]), []).find(item => item.id === "pdf-processor")).toBeUndefined();
    expect(() => deployedContainerCatalogue(JSON.stringify([{ ...custom, marketplace: { ...custom.marketplace, id: "../unsafe" } }]), ["TOOL_SANDBOX"]))
      .toThrow("container_marketplace_entry_invalid");
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

  it("recommends the assistant workspace only when discovery has no project scope", async () => {
    const ctx = { env: { tenantId: "tenant", spaceId: "space", containerRuntimeInventory: async () => ({ installed: [], catalogue: [
      { id: "ffmpeg", name: "FFmpeg", description: "media", category: "media", available: true, exported_binaries: ["ffmpeg"] },
    ] }) }, run: async () => undefined } as never;
    expect(await runtimeDiscovery.operations["runtime.find"]({ binary: "ffmpeg" }, ctx)).toMatchObject({
      status: "installation_required", scope: "SPACE_ASSISTANT", workspace: "space_assistant",
    });
  });

  it("returns only actor-scoped installed commands and rejects invalid binary names", async () => {
    const installed = { tenantId: "tenant", spaceId: "space", projectId: "project", installationId: "instance-1",
      extensionId: "ext_runtime_ffmpeg", contract: { id: "ffmpeg", image: pin("a").image, exportedBinaries: ["ffmpeg", "ffprobe"] } };
    const ctx = { env: { tenantId: "tenant", spaceId: "space", projectId: "project", containerRuntimeInventory: async () => ({ installed: [installed], catalogue: [] }) }, run: async () => undefined } as never;
    expect(await runtimeDiscovery.operations["runtime.find"]({ binary: "ffmpeg" }, ctx)).toMatchObject({ status: "installed", candidates: [{ command: "ext_runtime_ffmpeg/ffmpeg/ffmpeg" }] });
    await expect(runtimeDiscovery.operations["runtime.find"]({ binary: "../ffmpeg" }, ctx)).rejects.toThrow("runtime_binary_invalid");
  });
});
