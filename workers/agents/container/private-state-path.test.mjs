import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readPrivateStatePaths, safePrivateStatePath, writePrivateStatePaths } from "./private-state-path.mjs";

const roots = [];
async function root() {
  const value = await mkdtemp(join(tmpdir(), "naelao-private-state-test-"));
  roots.push(value);
  return value;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe("private state path boundary", () => {
  it("accepts only bounded relative private data paths", () => {
    expect(safePrivateStatePath("settings/preferences.json")).toBe("settings/preferences.json");
    for (const value of ["", "../x", "/absolute", "state\\file", ".env", "browser/profile", "cache/index", "credentials.json", "node_modules/x"]) {
      expect(() => safePrivateStatePath(value)).toThrow("private_state_path_invalid");
    }
  });

  it("reads only requested private files and reports missing selections without exposing workspace files", async () => {
    const workspace = await root();
    await mkdir(join(workspace, ".naelao", "private", "settings"), { recursive: true });
    await writeFile(join(workspace, ".naelao", "private", "settings", "preferences.json"), Buffer.from([0, 1, 2, 255]));
    await writeFile(join(workspace, "README.md"), "shared workspace data");
    await expect(readPrivateStatePaths(["settings/preferences.json", "settings/missing.json"], workspace)).resolves.toEqual({
      files_base64: { "settings/preferences.json": "AAEC/w==" }, missing_paths: ["settings/missing.json"],
    });
  });

  it("restores additively and preserves an existing private file", async () => {
    const workspace = await root();
    await mkdir(join(workspace, ".naelao", "private", "settings"), { recursive: true });
    await writeFile(join(workspace, ".naelao", "private", "settings", "existing.json"), "current");
    await expect(writePrivateStatePaths({
      "settings/existing.json": Buffer.from("older").toString("base64"),
      "settings/new.json": Buffer.from("recovered").toString("base64"),
    }, workspace)).resolves.toEqual({ written_paths: ["settings/new.json"], preserved_paths: ["settings/existing.json"] });
    await expect(readPrivateStatePaths(["settings/existing.json", "settings/new.json"], workspace)).resolves.toEqual({
      files_base64: { "settings/existing.json": Buffer.from("current").toString("base64"), "settings/new.json": Buffer.from("recovered").toString("base64") },
      missing_paths: [],
    });
  });

  it("rejects symlink traversal before reading or restoring", async () => {
    const workspace = await root();
    await mkdir(join(workspace, ".naelao"), { recursive: true });
    await symlink(tmpdir(), join(workspace, ".naelao", "private"));
    await expect(readPrivateStatePaths(["state.json"], workspace)).rejects.toThrow("private_state_symlink_rejected");
    await expect(writePrivateStatePaths({ "state.json": Buffer.from("private").toString("base64") }, workspace))
      .rejects.toThrow("private_state_symlink_rejected");
  });
});
