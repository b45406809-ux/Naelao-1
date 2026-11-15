/**
 * Conservative, deterministic text merge candidate for checked workspace publication.
 * This never publishes changes itself. Callers still enforce scope, heads, hashes and fences.
 */
export const THREE_WAY_TEXT_MERGE_ALGORITHM = "bounded-lcs-lines-v1" as const;
export const THREE_WAY_TEXT_MERGE_MAX_BYTES = 256 * 1024;

export type ThreeWayTextMergeResult =
  | {
      status: "merged";
      content: Uint8Array;
      algorithm: typeof THREE_WAY_TEXT_MERGE_ALGORITHM;
    }
  | {
      status: "conflict";
      reason:
        | "size_limit"
        | "invalid_utf8"
        | "binary_content"
        | "line_limit"
        | "edit_overlap";
    };

export type WorkspacePathCollision = {
  firstPath: string;
  secondPath: string;
  reason: "case_collision" | "file_directory_collision";
};

interface Edit {
  start: number;
  end: number;
  replacement: string[];
}

const MAX_LINES = 2048;
const MAX_LCS_CELLS = 1_000_000;

/** Shared manifests, generated output and migrations need an explicit integrator policy. */
export function isAutomaticTextMergePath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  const segments = normalized.split("/");
  const basename = segments.at(-1) ?? "";
  if (
    segments.some((segment) =>
      [
        "node_modules",
        ".git",
        "dist",
        "build",
        "generated",
        "vendor",
        "coverage",
        ".next",
        ".turbo",
        ".github",
        ".devcontainer",
        "config",
        "configs",
      ].includes(segment)
    )
  )
    return false;
  if (
    segments.some(
      (segment) => segment === "migration" || segment === "migrations"
    )
  )
    return false;
  if (
    /\.generated\.[a-z0-9]+$/.test(basename) ||
    /\.config\.[a-z0-9]+$/.test(basename) ||
    /^tsconfig(?:\.[a-z0-9_-]+)?\.jsonc?$/.test(basename)
  )
    return false;
  if (basename.startsWith(".env") || basename.endsWith(".env")) return false;
  if (
    [
      "package.json",
      "pnpm-lock.yaml",
      "package-lock.json",
      "yarn.lock",
      "bun.lock",
      "bun.lockb",
      "pnpm-workspace.yaml",
      "workspace.yaml",
      "cargo.toml",
      "cargo.lock",
      "go.mod",
      "go.sum",
      "pyproject.toml",
      "poetry.lock",
      "requirements.txt",
      "pipfile",
      "pipfile.lock",
      "gemfile",
      "gemfile.lock",
      "composer.json",
      "composer.lock",
      "deno.json",
      "deno.jsonc",
      "wrangler.toml",
      "wrangler.json",
      "wrangler.jsonc",
      "turbo.json",
      "biome.json",
      "biome.jsonc",
      "dockerfile",
      "makefile",
      "justfile",
      "procfile",
      ".gitignore",
      ".npmrc",
      ".nvmrc",
      ".node-version",
      ".tool-versions",
    ].includes(basename)
  )
    return false;
  if (/(^|[.-])lock([.-]|$)/.test(basename)) return false;
  return true;
}

/** Detect path aliases that cannot be represented safely on common case-insensitive filesystems. */
export function findWorkspacePathCollisions(
  paths: readonly string[]
): WorkspacePathCollision[] {
  const unique = [...new Set(paths)].sort(compareText);
  const exactPaths = new Set(unique);
  const canonicalPrefixes = new Map<
    string,
    { exactPrefix: string; path: string }
  >();
  const collisions: WorkspacePathCollision[] = [];
  const seen = new Set<string>();
  const add = (collision: WorkspacePathCollision) => {
    const key = `${collision.reason}\0${collision.firstPath}\0${collision.secondPath}`;
    if (!seen.has(key) && collisions.length < 100) {
      seen.add(key);
      collisions.push(collision);
    }
  };

  for (const path of unique) {
    const segments = path.split("/");
    for (let index = 0; index < segments.length; index++) {
      const exactPrefix = segments.slice(0, index + 1).join("/");
      const canonicalPrefix = segments
        .slice(0, index + 1)
        .map((segment) => segment.normalize("NFC").toLowerCase())
        .join("/");
      const prior = canonicalPrefixes.get(canonicalPrefix);
      if (prior && prior.exactPrefix !== exactPrefix) {
        add({
          firstPath: prior.path,
          secondPath: path,
          reason: "case_collision",
        });
      } else if (!prior)
        canonicalPrefixes.set(canonicalPrefix, { exactPrefix, path });

      if (index < segments.length - 1 && exactPaths.has(exactPrefix)) {
        add({
          firstPath: exactPrefix,
          secondPath: path,
          reason: "file_directory_collision",
        });
      }
    }
  }
  return collisions;
}

