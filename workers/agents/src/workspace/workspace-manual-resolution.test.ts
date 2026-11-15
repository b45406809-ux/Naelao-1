import { describe, expect, it } from "vitest";
import {
  isWorkspaceManualConflictChangeSet,
  isWorkspaceManualCopySetWithinLimits,
  isWorkspaceManualResolutionChange,
  isWorkspaceManualValidationCommand,
  publishWorkspaceManualResolution,
  readWorkspaceConflictPreview,
} from "./workspace-manual-resolution.js";
import { sha256Hex } from "./workspace-contract.js";

const scope = {
  tenantId: "tenant",
  spaceId: "space",
  projectId: "project",
  jurisdiction: "global" as const,
};

describe("workspace manual conflict change sets", () => {
  it("requires an exact pair and removes the colliding path", () => {
    const hash = "a".repeat(64);
    const primary = { path: "Readme.md", expectedTargetHash: null, expectedSourceHash: hash, content: "reviewed\n" };
    const pairedDelete = { path: "README.md", expectedTargetHash: hash, expectedSourceHash: null, content: null };
    expect(isWorkspaceManualConflictChangeSet("Readme.md", "README.md", [primary, pairedDelete])).toBe(true);
    expect(isWorkspaceManualConflictChangeSet("Readme.md", "README.md", [primary, { ...pairedDelete, content: "still collides\n" }])).toBe(false);
    expect(isWorkspaceManualConflictChangeSet("Readme.md", "README.md", [{ ...primary, content: null }, pairedDelete])).toBe(false);
    expect(isWorkspaceManualConflictChangeSet("Readme.md", "README.md", [primary])).toBe(false);
    expect(isWorkspaceManualConflictChangeSet("Readme.md", undefined, [primary, pairedDelete])).toBe(false);
    expect(isWorkspaceManualConflictChangeSet("Readme.md", "../unsafe", [primary, pairedDelete])).toBe(false);
    const binaryCopy = { path: "README.md", expectedTargetHash: hash, expectedSourceHash: null, content: null, copyFrom: "target" as const };
    expect(isWorkspaceManualResolutionChange(binaryCopy)).toBe(true);
    expect(isWorkspaceManualConflictChangeSet("Readme.md", "README.md", [primary, binaryCopy])).toBe(false);
    expect(isWorkspaceManualResolutionChange({ ...binaryCopy, expectedTargetHash: null })).toBe(false);
    expect(isWorkspaceManualResolutionChange({ ...binaryCopy, content: "replacement" })).toBe(false);
  });

  it("bounds exact-copy bytes by both file and review-set totals", () => {
    const mib = 1024 * 1024;
    expect(isWorkspaceManualCopySetWithinLimits([2 * mib])).toBe(true);
    expect(isWorkspaceManualCopySetWithinLimits([mib, mib])).toBe(true);
    expect(isWorkspaceManualCopySetWithinLimits([mib, mib + 1])).toBe(false);
    expect(isWorkspaceManualCopySetWithinLimits([2 * mib + 1])).toBe(false);
    expect(isWorkspaceManualCopySetWithinLimits([mib, mib, 1])).toBe(false);
    expect(isWorkspaceManualCopySetWithinLimits([-1])).toBe(false);
    expect(isWorkspaceManualCopySetWithinLimits([Number.MAX_SAFE_INTEGER, 1])).toBe(false);
  });
});

