import { describe, expect, it } from "vitest";
import { readWorkspaceConflictPreview } from "./workspace-manual-resolution.js";
import { sha256Hex } from "./workspace-contract.js";

const scope = {
  tenantId: "tenant",
  spaceId: "space",
  projectId: "project",
  jurisdiction: "global" as const,
};

describe("workspace manual conflict previews", () => {
  it("reads integrity-checked text from current target and retained worker branches", async () => {
    const targetBytes = new TextEncoder().encode("target version\n");
    const workerBytes = new TextEncoder().encode("worker version\n");
    const targetHash = await sha256Hex(targetBytes);
    const workerHash = await sha256Hex(workerBytes);
    const objects = new Map([
      [
        `workspace-v1/tenant/space/project/global/content/${targetHash}`,
        targetBytes,
      ],
      [
        `workspace-v1/tenant/space/project/global/content/${workerHash}`,
        workerBytes,
      ],
    ]);
    const coordinator = async (path: string) => {
      const branch = new URL(`https://workspace${path}`).searchParams.get(
        "branch"
      );
      const hash = branch === "main" ? targetHash : workerHash;
      const objectKey = `workspace-v1/tenant/space/project/global/content/${hash}`;
      return Response.json({
        entries: [
          {
            path: "src/app.ts",
            sha256: hash,
            size: objects.get(objectKey)!.byteLength,
            objectKey,
            contentType: "text/typescript",
          },
        ],
      });
    };
    const preview = await readWorkspaceConflictPreview(
      {
        scope,
        targetBranch: "main",
        workerBranch: "workers/one",
        path: "src/app.ts",
        expectedTargetHash: targetHash,
        expectedSourceHash: workerHash,
      },
      coordinator,
      {
        async get(key) {
          const bytes = objects.get(key);
          return bytes
            ? {
                size: bytes.byteLength,
                async arrayBuffer() {
                  return bytes.slice().buffer;
                },
              }
            : null;
        },
      }
    );
    expect(preview).toMatchObject({
      stale: false,
      path: "src/app.ts",
      target: { hash: targetHash, content: "target version\n" },
      worker: { hash: workerHash, content: "worker version\n" },
    });
  });

  it("marks the preview stale when either branch moved after the conflict report", async () => {
    const bytes = new TextEncoder().encode("changed target\n");
    const currentHash = await sha256Hex(bytes);
    const key = `workspace-v1/tenant/space/project/global/content/${currentHash}`;
    const preview = await readWorkspaceConflictPreview(
      {
        scope,
        targetBranch: "main",
        workerBranch: "workers/one",
        path: "src/app.ts",
        expectedTargetHash: "a".repeat(64),
        expectedSourceHash: null,
      },
      async () =>
        Response.json({
          entries: [
            {
              path: "src/app.ts",
              sha256: currentHash,
              size: bytes.byteLength,
              objectKey: key,
              contentType: "text/plain",
            },
          ],
        }),
      {
        async get() {
          return {
            size: bytes.byteLength,
            async arrayBuffer() {
              return bytes.slice().buffer;
            },
          };
        },
      }
    );
    expect(preview.stale).toBe(true);
  });
});