function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function diffLines(
  base: readonly string[],
  variant: readonly string[]
): Edit[] | null {
  const rows = base.length + 1;
  const columns = variant.length + 1;
  if (rows * columns > MAX_LCS_CELLS) return null;
  const lcs = new Uint16Array(rows * columns);
  for (let i = base.length - 1; i >= 0; i--) {
    const row = i * columns;
    const nextRow = (i + 1) * columns;
    for (let j = variant.length - 1; j >= 0; j--) {
      lcs[row + j] =
        base[i] === variant[j]
          ? (lcs[nextRow + j + 1] ?? 0) + 1
          : Math.max(lcs[nextRow + j] ?? 0, lcs[row + j + 1] ?? 0);
    }
  }

  const edits: Edit[] = [];
  let i = 0;
  let j = 0;
  let start: number | null = null;
  let replacement: string[] = [];
  const flush = (end: number) => {
    if (start === null) return;
    edits.push({ start, end, replacement });
    start = null;
    replacement = [];
  };
  while (i < base.length || j < variant.length) {
    if (i < base.length && j < variant.length && base[i] === variant[j]) {
      flush(i);
      i++;
      j++;
      continue;
    }
    if (start === null) start = i;
    const deleteScore =
      i < base.length ? (lcs[(i + 1) * columns + j] ?? 0) : -1;
    const insertScore =
      j < variant.length ? (lcs[i * columns + j + 1] ?? 0) : -1;
    // On ties, consume the base line first. This fixed tie-break makes duplicate-line diffs stable.
    if (i < base.length && (j >= variant.length || deleteScore >= insertScore))
      i++;
    else if (j < variant.length) replacement.push(variant[j++] ?? "");
  }
  flush(base.length);
  return edits;
}

function sameEdit(left: Edit, right: Edit): boolean {
  return (
    left.start === right.start &&
    left.end === right.end &&
    left.replacement.length === right.replacement.length &&
    left.replacement.every((line, index) => line === right.replacement[index])
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function overlaps(left: Edit, right: Edit): boolean {
  const leftInsert = left.start === left.end;
  const rightInsert = right.start === right.end;
  if (leftInsert && rightInsert) return left.start === right.start;
  if (leftInsert) return left.start >= right.start && left.start <= right.end;
  if (rightInsert) return right.start >= left.start && right.start <= left.end;
  return left.start < right.end && right.start < left.end;
}

/** Merge only when both edits are valid, bounded UTF-8 text and their line ranges are independent. */
export function mergeThreeWayText(
  baseBytes: Uint8Array,
  targetBytes: Uint8Array,
  sourceBytes: Uint8Array
): ThreeWayTextMergeResult {
  if (
    [baseBytes, targetBytes, sourceBytes].some(
      (bytes) => bytes.byteLength > THREE_WAY_TEXT_MERGE_MAX_BYTES
    )
  )
    return { status: "conflict", reason: "size_limit" };
  const decode = (bytes: Uint8Array): string | null => {
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        bytes
      );
    } catch {
      return null;
    }
  };
  const baseText = decode(baseBytes);
  const targetText = decode(targetBytes);
  const sourceText = decode(sourceBytes);
  if (baseText === null || targetText === null || sourceText === null)
    return { status: "conflict", reason: "invalid_utf8" };
  if ([baseText, targetText, sourceText].some((text) => text.includes("\0")))
    return { status: "conflict", reason: "binary_content" };
  const base = splitLines(baseText);
  const target = splitLines(targetText);
  const source = splitLines(sourceText);
  if ([base, target, source].some((lines) => lines.length > MAX_LINES))
    return { status: "conflict", reason: "line_limit" };
  if (targetText === sourceText)
    return {
      status: "merged",
      content: targetBytes.slice(),
      algorithm: THREE_WAY_TEXT_MERGE_ALGORITHM,
    };
  if (targetText === baseText)
    return {
      status: "merged",
      content: sourceBytes.slice(),
      algorithm: THREE_WAY_TEXT_MERGE_ALGORITHM,
    };
  if (sourceText === baseText)
    return {
      status: "merged",
      content: targetBytes.slice(),
      algorithm: THREE_WAY_TEXT_MERGE_ALGORITHM,
    };

  const targetEdits = diffLines(base, target);
  const sourceEdits = diffLines(base, source);
  if (!targetEdits || !sourceEdits)
    return { status: "conflict", reason: "line_limit" };
  const edits = [...targetEdits, ...sourceEdits].sort(
    (a, b) =>
      a.start - b.start ||
      a.end - b.end ||
      compareText(a.replacement.join(""), b.replacement.join(""))
  );
  const unique: Edit[] = [];
  for (const edit of edits) {
    const duplicate = unique.find((prior) => sameEdit(prior, edit));
    if (duplicate) continue;
    if (unique.some((prior) => overlaps(prior, edit)))
      return { status: "conflict", reason: "edit_overlap" };
    unique.push(edit);
  }

  const output: string[] = [];
  let cursor = 0;
  for (const edit of unique) {
    if (edit.start < cursor)
      return { status: "conflict", reason: "edit_overlap" };
    output.push(...base.slice(cursor, edit.start), ...edit.replacement);
    cursor = edit.end;
  }
  output.push(...base.slice(cursor));
  const content = new TextEncoder().encode(output.join(""));
  if (content.byteLength > THREE_WAY_TEXT_MERGE_MAX_BYTES)
    return { status: "conflict", reason: "size_limit" };
  return {
    status: "merged",
    content,
    algorithm: THREE_WAY_TEXT_MERGE_ALGORITHM,
  };
}
