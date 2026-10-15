/**
 * Container Marketplace catalogue (spec §33b "Container System", gap G-1; §A1.17 Phase L).
 * Naelao-authored DATA, same "Whop first, everything else coming_soon" precedent as
 * `connectors/catalogue.ts` and `LAUNCHPAD_TEMPLATES` — adding an image is a catalogue row, never
 * a code branch in the reasoning loop.
 *
 * Phase K already gave every project a base Tier-5 sandbox (Python/Bash, ephemeral compute,
 * a `/workspace` an agent explicitly stages via `workspace.copy` — §A1.17 Phase R, see
 * workspace.ts) via `ToolSandboxDO`. The marketplace is for workloads that base sandbox
 * can't serve. Both one-shot extension binaries and stateful services require an approved
 * immutable image, a scoped lifecycle, durable artifacts and measured usage. Extension tools
 * use task-isolated sidecars; they are not silently installed in the general project image.
 *
 * Catalogue metadata does not prove that an image is deployed. `deployedContainerCatalogue`
 * marks only fixed images whose binding is present and whose digest is explicitly approved by
 * deployment configuration. Stateful database images remain unavailable until they have their
 * own persistent storage implementation and lifecycle.
 */

import { parseApprovedContainerImages } from "./container-policy.js";
import type { ExtensionManifest } from "@naelao/agent-sdk";

export interface ContainerImageManifest {
  id: string;
  name: string;
  description: string;
  category: "database" | "cache" | "media" | "compute" | "browser";
  /** Op names this image's harness would expose once live (agent-facing discoverability metadata
   *  — NOT dynamically-registered script-engine ops; per CLAUDE.md's script-native architecture,
   *  a live image is reached the same way every other Tier-5 capability is: a stored script
   *  tagged with this image's id, found via `script.find`). */
  exposed_ops: string[];
  /** Container paths whose contents must survive a restart — informs the persistence strategy an
   *  image's own DO needs (the base sandbox's per-call R2 sync only suits small text files). */
  persisted_paths: string[];
  network_policy: "none" | "outbound";
  /** Minimum plan tier a space needs to add a slot of this image, once live. */
  billing_tier: "free" | "pro" | "enterprise";
  /** True only when a fixed runtime binding and its exact digest are approved at deployment. */
  available: boolean;
  image?: string;
  exported_binaries?: string[];
  install_manifest?: ExtensionManifest;
}

export const CONTAINER_IMAGE_CATALOGUE: ContainerImageManifest[] = [
  {
    id: "postgres-16",
    name: "PostgreSQL 16",
    description: "A dedicated Postgres database for this project — schemas, migrations, real SQL.",
    category: "database",
    exposed_ops: ["postgres.query", "postgres.migrate"],
    persisted_paths: ["/var/lib/postgresql/data"],
    network_policy: "none",
    billing_tier: "pro",
    available: false,
  },
  {
    id: "redis-7",
    name: "Redis 7",
    description: "A dedicated Redis instance for caching, queues, or pub/sub.",
    category: "cache",
    exposed_ops: ["redis.get", "redis.set", "redis.del", "redis.keys", "redis.expire"],
    persisted_paths: ["/data"],
    network_policy: "none",
    billing_tier: "pro",
    available: false,
  },
  {
    id: "chrome-headless",
    name: "Chrome (unrestricted)",
    description: "A full, unrestricted headless Chrome — for automation the sandboxed Tier-4 CF Browser Rendering can't do.",
    category: "browser",
    exposed_ops: ["browser.launch", "browser.navigate", "browser.screenshot"],
    persisted_paths: [],
    network_policy: "outbound",
    billing_tier: "enterprise",
    available: false,
  },
  {
    id: "ffmpeg",
    name: "FFmpeg",
    description: "Video/audio transcoding against the project's workspace files.",
    category: "media",
    exposed_ops: ["ffmpeg.transcode", "ffmpeg.probe"],
    persisted_paths: [],
    network_policy: "none",
    billing_tier: "free",
    available: false,
  },
  {
    id: "blender-cli",
    name: "Blender (headless)",
    description: "Headless Blender renders driven by a project's own .blend files.",
    category: "compute",
    exposed_ops: ["blender.render"],
    persisted_paths: [],
    network_policy: "none",
    billing_tier: "enterprise",
    available: false,
  },
  {
    id: "pytorch-gpu",
    name: "PyTorch (GPU)",
    description: "GPU-backed PyTorch for training/inference workloads too heavy for a V8 isolate.",
    category: "compute",
    exposed_ops: ["pytorch.run"],
    persisted_paths: ["/workspace/checkpoints"],
    network_policy: "none",
    billing_tier: "enterprise",
    available: false,
  },
  {
    id: "r-statistical",
    name: "R (statistical computing)",
    description: "An R runtime for statistical analysis and plotting against project data.",
    category: "compute",
    exposed_ops: ["r.execute"],
    persisted_paths: [],
    network_policy: "none",
    billing_tier: "pro",
    available: false,
  },
];

