# Trusted package egress

The Tier-6 tool container keeps Cloudflare Container internet access disabled. At cold start,
the Durable Object registers provider-native HTTPS interceptions for the exact hostnames in
`workers/agents/src/script-engine/package-egress.ts`. Requests are forwarded directly without
an application cache, package scanner, or mutable registry mirror. Redirects return to the
container; only another intercepted host can be reached because general internet remains off.

The initial allowlist covers npm, PyPI artifact downloads, crates.io, and common GitHub source
and release hosts. It is intentionally explicit. A package whose install requires another host
will fail closed until that source is reviewed and added. The image trusts Cloudflare's runtime
interception CA when that managed certificate is mounted; local images without the certificate
do not exercise the live intercepted TLS path.

The existing scoped mutation grant now gates direct package-add commands (`npm install`, `pip
install`, `cargo add`, and related commands) and edits through the `Edit`/`Write` tools to
dependency manifests and lockfiles. Clean locked restore commands such as `npm ci` and
`pnpm install --frozen-lockfile` do not match these addition rules. This is a deterministic
command/tool guard, not a shell AST or a guarantee against arbitrary scripts that write files
or invoke package tools indirectly; the network host boundary remains the independent control.

Container execution retains the existing 60-second maximum. No live Cloudflare container test
was run; unit tests verify the exact allowlist and that cold start registers it while keeping
internet disabled.