describe("workspace manual large exact-copy resolution", () => {
  it("copies exactly the per-file and review-set ceiling through the checked Coordinator", async () => {
    const bytes = new Uint8Array(2 * 1024 * 1024);
    for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
    const hash = await sha256Hex(bytes);
    const objectKey = `workspace-v1/tenant/space/project/global/content/${hash}`;
    let checkpointChanges: Array<{ path: string; contentBase64: string | null }> | undefined;
    const coordinator = async (path: string, body?: Record<string, unknown>) => {
      if (path.startsWith("/v1/read?")) {
        const url = new URL(`https://workspace${path}`);
        const entry = url.searchParams.get("branch") === "main" && url.searchParams.get("path") === "assets/large.bin"
          ? [{ path: "assets/large.bin", sha256: hash, size: bytes.byteLength, objectKey, contentType: "application/octet-stream", executable: false }]
          : [];
        return Response.json({ entries: entry });
      }
      if (path === "/v1/branch") return Response.json({ branch: "manual/checked-copy" });
      if (path === "/v1/open") return Response.json({ session: { id: "ws_00000000-0000-4000-8000-000000000001", fence: 0 }, head: { revision: 0 } });
      if (path === "/v1/checkpoint") {
        checkpointChanges = body?.changes as typeof checkpointChanges;
        return Response.json({ publication: { status: "published", revision: 1 } });
      }
      if (path === "/v1/merge") return Response.json({ publication: { status: "published", revision: 2 } });
      if (path === "/v1/close") return Response.json({ closed: true });
      throw new Error(`unexpected coordinator route ${path}`);
    };
    const result = await publishWorkspaceManualResolution({ scope, actorId: "reviewer", workerId: "worker", attempt: 1,
      targetBranch: "main", sourceBranch: "workers/one", path: "assets/large.bin", expectedTargetHash: hash,
      expectedSourceHash: null, content: null, copyFrom: "target", idempotencyKey: "large-copy-at-limit",
      copyBucket: { async get(key) { return key === objectKey ? { size: bytes.byteLength, async arrayBuffer() { return bytes.slice().buffer; } } : null; } },
    }, coordinator);
    expect(result.merge.status).toBe("published");
    expect(checkpointChanges).toHaveLength(1);
    const encoded = checkpointChanges?.[0]?.contentBase64;
    expect(typeof encoded).toBe("string");
    const decoded = atob(encoded!);
    const copied = Uint8Array.from(decoded, value => value.charCodeAt(0));
    expect(copied.byteLength).toBe(bytes.byteLength);
    expect(await sha256Hex(copied)).toBe(hash);
  }, 15_000);
});

