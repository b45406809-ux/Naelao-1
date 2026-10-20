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
