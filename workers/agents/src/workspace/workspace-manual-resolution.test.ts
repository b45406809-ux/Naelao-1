import { describe, expect, it } from "vitest";
import {
  isWorkspaceManualConflictChangeSet,
  isWorkspaceManualValidationCommand,
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
    expect(isWorkspaceManualConflictChangeSet("Readme.md", "README.md", [primary])).toBe(false);
    expect(isWorkspaceManualConflictChangeSet("Readme.md", undefined, [primary, pairedDelete])).toBe(false);
    expect(isWorkspaceManualConflictChangeSet("Readme.md", "../unsafe", [primary, pairedDelete])).toBe(false);
  });
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
