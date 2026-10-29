# Cross-System Review Canvas

This userspace extension example pairs a `CanvasMount` canvas with a project-bound Gadget. The signed manifest grants that canvas read-only access to one table, `review_records`. The host checks the active project, installation, canvas, Gadget, and table on each read. The extension receives no direct provider credentials or write API.

The buttons emit a project-scoped `canvas.action` event for the normal planner/worker path. They do not mutate the Gadget or call an external system. A real template should have its worker validate the request, gather source evidence, apply the project’s approval policy, and record an idempotent outcome before any supported external action.

This example is simulation-first and is not yet a portable marketplace dependency. The current template activation path cannot install independent FDE extension releases into a new tenant Space. No live provider action is implemented here.

## Package contents

- `manifest.json` declares the canvas, Gadget, and exact read-only table grant.
- `index.html` renders bounded records and emits planner actions through the host canvas bridge.

When the canvas is built with the SDK, use its typed host client instead of hand-writing the
`postMessage` protocol:

```ts
import { createExtensionCanvasClient } from "@naelao/agent-sdk";

const canvas = createExtensionCanvasClient(projectId);
const records = await canvas.readGadget({
  gadgetId: "review_store",
  operation: "list",
  table: "review_records",
  limit: 25,
});
const outcome = await canvas.emitAction("review.simulated_decision", {
  decision: "approve",
  simulation_only: true,
});
// outcome.status is "queued" or "completed"; queued outcomes include runId when available.
// Failures reject with the host result.
// Call canvas.dispose() when the view is torn down.
```

The host rechecks the signed installation and per-canvas table grant. The SDK client only sends
read requests and planner actions; it exposes no Gadget write operation.

The outer `extension.gadget.read` capability is required when a canvas declares `gadgetReads`. The capability grants only the manifest allowlist, and the host independently enforces that allowlist at runtime.
