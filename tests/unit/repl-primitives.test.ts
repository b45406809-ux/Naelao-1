// AVOS plan, step 1 — the Claude-Code-shaped REPL primitives (Read/Edit/Write/Grep/Glob on
// r2-workspace.ts, Bash on code-exec.ts) and their aliasing/gating. Covers two real bugs found
// and fixed while porting the plan's Gemini-generated diff, not just the happy path:
//   - the naive glob-to-regex translation corrupted `**` (cross-any-depth) into a single path
//     segment, because replacing `*` -> `[^/]*` AFTER `**` -> `.*` re-matches the `*` inside the
//     just-inserted `.*`.
//   - a failed Bash command must still resolve to ok:false at the ScriptToolSurface level — the
//     harness has to THROW, not return a normally-shaped failure object, or runTier()'s outer
//     `if (!result.ok) throw` never fires and the loop reads a genuine failure as a success.

import { describe, it, expect } from "vitest";
import { r2Workspace } from "../../workers/agents/src/script-engine/prebuilt/r2-workspace.js";
import { codeExec } from "../../workers/agents/src/script-engine/prebuilt/code-exec.js";
import { ScriptToolSurface } from "../../workers/agents/src/script-engine/tool-surface.js";
import { isReadSafeOperation } from "../../workers/agents/src/script-engine/assistant-access.js";
import { LAUNCHPAD_ASSISTANT_DEFAULT_AUTO_APPROVED } from "../../workers/agents/src/script-engine/profiles.js";
import type { PrebuiltOpContext } from "../../workers/agents/src/script-engine/prebuilt/index.js";
import type { ScriptEngineEnv } from "../../workers/agents/src/script-engine/types.js";

/** A fuller in-memory R2 fake than the size-guard test's own — this one actually supports
 *  prefix-scoped list(), which Grep/Glob need. */
function makeR2(initial: Record<string, string> = {}): R2Bucket {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    async put(key: string, value: unknown) {
      store.set(key, String(value));
      return {} as R2Object;
    },
    async get(key: string, opts?: { range?: { offset: number; length: number } }) {
      if (!store.has(key)) return null;
      const full = store.get(key)!;
      if (opts?.range) {
        const { offset, length } = opts.range;
        const slice = full.slice(offset, offset + length);
        return { size: full.length, uploaded: new Date("2026-01-01T00:00:00Z"), async text() { return slice; } } as unknown as R2ObjectBody;
      }
      return { size: full.length, uploaded: new Date("2026-01-01T00:00:00Z"), async text() { return full; } } as unknown as R2ObjectBody;
    },
    async head(key: string) {
      if (!store.has(key)) return null;
      const full = store.get(key)!;
      return { size: full.length, uploaded: new Date("2026-01-01T00:00:00Z") } as unknown as R2Object;
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list(opts?: { prefix?: string }) {
      const prefix = opts?.prefix ?? "";
      const objects = [...store.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((k) => ({ key: k, size: store.get(k)!.length, uploaded: new Date("2026-01-01T00:00:00Z") }));
      return { objects, truncated: false } as unknown as R2Objects;
    },
  } as unknown as R2Bucket;
}

function makeCtx(bucket: R2Bucket, extra: Partial<ScriptEngineEnv> = {}): PrebuiltOpContext {
  const env = {
    spaceId: "space-1",
    agentId: "agent-1",
    tenantId: "tenant-1",
    scriptsBucket: bucket,
    ...extra,
  } as unknown as ScriptEngineEnv;
  return { env, run: async () => ({}) };
}

const Read = r2Workspace.operations["Read"]!;
const Edit = r2Workspace.operations["Edit"]!;
const Write = r2Workspace.operations["Write"]!;
const Grep = r2Workspace.operations["Grep"]!;
const Glob = r2Workspace.operations["Glob"]!;

describe("Read — line-windowed view", () => {
  it("returns line-numbered content for a small file", async () => {
    const ctx = makeCtx(makeR2({ "spaces/space-1/workspace/a.ts": "const x = 1;\nconst y = 2;\n" }));
    const result = (await Read({ path: "a.ts" }, ctx)) as { exists: boolean; content: string; lines_total: number };
    expect(result.exists).toBe(true);
    expect(result.content).toContain("1 | const x = 1;");
    expect(result.content).toContain("2 | const y = 2;");
    expect(result.lines_total).toBe(3); // trailing newline -> a trailing empty "line"
  });

  it("windows by offset/limit and reports has_more", async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
    const ctx = makeCtx(makeR2({ "spaces/space-1/workspace/many.txt": lines }));
    const result = (await Read({ path: "many.txt", offset: 3, limit: 2 }, ctx)) as {
      content: string; has_more: boolean; offset: number; limit: number;
    };
    expect(result.content).toBe("3 | line 3\n4 | line 4");
    expect(result.has_more).toBe(true);
    expect(result.offset).toBe(3);
  });

  it("reports exists:false for a missing file", async () => {
    const ctx = makeCtx(makeR2({}));
    const result = (await Read({ path: "nope.ts" }, ctx)) as { exists: boolean };
    expect(result.exists).toBe(false);
  });

  it("refuses a file over the search size limit rather than loading it whole", async () => {
    const huge = "x".repeat(5_000_001);
    const ctx = makeCtx(makeR2({ "spaces/space-1/workspace/huge.log": huge }));
    const result = (await Read({ path: "huge.log" }, ctx)) as { too_large: boolean; size: number };
    expect(result.too_large).toBe(true);
    expect(result.size).toBe(5_000_001);
  });
});

