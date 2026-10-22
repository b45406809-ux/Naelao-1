import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  childEnvironmentWithoutProviderSecrets,
  parseGeneratedPatchPaths,
  readBoundedResponseText,
  resolveRepoOutputPath,
} from "../../infra/scripts/phase-runner-safety.mjs";

const tempDirs: string[] = [];

function makeRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), "naelao-phase-runner-"));
  tempDirs.push(root);
  mkdirSync(path.join(root, "src"));
  return root;
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("phase runner generated paths", () => {
  it("accepts a relative path contained by the repository", () => {
    const root = makeRoot();
    expect(resolveRepoOutputPath("src/new.ts", root)).toBe(path.join(root, "src/new.ts"));
  });

  it.each(["../outside.ts", "/tmp/outside.ts", "", "."]) (
    "rejects unsafe path %s",
    (candidate) => {
      const root = makeRoot();
      expect(() => resolveRepoOutputPath(candidate, root)).toThrow();
    }
  );

  it("rejects an existing symlink that points outside the repository", () => {
    const root = makeRoot();
    const outside = mkdtempSync(path.join(os.tmpdir(), "naelao-outside-"));
    tempDirs.push(outside);
    symlinkSync(outside, path.join(root, "escape"), "dir");
    expect(() => resolveRepoOutputPath("escape/new.ts", root)).toThrow(/symlink/);
  });
});

describe("phase runner child process environment", () => {
  it("removes provider secrets before package scripts or repository tools run", () => {
    const source = {
      GEMINI_API_KEYS: "gemini-secret",
      GROQ_API_KEYS: "groq-secret",
      OPENROUTER_API_KEY: "openrouter-secret",
      PATH: "/usr/bin",
    };

    expect(childEnvironmentWithoutProviderSecrets(source)).toEqual({ PATH: "/usr/bin" });
    expect(source.GEMINI_API_KEYS).toBe("gemini-secret");
  });
});

describe("phase runner provider response limits", () => {
  it("reads a complete response within the byte ceiling", async () => {
    await expect(readBoundedResponseText(new Response("ok"), 2)).resolves.toBe("ok");
  });

  it("cancels a streamed response that exceeds the byte ceiling", async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(4));
        },
        cancel() {
          cancelled = true;
        },
      })
    );

    await expect(readBoundedResponseText(response, 3)).rejects.toThrow("exceeded byte limit");
    expect(cancelled).toBe(true);
  });
});

describe("phase runner startup", () => {
  it("resolves its repository root before validating CLI arguments", () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const result = spawnSync(process.execPath, ["run-phase.mjs", "--start", "0", "--end", "1"], {
      cwd: root,
      encoding: "utf8",
      timeout: 5_000,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--start and --end must select an inclusive range");
    expect(result.stderr).not.toContain("realpathSync is not defined");
  });

  it("rejects unbounded retry counts and shell metacharacters in model names", () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const badTurns = spawnSync(process.execPath, ["run-phase.mjs"], {
      cwd: root,
      encoding: "utf8",
      timeout: 5_000,
      env: { ...process.env, PHASE_START: "1", PHASE_END: "1", MAX_TURNS_PER_PHASE: "1000000" },
    });
    expect(badTurns.stderr).toContain("--max-turns must be an integer between 1 and 16");

    const badModel = spawnSync(process.execPath, ["run-phase.mjs"], {
      cwd: root,
      encoding: "utf8",
      timeout: 5_000,
      env: {
        ...process.env,
        PHASE_START: "1",
        PHASE_END: "1",
        MAX_TURNS_PER_PHASE: "2",
        AI_MODELS: "gemini-flash;touch${IFS}/tmp/should-not-run",
        GEMINI_API_KEYS: "test-only-placeholder",
      },
    });
    expect(badModel.stderr).toContain("Model names may contain only letters");
  });

  it("caps key and model rotations before any provider request", () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const tooManyKeys = spawnSync(process.execPath, ["run-phase.mjs"], {
      cwd: root,
      encoding: "utf8",
      timeout: 5_000,
      env: {
        ...process.env,
        PHASE_START: "1",
        PHASE_END: "1",
        GEMINI_API_KEYS: Array.from({ length: 9 }, (_, index) => `key-${index}`).join(","),
      },
    });
    expect(tooManyKeys.stderr).toContain("At most 8 Gemini API keys");

    const tooManyModels = spawnSync(process.execPath, ["run-phase.mjs"], {
      cwd: root,
      encoding: "utf8",
      timeout: 5_000,
      env: {
        ...process.env,
        PHASE_START: "1",
        PHASE_END: "1",
        GEMINI_API_KEYS: "test-only-placeholder",
        AI_MODELS: Array.from({ length: 9 }, (_, index) => `gemini-${index}`).join(","),
      },
    });
    expect(tooManyModels.stderr).toContain("At most 8 Gemini models");
  });
});

describe("phase runner patch paths", () => {
  it("collects paths from ordinary and quoted diffs", () => {
    const root = makeRoot();
    mkdirSync(path.join(root, "folder with spaces"));
    const patch = [
      "diff --git a/src/new.ts b/src/new.ts",
      "diff --git \"a/folder with spaces/file name.ts\" \"b/folder with spaces/file name.ts\"",
    ].join("\n");
    expect(parseGeneratedPatchPaths(patch, root)).toEqual([
      "src/new.ts",
      "folder with spaces/file name.ts",
    ]);
  });

  it.each([
    "diff --git a/../outside.ts b/../outside.ts",
    "diff --git a/.git/config b/.git/config",
    "diff --git a/old.ts b/new.ts",
    "no diff headers",
  ])("rejects unsafe patch header %s", (patch) => {
    expect(() => parseGeneratedPatchPaths(patch, makeRoot())).toThrow();
  });
});
