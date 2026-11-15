# UI SDK synthetic inventory POC

This is an isolated local evaluation of the published `@ui-sdk/web` and
`@ui-sdk/core` **0.1.0-beta.3** packages. It is separate from the React 18
Shell and uses only invented sample stock. It has no agent model, network
tool, production endpoint, provider credential, or business write path.

Run from the repository root with `pnpm --filter @naelao/ui-sdk-synthetic-poc
dev`, then open the local Vite address. In DevTools, inspect
`window.uiAgent.snapshot()` and try the action shown on the page. The agent
bridge permits only the named filter input and the exact values `""` and
`"low stock"`, plus bounded voice-setup draft controls; a native modal
confirmation is required for every agent change. The owner review shows exact
synthetic voice, greeting, and business-hours values and says provider cost is
unknown. Approval is local and does not publish or save configuration.

The demo does not establish iframe isolation, production authority, deployed
multi-user safety, WebMCP interoperability, screen-reader acceptance, or the
vendor's performance claims. The beta is pinned for reproducibility and is not
adopted by Shell. Any future integration still needs the full section 11.5
security, accessibility, mobile, concurrency, and deployed acceptance work.
