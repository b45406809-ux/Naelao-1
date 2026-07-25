#!/usr/bin/env node
// Real E2E visual verification for apps/shell (and any other page), without a local browser.
//
// The sandboxed dev environment's MITM proxy breaks Playwright/Puppeteer's TLS handshake
// (documented in CLAUDE.md item 66's own postmortem) — this sidesteps that entirely by using
// Cloudflare's own Browser Rendering REST API (a real headless Chromium, run by Cloudflare, hit
// over a plain authenticated HTTPS POST — the same transport every other CF API call in this
// project already uses successfully).
//
// To also verify an AUTHENTICATED page: sign up/log in a real end user via the live
// product-end-user API first (POST /v1/spaces/:spaceId/end-users/{signup,login}), then pass the
// resulting session as --session-space/--session-json — this injects it into localStorage under
// the exact key apps/shell/src/lib/productAccount.ts reads (`naelao_product_session:{spaceId}`)
// via the REST API's `addScriptTag`, then navigates back to the requested URL (NOT reload —
// the unauthenticated first load has usually already bounced to /login by then).
//
// Usage:
//   source .cf-credentials.local
//   node infra/scripts/shell-screenshot.mjs --url https://naelao-shell.pages.dev/p/launchpad \
//     [--session-space 457a2b3a-96f1-46f1-8143-00a64f48f03d] [--session-json ./session.json] \
//     [--out screenshot.png] [--width 1280] [--height 900] [--wait 5000]

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      out[a.slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) {
    console.error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (e.g. `source .cf-credentials.local`)");
    process.exit(1);
  }
  if (!args.url) {
    console.error("Usage: node shell-screenshot.mjs --url <page-url> [--session-space <spaceId> --session-json <path>] [--out <file.png>]");
    process.exit(1);
  }

  const body = {
    url: args.url,
    viewport: { width: Number(args.width ?? 1280), height: Number(args.height ?? 900) },
    gotoOptions: { waitUntil: "networkidle0", timeout: 30000 },
    waitForTimeout: Number(args.wait ?? 3000),
  };

  if (args["session-space"] && args["session-json"]) {
    const fs = await import("node:fs");
    const session = JSON.parse(fs.readFileSync(args["session-json"], "utf8"));
    const key = `naelao_product_session:${args["session-space"]}`;
    // Navigate to the target URL explicitly rather than reload(). The first (unauthenticated)
    // load of any shell page redirects to /login, so by the time this script runs the browser is
    // usually no longer ON the requested page — reload() would then re-render /login (which,
    // now authenticated, bounces to Home), silently screenshotting the wrong page.
    const js = `
      localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(JSON.stringify(session))});
      setTimeout(function() { window.location.href = ${JSON.stringify(args.url)}; }, 200);
    `;
    body.addScriptTag = [{ content: js }];
    body.waitForTimeout = Number(args.wait ?? 5000); // extra time for the reload + re-mount
  }

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/screenshot`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok || res.headers.get("content-type") !== "image/png") {
    const text = await res.text();
    console.error(`Screenshot failed (${res.status}): ${text.slice(0, 500)}`);
    process.exit(1);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  const outPath = args.out ?? "screenshot.png";
  const fs = await import("node:fs");
  fs.writeFileSync(outPath, buf);
  console.log(`Wrote ${outPath} (${buf.length} bytes)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
