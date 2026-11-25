import { describe, expect, it } from "vitest";
import { classifyWorkerOutputConflicts, type WorkerOutput } from "./worker-output-conflicts.js";
import { projectWorkerOutputConflictCandidates } from "./goal-decision-change-candidates.js";

const w = (worker_id: string, changed_paths: string[], diff_text?: string): WorkerOutput =>
  ({ worker_id, changed_paths, ...(diff_text === undefined ? {} : { diff_text }) });
const classes = (outputs: WorkerOutput[]) => classifyWorkerOutputConflicts(outputs).map(c => c.class);

describe("classifyWorkerOutputConflicts", () => {
  it("raises same_path", () => {
    const out = classifyWorkerOutputConflicts([w("a", ["docs/x.md"]), w("b", ["docs/x.md"])]);
    expect(out).toEqual([{ class: "same_path", paths: ["docs/x.md"], worker_ids: ["a", "b"], status: "candidate", trusted: false }]);
  });
  it("raises migration for files under migrations/ and for MIGRATIONS array edits", () => {
    expect(classes([w("a", ["db/migrations/001.sql"]), w("b", ["db/migrations/002.sql"])])).toEqual(["migration"]);
    const arr = classifyWorkerOutputConflicts([w("a", ["x/A.ts"], "+  MIGRATIONS.push(1)"), w("b", ["y/B.ts"], "+const MIGRATIONS = []")]);
    expect(arr.map(c => c.class)).toEqual(["migration"]);
    expect(classes([w("a", ["db/migrations/001.sql"]), w("b", ["src/b.ts"], "+x")])).toEqual([]);
  });
  it("raises dependency_manifest", () => {
    const out = classifyWorkerOutputConflicts([w("a", ["apps/a/package.json"]), w("b", ["wrangler.toml"])]);
    expect(out).toEqual([{ class: "dependency_manifest", paths: ["apps/a/package.json", "wrangler.toml"], worker_ids: ["a", "b"], status: "candidate", trusted: false }]);
    expect(classes([w("a", ["pnpm-lock.yaml"]), w("b", ["pnpm-lock.yaml"])])).toEqual(["same_path", "dependency_manifest"]);
  });
  it("raises exported_interface from +export/-export lines in the same module", () => {
    const out = classifyWorkerOutputConflicts([w("a", ["src/m.ts"], "+export const a = 1"), w("b", ["src/m.ts"], "-export function f() {}")]);
    expect(out.map(c => c.class)).toEqual(["same_path", "exported_interface"]);
    expect(out[1]).toMatchObject({ paths: ["src/m.ts"], worker_ids: ["a", "b"] });
    expect(classes([w("a", ["src/m.ts"], "+const a = 1"), w("b", ["src/m.ts"], "+export const b = 1")])).toEqual(["same_path"]);
  });
  it("raises unknown when diff_text is missing for a shared source path", () => {
    const out = classifyWorkerOutputConflicts([w("a", ["src/m.ts"]), w("b", ["src/m.ts"], "+export const b = 1")]);
    expect(out.map(c => c.class)).toEqual(["same_path", "unknown"]);
    expect(classes([w("a", ["notes.md"]), w("b", ["notes.md"])])).toEqual(["same_path"]);
  });
  it("is empty for disjoint workers", () => {
    expect(classifyWorkerOutputConflicts([w("a", ["src/a.ts"], "+export const a = 1"), w("b", ["src/b.ts"])])).toEqual([]);
    expect(classifyWorkerOutputConflicts([])).toEqual([]);
  });
  it("always marks results untrusted candidates and is order independent", () => {
    const inputs = [w("c", ["src/m.ts", "package.json"], "+export x"), w("a", ["src/m.ts", "db/migrations/1.sql"]),
      w("b", ["package.json", "db/migrations/2.sql", "src/m.ts"], "-export y")];
    const base = classifyWorkerOutputConflicts(inputs);
    expect(base.length).toBeGreaterThan(3);
    for (const c of base) expect(c).toMatchObject({ status: "candidate", trusted: false });
    for (const perm of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
      const shuffled = perm.map(i => inputs[i]!).map(o => ({ ...o, changed_paths: [...o.changed_paths].reverse() }));
      expect(classifyWorkerOutputConflicts(shuffled)).toEqual(base);
    }
  });
});

describe("projectWorkerOutputConflictCandidates", () => {
  const ref = { id: "d", revision: 1 };
  const done = (id: string, files: string[]) => ({ status: "completed" as const, workerId: `w-${id}`,
    result: { id, ok: true as const, output: { modifiedFiles: files } } });
  it("projects classes per decision revision with unknown for missing diffs", () => {
    const out = projectWorkerOutputConflictCandidates(
      [{ id: "a", decision_refs: [ref] }, { id: "b", decision_refs: [ref] }, { id: "c", decision_refs: [{ id: "d", revision: 2 }] }],
      { tasks: { a: done("a", ["src/m.ts"]), b: done("b", ["src/m.ts"]), c: done("c", ["src/m.ts"]) } } as never);
    expect(out).toHaveLength(1);
    expect(out[0]!.candidates.map(c => c.class)).toEqual(["same_path", "unknown"]);
  });
  it("is empty for disjoint workers", () => {
    expect(projectWorkerOutputConflictCandidates(
      [{ id: "a", decision_refs: [ref] }, { id: "b", decision_refs: [ref] }],
      { tasks: { a: done("a", ["src/a.ts"]), b: done("b", ["src/b.ts"]) } } as never)).toEqual([]);
  });
});
