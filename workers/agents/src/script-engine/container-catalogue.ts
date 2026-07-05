/**
 * Container Marketplace catalogue (spec §33b "Container System", gap G-1; §A1.17 Phase L).
 * Naelao-authored DATA, same "Whop first, everything else coming_soon" precedent as
 * `connectors/catalogue.ts` and `LAUNCHPAD_TEMPLATES` — adding an image is a catalogue row, never
 * a code branch in the reasoning loop.
 *
 * Phase K already gave every project a base Tier-5 sandbox (Python/Bash, ephemeral compute,
 * R2-synced `/workspace`) via `ToolSandboxDO`. The marketplace is for workloads that base sandbox
 * can't serve: a LONG-RUNNING stateful server (a database, a cache) that needs its own container
 * lifecycle, its own persistence strategy, and its own per-minute billing — NOT a one-shot CLI
 * tool. (A one-shot tool like ffmpeg is better served by adding the binary to the base sandbox
 * image and calling it via the existing `code.execute_bash` op — no marketplace slot needed.)
 *
 * Honest scope note (§A1.16.24-style transparency): every entry below is `available: false`
 * this pass. The slot lifecycle (this file + `container_slots` CRUD + the `container_image`
 * routing hook in code-runner.ts) is real, tested infrastructure — but shipping an actual image
 * (a real Dockerfile, a persistence strategy for its `/data`, a `[[containers]]` wrangler binding,
 * and its own DO class) is a dedicated, per-image undertaking the plan itself calls out as
 * "infra-heavy; sequence incrementally, one image type end-to-end first." That first image is
 * intentionally NOT rushed into this pass alongside the mechanism — see the phase's own docs for
 * why (postgres/redis need a real cross-restart persistence design, not the base sandbox's
 * per-call R2 text-sync, which is scoped to small text/script files).
 */

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
  /** false = catalogue entry only, no Dockerfile/binding/DO exists yet (see file header). */
  available: boolean;
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
