import { describe, expect, it, vi } from "vitest";
import { r2Workspace } from "./r2-workspace.js";

function context(options: { declaredSize: number; bytes: Uint8Array }) {
  const arrayBuffer = vi.fn(async () => options.bytes.slice().buffer);
  const object = {
    size: options.declaredSize,
    customMetadata: {},
    arrayBuffer,
    text: async () => new TextDecoder().decode(options.bytes),
  };
  const bucket = {
    head: async () => ({ size: options.declaredSize, customMetadata: {} }),
    get: async () => object,
  };
  return {
    ctx: {
      env: {
        workspaceBucket: bucket,
        spaceId: "space-1",
        tenantId: "tenant-1",
      },
    } as never,
    arrayBuffer,
  };
}

function readFile(args: Record<string, unknown>, ctx: never) {
  const operation = r2Workspace.operations.read_file;
  if (!operation)
    throw new Error("r2-workspace read_file operation is missing");
  return operation(args, ctx);
}

describe("r2-workspace streamed object size boundaries", () => {
  it("rejects a fetched object whose bytes disagree with R2 size metadata", async () => {
    const { ctx, arrayBuffer } = context({
      declaredSize: 10,
      bytes: new Uint8Array([0x61]),
    });
    await expect(readFile({ path: "notes.txt" }, ctx)).rejects.toThrow(
      "changed size during read"
    );
    expect(arrayBuffer).toHaveBeenCalledOnce();
  });

  it("rejects range reads that return more bytes than the requested range", async () => {
    const { ctx } = context({
      declaredSize: 100,
      bytes: new Uint8Array(200_001),
    });
    await expect(
      readFile({ path: "notes.txt", offset: 0, length: 200_000 }, ctx)
    ).rejects.toThrow("exceeded requested range");
  });
});

describe("Space-shared filesystem capability", () => {
  const read = r2Workspace.operations.shared_read_file!;
  const write = r2Workspace.operations.shared_write_file!;
  it("fails closed without a host-injected Space extension grant", async () => {
    const get = vi.fn();
    const ctx = { env: { spaceId: "space-1", workspaceBucket: { get } } } as never;
    await expect(read({ path: "dropzones/audio/input.wav" }, ctx)).rejects.toThrow("space_shared_filesystem_denied");
    expect(get).not.toHaveBeenCalled();
  });
  it("reads only an opted-in directory and rejects writes under a read-only grant", async () => {
    const get = vi.fn(async (key: string) => ({ size: 5, customMetadata: { sha256: "hash" }, arrayBuffer: async () => new TextEncoder().encode("audio").buffer }));
    const put = vi.fn();
    const ctx = { env: { spaceId: "space-1", spaceWorkspaceExtensionId: "install-a", spaceSharedFilesystemGrants: [
      { path: "/space/shared/dropzones/audio/", access: "READ" },
    ], workspaceBucket: { get, put } } } as never;
    await expect(read({ path: "dropzones/audio/input.txt" }, ctx)).resolves.toMatchObject({ exists: true, content: "audio" });
    expect(get).toHaveBeenCalledWith("spaces/space-1/space-workspace/shared/dropzones/audio/input.txt", undefined);
    await expect(read({ path: "dropzones/private/input.txt" }, ctx)).rejects.toThrow("space_shared_filesystem_denied");
    await expect(write({ path: "dropzones/audio/output.txt", content: "x", expectedHash: null }, ctx)).rejects.toThrow("space_shared_filesystem_denied");
    expect(put).not.toHaveBeenCalled();
  });
});
