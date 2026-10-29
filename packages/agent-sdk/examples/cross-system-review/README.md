# Cross-System Review Canvas

This userspace extension example pairs a `CanvasMount` canvas with a project-bound Gadget. The signed manifest grants that canvas read-only access to one table, `review_records`. The host checks the active project, installation, canvas, Gadget, and table on each read. The extension receives no direct provider credentials or write API.

The buttons emit a project-scoped `canvas.action` event for the normal planner/worker path. They do not mutate the Gadget or call an external system. A real template should have its worker validate the request, gather source evidence, apply the project’s approval policy, and record an idempotent outcome before any supported external action.

This example is simulation-first and is not yet a portable marketplace dependency. The current template activation path cannot install independent FDE extension releases into a new tenant Space. No live provider action is implemented here.

## Package contents

- `manifest.json` declares the canvas, Gadget, and exact read-only table grant.
- `index.html` renders bounded records and emits planner actions through the host canvas bridge.

The outer `extension.gadget.read` capability is required when a canvas declares `gadgetReads`. The capability grants only the manifest allowlist, and the host independently enforces that allowlist at runtime.
