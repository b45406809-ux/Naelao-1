import {
  parseExtensionBundle,
  type ExtensionBundleManifest,
} from "./extensions.js";
export interface ExtensionPackageDraft {
  manifest: ExtensionBundleManifest;
  files: Readonly<Record<string, string>>;
}
export interface PackageInspection {
  state: "validated" | "blocked";
  blockers: readonly { code: string; path?: string }[];
  requestedCapabilities: readonly string[];
  requestedPermissions: readonly {
    scope: string;
    actions: readonly string[];
    resource: string;
  }[];
  connections: ExtensionBundleManifest["connections"];
  requestedTools: readonly string[];
  workerRoles: ExtensionBundleManifest["workerRoles"];
  knowledge: ExtensionBundleManifest["knowledge"];
  entrypoints: readonly string[];
  evidence: { hostExecuted: false; installed: false; certified: false };
}
const pathPattern =
  /^(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const normalize = (p: string) => (p.startsWith("./") ? p.slice(2) : p);
/** Local checks never execute a draft or attest host installation/certification. */
export function inspectExtensionPackage(
  input: ExtensionPackageDraft
): PackageInspection {
  const blockers: { code: string; path?: string }[] = [];
  const evidence = {
    hostExecuted: false,
    installed: false,
    certified: false,
  } as const;
  const blocked = (code: string): PackageInspection => ({
    state: "blocked",
    blockers: [{ code }],
    requestedCapabilities: [],
    requestedPermissions: [],
    connections: [],
    requestedTools: [],
    workerRoles: [],
    knowledge: [],
    entrypoints: [],
    evidence,
  });
  let manifest: ExtensionBundleManifest;
  try {
    manifest = parseExtensionBundle(input?.manifest);
  } catch {
    return blocked("invalid_manifest");
  }
  if (
    !input.files ||
    typeof input.files !== "object" ||
    Array.isArray(input.files)
  )
    return blocked("package_files_required");
  const files = Object.entries(input.files);
  let bytes = 0;
  if (files.length > 256) return blocked("package_file_count_exceeded");
  for (const [path, content] of files) {
    if (
      !pathPattern.test(path) ||
      path.length > 160 ||
      path
        .split("/")
        .some((p) => ["__proto__", "constructor", "prototype"].includes(p))
    )
      blockers.push({ code: "invalid_package_path", path });
    if (typeof content !== "string")
      blockers.push({ code: "invalid_file_content", path });
    else bytes += new TextEncoder().encode(content).byteLength;
  }
  if (bytes > 2 * 1024 * 1024)
    blockers.push({ code: "package_bytes_exceeded" });
  const entries = new Set<string>();
  for (const p of manifest.primitives) {
    for (const hook of Object.values(p.lifecycle))
      if (hook) entries.add(normalize(hook));
    if (p.kind === "canvas") entries.add(normalize(p.component));
    if (p.kind === "channel") entries.add(normalize(p.handlerScript));
    if (p.kind === "workflow" || p.kind === "linter")
      entries.add(normalize(p.entry));
  }
  for (const role of manifest.workerRoles ?? [])
    entries.add(normalize(role.entry));
  for (const path of entries)
    if (!Object.hasOwn(input.files, path))
      blockers.push({ code: "missing_entrypoint", path });
  return {
    state: blockers.length ? "blocked" : "validated",
    blockers,
    requestedCapabilities: [
      ...new Set(
        manifest.primitives.flatMap((p) => [...p.capabilityRequirements])
      ),
    ].sort(),
    requestedPermissions: manifest.primitives.flatMap((p) =>
      p.permissions.map((permission) => ({
        ...permission,
        actions: [...permission.actions],
      }))
    ),
    requestedTools: [
      ...new Set(
        manifest.primitives.flatMap((p) =>
          p.kind === "workflow" ? [...p.toolNames] : []
        )
      ),
    ].sort(),
    workerRoles: manifest.workerRoles ?? [],
    knowledge: manifest.knowledge ?? [],
    connections: manifest.connections ?? [],
    entrypoints: [...entries].sort(),
    evidence,
  };
}