describe("Edit — surgical exact-text replace", () => {
  it("replaces a unique occurrence", async () => {
    const ctx = makeCtx(makeR2({ "spaces/space-1/workspace/a.ts": "const x = 1;\nconst y = 2;\n" }));
    const result = (await Edit({ path: "a.ts", oldString: "const x = 1;", newString: "const x = 42;" }, ctx)) as {
      ok: boolean; replacements: number;
    };
    expect(result.ok).toBe(true);
    expect(result.replacements).toBe(1);
    const after = (await Read({ path: "a.ts" }, ctx)) as { content: string };
    expect(after.content).toContain("const x = 42;");
  });

  it("refuses with a nearby-line hint when oldString isn't found verbatim", async () => {
    // A 2-line oldString where one line is right (matches a real file line verbatim) and one is
    // wrong (the model guessed the return value) — the hint scan matches on the CORRECT line.
    const ctx = makeCtx(makeR2({ "spaces/space-1/workspace/a.ts": "function foo() {\n  return 1;\n}\n" }));
    const result = (await Edit(
      { path: "a.ts", oldString: "function foo() {\n  return 2;\n}", newString: "x" },
      ctx
    )) as { ok: boolean; error: string; hint: string };
    expect(result.ok).toBe(false);
    expect(result.error).toBe("target_string_not_found");
    expect(result.hint).toMatch(/line 1/);
  });

  it("refuses an ambiguous (multi-occurrence) match rather than guessing", async () => {
    const ctx = makeCtx(makeR2({ "spaces/space-1/workspace/a.ts": "foo();\nfoo();\n" }));
    const result = (await Edit({ path: "a.ts", oldString: "foo();", newString: "bar();" }, ctx)) as {
      ok: boolean; error: string;
    };
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/matched 2 times/);
  });

  it("reports file-not-found without touching anything", async () => {
    const ctx = makeCtx(makeR2({}));
    const result = (await Edit({ path: "nope.ts", oldString: "x", newString: "y" }, ctx)) as { ok: boolean };
    expect(result.ok).toBe(false);
  });
});

