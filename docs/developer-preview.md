# Protected local development preview

Start the local Naelao stack, then expose the shell to specific email recipients with:

```sh
pnpm share -- --for owner@example.com --for reviewer@example.org
```

This starts `cloudflared` against the local shell on port 3100 and adds one `--allowed-mail`
flag for each recipient. Visitors authenticate with an email one-time PIN in a browser; the
preview URL is temporary and changes when the tunnel restarts. The share command does not
install or start `cloudflared`; install it separately and keep it on `PATH`.

Cloudflare documents that Quick Tunnels do not support Server-Sent Events. Naelao chat uses its
polling fallback through this preview, so live token streaming is unavailable. This is a temporary
developer preview path; use the named-machine outbound tunnel for persistent private-machine
connectivity and the normal deployment path for production.
