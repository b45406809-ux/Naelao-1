# UI SDK synthetic inventory POC

This is an isolated local evaluation of the published `@ui-sdk/web` and
`@ui-sdk/core` **0.1.0-beta.3** packages. It is separate from the React 18
Shell and uses only invented sample stock. It has no agent model, network
tool, production endpoint, provider credential, or business write path.

Run from the repository root with `pnpm --filter @naelao/ui-sdk-synthetic-poc
dev`, then open the local Vite address. The dev server permits module loading
from the opaque sandboxed Canvas frame; this CORS setting is development-only.
In DevTools, inspect
`window.uiAgent.snapshot()` and try the action shown on the page. The agent
bridge permits only the named filter input and the exact values `""` and
`"low stock"`, plus bounded voice-setup draft controls; a native modal
confirmation is required for every agent change. The owner review shows exact
synthetic voice, greeting, and business-hours values and says provider cost is
unknown. Approval is local and does not publish or save configuration.

When embedded at an active Space or Project Canvas app route, the low-stock filter
uses `createBusinessActionClient` to list and invoke the signed
`listLowStock` read-only action. It validates the advertised exact schema and
response; an embedded failure displays no synthetic data. A standalone Vite
page has no host identity and stays on invented sample data. The checked-in
browser bridge simulation uses a local fake parent; it is not a deployed
authenticated read.

The demo does not establish deployed iframe isolation, production authority,
multi-user safety, WebMCP interoperability, screen-reader acceptance, or the
vendor's performance claims. The beta is pinned for reproducibility and is not
adopted by Shell. Any future integration still needs the full section 11.5
security, accessibility, mobile, concurrency, and deployed acceptance work.
