# Runtime discovery and installation

Agents expose `runtime list` and `runtime find <binary>` through the existing Bash-shaped virtual CLI. Discovery reads the current actor's active extension installations and the deployment-approved runtime catalogue. It does not allocate a container or install anything. A missing binary returns approved candidates and a human-approval requirement; an ambiguous binary requires a qualified `extension/container/binary` command.

The catalogue includes preconfigured profiles such as FFmpeg and LibreOffice, and can also contain FDE-authored runtime cards. A custom card is listed in `CONTAINER_IMAGE_REGISTRY` with `binding: "TOOL_SANDBOX"`, an immutable `image@sha256:…` digest, and a marketplace `id`, `name`, `description`, `category`, and `exportedBinaries`. It is shown only when the ToolSandbox binding exists. The image must implement the Naelao sandbox harness protocol; it runs through the same isolated ToolSandbox with Internet disabled, bounded package-host interception, and a maximum 60-second execution. The image and resources are pinned by deployment configuration; a caller manifest cannot register or replace a runnable image. New digests get new extension IDs, and removed pins stop resolving as executable installations.

Example deployment registry entry (use an actual reviewed digest; this example is documentation only):

```json
{
  "image": "registry.example/fde/pdf-tools@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "binding": "TOOL_SANDBOX",
  "memoryMb": 4096,
  "cpuCores": 0.5,
  "schedulingPolicy": "default",
  "networkPolicy": "none",
  "marketplace": {
    "id": "pdf-tools",
    "name": "PDF tools",
    "description": "Bounded PDF inspection commands",
    "category": "compute",
    "exportedBinaries": ["pdf-inspect"]
  }
}
```

This is a deployment-approved marketplace, not self-service arbitrary Docker execution. An FDE can author a card and container image, but a platform operator must build/review it, pin its digest and add the registry entry before customers can install it. Marketplace runtime IDs are not yet declared or auto-installed by Foundry templates. Runtime installation targets are a project workspace, the Space Assistant workspace, or the dedicated Space-extension workspace. Assistant-scoped containers are discoverable only from assistant runs with no project ID; project runs cannot see their commands or files. The Space-extension workspace remains separate from the Space Assistant workspace.

The Foundry page allows a Space owner to review and install a deployment-generated profile for the whole Space or a selected project. When another project already has that profile installed, the owner can promote it to Space scope or explicitly keep a separate project install. Promotion deactivates the existing project grants; it does not migrate files. Space-scoped extension data lives in its own Space workspace, separate from the Space Assistant workspace and every project workspace. The confirmation describes the runtime's exported commands, memory, CPU, timeout, network policy, workspace and metered runtime budget. The API re-fetches the catalogue, validates the exact generated manifest, checks space/project ownership and execution ceilings, and persists the installation in `SpaceDO`. Caller-supplied manifests and undeployed images are rejected. After installation, the caller retries the command; this flow does not claim automatic chat-task resumption.

Execution continues through the existing scoped container path. Each extension installation, project, run, image, and workspace has an isolated sidecar identity; identical image bytes may be reused by the deployment, while live processes and writable workspace state remain isolated. Container wall time cannot exceed 60 seconds, and an installation may set a lower timeout. Cancellation/deadline expiry aborts the invocation; idle/expiry alarms also stop the container. Keep timers, polling and long-running orchestration in Durable Workflows, which can wait durably and invoke bounded container steps. Workflow and container usage remain subject to their configured metering; this architecture does not imply free idle time or a fixed credit saving.

## Verification boundary

Local tests cover pin and binding ambiguity, runtime proposals without installation/allocation, actor-scoped installed command discovery, invalid binary names, immutable manifests, invalid scope before writes, idempotent install, and installation lookup after `SpaceDO` recreation. They do not validate a live Cloudflare deployment or image availability. The [Cloudflare Durable Object Container API reference](https://developers.cloudflare.com/containers/api/durable-object-container/) states that `container.inspect()` returns the running image reference; live binding/digest configuration still needs to be set and verified in the target deployment.