describe("workspace manual validation command", () => {
  it.each(["npm test", "pnpm test", "yarn test:unit", "bun run test -- --runInBand"]) (
    "accepts bounded package test command %s",
    (command) => {
      expect(isWorkspaceManualValidationCommand(command)).toBe(true);
    }
  );

  it.each([
    "npm install",
    "pnpm test; curl https://example.invalid",
    "npm test && rm -rf .",
    "pnpm test\nnode malicious.js",
    " pnpm test",
    `pnpm test -- ${"x".repeat(300)}`,
  ])("rejects unsafe or unbounded command %s", (command) => {
    expect(isWorkspaceManualValidationCommand(command)).toBe(false);
  });
});

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

  it("offers bounded verified binary versions for server-side exact-byte copying", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    const hash = await sha256Hex(bytes);
    const objectKey = `workspace-v1/tenant/space/project/global/content/${hash}`;
    const preview = await readWorkspaceConflictPreview({ scope, targetBranch: "main", workerBranch: "workers/one", path: "assets/icon.png",
      expectedTargetHash: hash, expectedSourceHash: null }, async route => {
      const branch = new URL(`https://workspace${route}`).searchParams.get("branch");
      return Response.json({ entries: branch === "main" ? [{ path: "assets/icon.png", sha256: hash, size: bytes.byteLength,
        objectKey, contentType: "image/png", executable: false }] : [] });
    }, { async get(key) { return key === objectKey ? { size: bytes.byteLength, async arrayBuffer() { return bytes.slice().buffer; } } : null; } });
    expect(preview.target).toEqual({ hash, content: null, unavailableReason: "unsupported_type", copyAllowed: true });
    expect(preview.worker).toMatchObject({ hash: null, content: null, unavailableReason: "missing" });
  });

  it("allows bounded large exact copies without rendering bytes and rejects over-limit or corrupt objects", async () => {
    const expectedHash = "a".repeat(64);
    let bucketReads = 0;
    const oversized = await readWorkspaceConflictPreview({ scope, targetBranch: "main", workerBranch: "workers/one", path: "assets/large.bin" },
      async route => Response.json({ entries: new URL(`https://workspace${route}`).searchParams.get("branch") === "main"
        ? [{ path: "assets/large.bin", sha256: expectedHash, size: 1024 * 1024,
            objectKey: `workspace-v1/tenant/space/project/global/content/${expectedHash}`, contentType: "application/octet-stream" }]
        : [] }),
      { async get() { bucketReads++; return null; } });
    expect(oversized.target).toMatchObject({ hash: expectedHash, content: null, unavailableReason: "size_limit" });
    expect(oversized.target.copyAllowed).toBe(true);
    expect(bucketReads).toBe(0);

    const tooLarge = await readWorkspaceConflictPreview({ scope, targetBranch: "main", workerBranch: "workers/one", path: "assets/too-large.bin" },
      async route => Response.json({ entries: new URL(`https://workspace${route}`).searchParams.get("branch") === "main"
        ? [{ path: "assets/too-large.bin", sha256: expectedHash, size: 2 * 1024 * 1024 + 1,
            objectKey: `workspace-v1/tenant/space/project/global/content/${expectedHash}`, contentType: "application/octet-stream" }]
        : [] }),
      { async get() { bucketReads++; return null; } });
    expect(tooLarge.target).toMatchObject({ hash: expectedHash, content: null, unavailableReason: "size_limit" });
    expect(tooLarge.target.copyAllowed).not.toBe(true);
    expect(bucketReads).toBe(0);

    const corruptBytes = new Uint8Array([1, 2, 3, 4]);
    const corruptHash = "b".repeat(64);
    const corruptKey = `workspace-v1/tenant/space/project/global/content/${corruptHash}`;
    const corrupted = await readWorkspaceConflictPreview({ scope, targetBranch: "main", workerBranch: "workers/one", path: "assets/corrupt.bin" },
      async route => Response.json({ entries: new URL(`https://workspace${route}`).searchParams.get("branch") === "main"
        ? [{ path: "assets/corrupt.bin", sha256: corruptHash, size: corruptBytes.byteLength, objectKey: corruptKey, contentType: "application/octet-stream" }]
        : [] }),
      { async get() { return { size: corruptBytes.byteLength, async arrayBuffer() { return corruptBytes.slice().buffer; } }; } });
    expect(corrupted.target).toMatchObject({ hash: corruptHash, content: null, unavailableReason: "invalid_text" });
    expect(corrupted.target.copyAllowed).not.toBe(true);
  });

  it("returns both paths for a case-collision preview", async () => {
    const versions = new Map<string, string>([
      ["main\0Readme.md", "target primary\n"],
      ["workers/one\0Readme.md", "worker primary\n"],
      ["main\0README.md", "target paired\n"],
      ["workers/one\0README.md", "worker paired\n"],
    ]);
    const objects = new Map<string, Uint8Array>();
    const entries = new Map<string, { path: string; sha256: string; size: number; objectKey: string; contentType: string }>();
    for (const [key, content] of versions) {
      const [branch, path] = key.split("\0") as [string, string];
      const bytes = new TextEncoder().encode(content);
      const hash = await sha256Hex(bytes);
      const objectKey = `workspace-v1/tenant/space/project/global/content/${hash}`;
      objects.set(objectKey, bytes);
      entries.set(key, { path, sha256: hash, size: bytes.byteLength, objectKey, contentType: "text/plain" });
    }
    const coordinator = async (route: string) => {
      const url = new URL(`https://workspace${route}`);
      const key = `${url.searchParams.get("branch")}\0${url.searchParams.get("path")}`;
      const entry = entries.get(key);
      return Response.json({ entries: entry ? [entry] : [] });
    };
    const bucket = { async get(key: string) {
      const bytes = objects.get(key);
      return bytes ? { size: bytes.byteLength, async arrayBuffer() { return bytes.slice().buffer; } } : null;
    } };
    const preview = await readWorkspaceConflictPreview({ scope, targetBranch: "main", workerBranch: "workers/one", path: "Readme.md",
      pairedPath: "README.md", expectedTargetHash: await sha256Hex(new TextEncoder().encode(versions.get("main\0Readme.md")!)),
      expectedSourceHash: await sha256Hex(new TextEncoder().encode(versions.get("workers/one\0Readme.md")!)) }, coordinator, bucket);
    expect(preview.stale).toBe(false);
    expect(preview.paired).toMatchObject({ path: "README.md", target: { content: "target paired\n" }, worker: { content: "worker paired\n" } });
  });
});