describe("Write — same store as write_file", () => {
  it("writes and reads back through Read", async () => {
    const ctx = makeCtx(makeR2({}));
    const result = (await Write({ path: "new.txt", content: "hello" }, ctx)) as { ok: boolean; path: string };
    expect(result.ok).toBe(true);
    const read = (await Read({ path: "new.txt" }, ctx)) as { content: string };
    expect(read.content).toBe("1 | hello");
  });

  it("fires onWorkspaceChange like write_file does", async () => {
    const events: Array<{ path: string; operation: string }> = [];
    const ctx = makeCtx(makeR2({}), { onWorkspaceChange: (e) => events.push(e) });
    await Write({ path: "a.txt", content: "x" }, ctx);
    expect(events).toEqual([{ path: "a.txt", operation: "write" }]);
  });
});

describe("Grep — regex search across the whole workspace, not one file", () => {
  it("finds matches across multiple files under the prefix", async () => {
    const ctx = makeCtx(
      makeR2({
        "spaces/space-1/workspace/a.ts": "export function foo() {}\n",
        "spaces/space-1/workspace/b.ts": "export function bar() {}\n",
        "spaces/space-1/workspace/c.ts": "const x = 1;\n",
      })
    );
    const result = (await Grep({ pattern: "export function" }, ctx)) as {
      total_matches: number; matches: Array<{ file: string; line_number: number }>;
    };
    expect(result.total_matches).toBe(2);
    expect(result.matches.map((m) => m.file).sort()).toEqual(["a.ts", "b.ts"]);
  });

  it("rejects an invalid regex rather than throwing an opaque error", async () => {
    const ctx = makeCtx(makeR2({}));
    await expect(Grep({ pattern: "(unclosed" }, ctx)).rejects.toThrow(/not a valid regular expression/);
  });

  it("scopes to a path prefix when given one", async () => {
    const ctx = makeCtx(
      makeR2({
        "spaces/space-1/workspace/src/a.ts": "TODO: fix this\n",
        "spaces/space-1/workspace/docs/readme.md": "TODO: write docs\n",
      })
    );
    const result = (await Grep({ pattern: "TODO", path: "src" }, ctx)) as { total_matches: number };
    expect(result.total_matches).toBe(1);
  });
});

describe("Glob — pattern-based listing, ** must cross directory depth", () => {
  it("** matches files nested more than one directory deep (the bug this port fixed)", async () => {
    const ctx = makeCtx(
      makeR2({
        "spaces/space-1/workspace/a/b/c/file.ts": "x",
        "spaces/space-1/workspace/top.ts": "x",
        "spaces/space-1/workspace/a/b/c/file.md": "x",
      })
    );
    const result = (await Glob({ pattern: "**/*.ts" }, ctx)) as { files: string[]; count: number };
    // A naive glob->regex port (replace ** then *, in that order, without token-isolation) turns
    // "**/*.ts" into a regex requiring EXACTLY one path segment before the filename — which would
    // make this assert count===1 (only top.ts) instead of 2. This is the actual regression guard.
    expect(result.files.sort()).toEqual(["a/b/c/file.ts", "top.ts"]);
    expect(result.count).toBe(2);
  });

  it("omitting pattern (or '*'/'**') lists everything under the prefix", async () => {
    const ctx = makeCtx(makeR2({ "spaces/space-1/workspace/a.txt": "x", "spaces/space-1/workspace/b.txt": "x" }));
    const result = (await Glob({}, ctx)) as { files: string[] };
    expect(result.files.sort()).toEqual(["a.txt", "b.txt"]);
  });
});

