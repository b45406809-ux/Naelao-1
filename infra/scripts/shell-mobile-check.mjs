#!/usr/bin/env node
// Verify the mobile off-canvas sidebars actually open, at a real phone viewport, via Cloudflare
// Browser Rendering (Playwright can't TLS-handshake through this sandbox's proxy — see
// shell-screenshot.mjs's own header). Takes a "closed" screenshot, then an "after click"
// screenshot for each --click selector given, in one script per call so state (the session,
// React's mount) survives between them.
//
// Usage:
//   source .cf-credentials.local
//   node infra/scripts/shell-mobile-check.mjs --url <page> --session-space <id> --session-json <path> \
//     --click 'button.mobile-menu-btn' --out-before before.png --out-after after.png [--wait 6000]

import fs from "node:fs";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) { out[argv[i].slice(2)] = argv[i + 1]; i++; }
  }
  return out;
}

function buildInjector({ sessionKey, sessionValue, activeSpaceKey, activeSpaceValue, clickSelector, clickDelayMs }) {
  return `
    (function () {
      try { localStorage.setItem(${JSON.stringify(sessionKey)}, ${JSON.stringify(sessionValue)}); } catch (e) {}
      ${activeSpaceKey ? `try { sessionStorage.setItem(${JSON.stringify(activeSpaceKey)}, ${JSON.stringify(activeSpaceValue)}); } catch (e) {}` : ""}
      window.__naelaoClicked = false;
      ${clickSelector ? `
      var tries = 0;
      var iv = setInterval(function () {
        tries++;
        var el = document.querySelector(${JSON.stringify(clickSelector)});
        if (el) {
          clearInterval(iv);
          setTimeout(function () { el.click(); window.__naelaoClicked = true; }, ${clickDelayMs});
        } else if (tries > 60) {
          clearInterval(iv);
        }
      }, 200);
      ` : ""}
    })();
  `;
}

async function shoot({ base, headers, url, width, height, session, sessionSpace, activeSpaceId, clickSelector, clickDelayMs, wait, out }) {
  const injector = buildInjector({
    sessionKey: `naelao_product_session:${sessionSpace}`,
    sessionValue: JSON.stringify(session),
    activeSpaceKey: activeSpaceId ? `naelao:active-space:${sessionSpace}` : undefined,
    activeSpaceValue: activeSpaceId ? JSON.stringify({ id: activeSpaceId, name: null }) : undefined,
    clickSelector,
    clickDelayMs,
  });
  const body = {
    url,
    viewport: { width, height, isMobile: true, hasTouch: true },
    gotoOptions: { waitUntil: "domcontentloaded", timeout: 45000 },
    addScriptTag: [{ content: injector }],
    waitForTimeout: wait,
  };
  const res = await fetch(`${base}/screenshot`, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) {
    console.error(`screenshot failed for ${out}:`, res.status, (await res.text()).slice(0, 400));
    return;
  }
  fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
  console.log(`wrote ${out}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) {
    console.error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (`source .cf-credentials.local`)");
    process.exit(1);
  }
  if (!args.url || !args["session-space"] || !args["session-json"]) {
    console.error("Usage: --url <page> --session-space <id> --session-json <path> [--click <selector>] --out-before <f> [--out-after <f>] [--wait ms]");
    process.exit(1);
  }
  const session = JSON.parse(fs.readFileSync(args["session-json"], "utf8"));
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering`;
  const headers = { authorization: `Bearer ${apiToken}`, "content-type": "application/json" };
  const width = Number(args.width ?? 390);
  const height = Number(args.height ?? 844);
  const wait = Number(args.wait ?? 6000);

  await shoot({
    base, headers, url: args.url, width, height,
    session, sessionSpace: args["session-space"], activeSpaceId: args["active-space-id"],
    wait,
    out: args["out-before"] ?? "mobile-before.png",
  });

  if (args.click) {
    await shoot({
      base, headers, url: args.url, width, height,
      session, sessionSpace: args["session-space"], activeSpaceId: args["active-space-id"],
      clickSelector: args.click,
      clickDelayMs: Number(args["click-delay"] ?? 1500),
      wait: wait + Number(args["click-delay"] ?? 1500) + 1500,
      out: args["out-after"] ?? "mobile-after.png",
    });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