export function findContainerImage(imageId: string): ContainerImageManifest | undefined {
  return CONTAINER_IMAGE_CATALOGUE.find((i) => i.id === imageId);
}

/** Deployment authority, not an optimistic catalogue flag, determines runtime availability.
 * Multiple pins for one fixed binding are ambiguous and must not advertise an install.
 */
export function deployedContainerCatalogue(registryJson: string | undefined, bound: readonly string[]): ContainerImageManifest[] {
  const registry = parseApprovedContainerImages(registryJson);
  const profiles = [
    { id: "ffmpeg", binding: "MEDIA_SANDBOX", binaries: ["ffmpeg", "ffprobe"], name: "FFmpeg", category: "media" as const },
    { id: "libreoffice", binding: "DOCUMENT_SANDBOX", binaries: ["soffice", "libreoffice"], name: "LibreOffice", category: "compute" as const },
  ];
  const images = CONTAINER_IMAGE_CATALOGUE.map(entry => ({ ...entry }));
  for (const profile of profiles) {
    const pins = registry.filter(entry => entry.binding === profile.binding && bound.includes(entry.binding));
    const existing = images.find(entry => entry.id === profile.id);
    const entry: ContainerImageManifest = existing ?? { id: profile.id, name: profile.name, description: "Bounded document conversion in an approved specialized runtime.", category: profile.category,
      exposed_ops: [], persisted_paths: [], network_policy: "none", billing_tier: "free", available: false };
    if (!existing) images.push(entry);
    if (pins.length !== 1) continue;
    const pin = pins[0]!;
    entry.available = true;
    entry.image = pin.image;
    entry.exported_binaries = [...profile.binaries];
    entry.install_manifest = {
      // A changed deployment digest is a new immutable extension revision. Keeping the old
      // manifest id would either mutate existing grants or silently reuse a revoked image.
      id: `ext_runtime_${profile.id}_${pin.image.slice(-12)}`, type: "extension", declaredPermissions: ["container:execute"], capabilityRequirements: ["native-execution"], gadgets: [], daemons: [], commands: [],
      containers: [{ schemaVersion: "1.0", kind: "container", id: profile.id, version: "1.0.0", permissions: [{ scope: "PROJECT_BOUND", actions: ["execute"], resource: "workspace" }],
        capabilityRequirements: ["native-execution"], lifecycle: {}, image: pin.image, resources: { memoryMb: pin.memoryMb, cpuCores: pin.cpuCores, timeoutSeconds: 60 }, exportedBinaries: profile.binaries, networkPolicy: "none" }],
    };
  }
  // FDE-built images enter the customer marketplace only after an operator pins the reviewed
  // immutable digest in CONTAINER_IMAGE_REGISTRY. Images implement the sandbox harness protocol;
  // execution still uses the same bounded, no-network ToolSandbox boundary. An FDE manifest or
  // planner text never acts as deployment authority.
  for (const pin of registry.filter(entry => entry.binding === "TOOL_SANDBOX" && entry.marketplace)) {
    const card = pin.marketplace!;
    if (!bound.includes("TOOL_SANDBOX") || images.some(entry => entry.id === card.id)) continue;
    images.push({
      id: card.id, name: card.name, description: card.description, category: card.category,
      exposed_ops: [], persisted_paths: [], network_policy: "none", billing_tier: "pro", available: true,
      image: pin.image, exported_binaries: [...card.exportedBinaries],
      install_manifest: {
        id: `ext_runtime_${card.id}_${pin.image.slice(-12)}`, type: "extension", declaredPermissions: ["container:execute"], capabilityRequirements: ["native-execution"], gadgets: [], daemons: [], commands: [],
        containers: [{ schemaVersion: "1.0", kind: "container", id: card.id, version: "1.0.0", permissions: [{ scope: "PROJECT_BOUND", actions: ["execute"], resource: "workspace" }],
          capabilityRequirements: ["native-execution"], lifecycle: {}, image: pin.image, resources: { memoryMb: pin.memoryMb, cpuCores: pin.cpuCores, timeoutSeconds: 60 }, exportedBinaries: [...card.exportedBinaries], networkPolicy: "none" }],
      },
    });
  }
  return images;
}

export { resolveContainerBinary, approvedContainer, parseApprovedContainerImages, sidecarKey } from "./container-policy.js";