describe("Bash — a failed command must resolve to ok:false, not a swallowed success", () => {
  it("throws a real error when the container run itself fails, matching runTier's ok:false contract", async () => {
    // codeRunner.run() failing (result.ok === false) is what stands in here for "the command
    // failed inside the container" — runTier's own `if (!result.ok) throw` is the exact line
    // that must still fire; the harness source string itself only runs INSIDE a real container,
    // which this unit test correctly doesn't spin up. What's under test is that code-exec.ts's
    // outer TypeScript wrapper still throws on a failed run rather than returning a
    // failure-shaped object that would read as ok:true one layer up.
    const ctx = makeCtx(makeR2({}), {
      codeRunner: {
        async run() {
          return { ok: false, error: "Command failed with exit code 1:\nsome stderr", tier: 5, duration_ms: 1, tokens_used: 0 };
        },
      },
    } as unknown as Partial<ScriptEngineEnv>);
    const bash = codeExec.operations["Bash"]!;
    await expect(bash({ commands: "false" }, ctx)).rejects.toThrow(/exit code 1/);
  });

  it("returns the runner's output unchanged on success", async () => {
    const ctx = makeCtx(makeR2({}), {
      codeRunner: {
        async run() {
          return { ok: true, output: { exit_code: 0, stdout: "hi" }, tier: 5, duration_ms: 1, tokens_used: 0 };
        },
      },
    } as unknown as Partial<ScriptEngineEnv>);
    const bash = codeExec.operations["Bash"]!;
    const result = await bash({ commands: "echo hi" }, ctx);
    expect(result).toEqual({ exit_code: 0, stdout: "hi" });
  });

  it("code.execute_bash and Bash are the same operation (aliased, not duplicated)", () => {
    expect(codeExec.operations["Bash"]).toBeTypeOf("function");
    expect(codeExec.operations["code.execute_bash"]).toBeTypeOf("function");
  });
});

describe("RENAMED_OPERATIONS aliasing — lowercase spellings resolve to the real PascalCase op", () => {
  function makeSurface(): ScriptToolSurface {
    const env = {
      spaceId: "space-1",
      agentId: "agent-1",
      tenantId: "tenant-1",
      scriptsBucket: makeR2({}),
    } as unknown as ScriptEngineEnv;
    return new ScriptToolSurface(env, ["r2-workspace", "code-exec"]);
  }

  it.each([
    ["read", "Read"],
    ["edit", "Edit"],
    ["write", "Write"],
    ["grep", "Grep"],
    ["glob", "Glob"],
    ["bash", "Bash"],
    ["execute_bash", "Bash"],
    ["patch_file", "Edit"],
  ])("resolves '%s' to '%s'", (alias, real) => {
    const surface = makeSurface();
    const resolved = surface.resolveOperationAlias(alias, {});
    expect(resolved.name).toBe(real);
  });
});

describe("gating — reads are safe/auto-approved, writes/exec stay gated", () => {
  it("Read/Grep/Glob/search_file are read-safe under the F-36 viewer clamp", () => {
    expect(isReadSafeOperation("Read")).toBe(true);
    expect(isReadSafeOperation("Grep")).toBe(true);
    expect(isReadSafeOperation("Glob")).toBe(true);
    expect(isReadSafeOperation("search_file")).toBe(true);
  });

  it("Edit/Write/Bash are NOT read-safe", () => {
    expect(isReadSafeOperation("Edit")).toBe(false);
    expect(isReadSafeOperation("Write")).toBe(false);
    expect(isReadSafeOperation("Bash")).toBe(false);
  });

  it("Read/Grep/Glob are in the guided-mode default auto-approved list; Edit/Write/Bash are not", () => {
    expect(LAUNCHPAD_ASSISTANT_DEFAULT_AUTO_APPROVED).toContain("Read");
    expect(LAUNCHPAD_ASSISTANT_DEFAULT_AUTO_APPROVED).toContain("Grep");
    expect(LAUNCHPAD_ASSISTANT_DEFAULT_AUTO_APPROVED).toContain("Glob");
    expect(LAUNCHPAD_ASSISTANT_DEFAULT_AUTO_APPROVED).not.toContain("Edit");
    expect(LAUNCHPAD_ASSISTANT_DEFAULT_AUTO_APPROVED).not.toContain("Write");
    expect(LAUNCHPAD_ASSISTANT_DEFAULT_AUTO_APPROVED).not.toContain("Bash");
  });
});
