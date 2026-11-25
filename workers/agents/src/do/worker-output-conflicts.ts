export interface WorkerOutput { worker_id: string; changed_paths: readonly string[]; diff_text?: string }

export type WorkerOutputConflictClass = "same_path" | "migration" | "dependency_manifest" | "exported_interface" | "unknown";

export interface WorkerOutputConflictCandidate {
  class: WorkerOutputConflictClass;
  paths: string[];
  worker_ids: string[];
  status: "candidate";
  trusted: false;
}

const CLASS_ORDER: WorkerOutputConflictClass[] = ["same_path", "migration", "dependency_manifest", "exported_interface", "unknown"];
const MANIFESTS = new Set(["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "wrangler.toml"]);
const SOURCE_EXT = /\.(?:[cm]?[jt]s|[jt]sx)$/;

const byCode = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const isMigrationPath = (path: string) => /(^|\/)migrations\//.test(path);
const isManifest = (path: string) => MANIFESTS.has(baseName(path));
const hasExportLine = (diff: string) => /^[+-]export\b/m.test(diff);

/**
 * Pure, deterministic conflict classes for workers completed under one decision revision. Every
 * result is an untrusted review candidate: no model call, no confirmation, no publication gate.
 * `exported_interface` and `MIGRATIONS` array evidence need `diff_text`; a source path shared by
 * workers where any lacks it is reported as `unknown` instead of being guessed.
 */
export function classifyWorkerOutputConflicts(outputs: readonly WorkerOutput[]): WorkerOutputConflictCandidate[] {
  const workers = new Map<string, { paths: Set<string>; diffs: string[] | null }>();
  for (const output of outputs) {
    const entry = workers.get(output.worker_id) ?? { paths: new Set<string>(), diffs: null };
    for (const path of output.changed_paths) entry.paths.add(path);
    if (typeof output.diff_text === "string") (entry.diffs ??= []).push(output.diff_text);
    workers.set(output.worker_id, entry);
  }
  const ids = [...workers.keys()].sort(byCode);
  const diffOf = (id: string) => workers.get(id)!.diffs?.slice().sort(byCode).join("\n") ?? null;
  const byPath = new Map<string, string[]>();
  for (const id of ids) for (const path of workers.get(id)!.paths) byPath.set(path, [...(byPath.get(path) ?? []), id]);
  const found = new Map<WorkerOutputConflictClass, { paths: Set<string>; workers: Set<string> }>();
  const raise = (cls: WorkerOutputConflictClass, path: string, who: readonly string[]) => {
    const entry = found.get(cls) ?? { paths: new Set<string>(), workers: new Set<string>() };
    entry.paths.add(path);
    for (const id of who) entry.workers.add(id);
    found.set(cls, entry);
  };
  const raiseWhenShared = (cls: WorkerOutputConflictClass, hits: Map<string, Set<string>>) => {
    const all = new Set([...hits.values()].flatMap(set => [...set]));
    if (all.size < 2) return;
    for (const path of hits.keys()) raise(cls, path, [...all]);
  };

  for (const [path, who] of byPath) if (who.length >= 2) raise("same_path", path, who);

  const migrationHits = new Map<string, Set<string>>();
  const manifestHits = new Map<string, Set<string>>();
  for (const [path, who] of byPath) {
    for (const id of who) {
      const hit = (map: Map<string, Set<string>>) => map.set(path, (map.get(path) ?? new Set<string>()).add(id));
      if (isMigrationPath(path) || /\bMIGRATIONS\b/.test(diffOf(id) ?? "")) hit(migrationHits);
      if (isManifest(path)) hit(manifestHits);
    }
  }
  raiseWhenShared("migration", migrationHits);
  raiseWhenShared("dependency_manifest", manifestHits);

  for (const [path, who] of byPath) {
    if (who.length < 2) continue;
    const exporters = who.filter(id => hasExportLine(diffOf(id) ?? ""));
    if (exporters.length >= 2) raise("exported_interface", path, exporters);
    if (SOURCE_EXT.test(path) && who.some(id => diffOf(id) === null)) raise("unknown", path, who);
  }

  return CLASS_ORDER.flatMap(cls => {
    const entry = found.get(cls);
    return entry ? [{ class: cls, paths: [...entry.paths].sort(byCode), worker_ids: [...entry.workers].sort(byCode),
      status: "candidate" as const, trusted: false as const }] : [];
  });
}
