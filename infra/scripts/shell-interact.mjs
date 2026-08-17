#!/usr/bin/env node
// Drive the real Product Shell as a signed-in end user — type a message, send it, watch what
// happens — and screenshot the result. The interactive sibling of shell-screenshot.mjs.
//
// Why not Playwright: this sandbox routes all egress through a MITM proxy that Chromium cannot
// negotiate TLS through (every navigation dies with ERR_CONNECTION_RESET, with or without
// --proxy-server, Playwright's own proxy option, or --disable-http2 — all tried). Cloudflare's
// Browser Rendering REST API runs a real headless Chrome inside Cloudflare's network and is
// reached over an ordinary authenticated HTTPS POST, which the proxy handles fine.
//
// The typing is real DOM interaction, not an API call: React tracks a controlled <textarea>'s
// value through its own descriptor, so setting `.value` directly is invisible to it — the native
// setter has to be called on the prototype and an `input` event dispatched, exactly as a keystroke
// does. Enter is a real KeyboardEvent so the component's own onKeyDown handler runs.
//
// Usage:
//   source .cf-credentials.local
//   node infra/scripts/shell-interact.mjs --url https://naelao-shell.pages.dev/p/launchpad/new \
//     --session-space <productSpaceId> --session-json ./session.json \
//     --type "hello there" [--wait 60000] [--out shot.png]

import fs from "node:fs";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) { out[argv[i].slice(2)] = argv[i + 1]; i++; }
  }
  return out;
}

/** Runs inside the page. Kept as a plain string so it survives JSON transport unmangled. */
function buildInjector({ sessionKey, sessionValue, text, typeDelayMs }) {
  return `
    (function () {
      try { localStorage.setItem(${JSON.stringify(sessionKey)}, ${JSON.stringify(sessionValue)}); } catch (e) {}
      window.__naelaoLog = [];
      var t0 = Date.now();
      var log = function (m) { window.__naelaoLog.push("+" + (Date.now() - t0) + "ms " + m); };
      log("injected, url=" + location.href);

      // Record every API call the app makes and how it went. Without this a failure shows up only
      // as a message on screen with no way to tell WHICH request produced it.
      var origFetch = window.fetch;
      window.fetch = function (input, init) {
        var url = typeof input === "string" ? input : (input && input.url) || String(input);
        var method = (init && init.method) || (input && input.method) || "GET";
        return origFetch.apply(this, arguments).then(function (res) {
          if (url.indexOf("/v1/") !== -1) log("FETCH " + res.status + " " + method + " " + url.replace(/https?:\\/\\/[^/]+/, ""));
          return res;
        }, function (err) {
          log("FETCH ERROR " + method + " " + url + " :: " + err);
          throw err;
        });
      };

      // Surface the log inside the DOM so the /content response carries it back.
      setInterval(function () {
        var el = document.getElementById("__naelao_probe");
        if (!el) {
          el = document.createElement("pre");
          el.id = "__naelao_probe";
          el.setAttribute("style", "position:fixed;left:-99999px;top:0");
          document.body.appendChild(el);
        }
        el.textContent = "PROBE_START\\n" + window.__naelaoLog.join("\\n") + "\\nPROBE_END";
      }, 1000);

      // React owns the value of a controlled input through its own property descriptor, so a plain
      // assignment is invisible to it. Go through the prototype's native setter and fire the same
      // 'input' event a keystroke produces.
      function setReactValue(el, value) {
        var proto = Object.getPrototypeOf(el);
        var desc = Object.getOwnPropertyDescriptor(proto, "value");
        if (desc && desc.set) desc.set.call(el, value); else el.value = value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }

      function findBox() {
        return document.querySelector("textarea.msg-input") || document.querySelector("textarea");
      }

      var tries = 0;
      var iv = setInterval(function () {
        tries++;
        var box = findBox();
        if (!box) { if (tries > 40) { clearInterval(iv); log("NO TEXTAREA FOUND after " + tries); } return; }
        clearInterval(iv);
        log("found textarea after " + tries + " polls");
        box.focus();
        setReactValue(box, ${JSON.stringify(text)});
        log("typed: " + box.value.slice(0, 60));
        setTimeout(function () {
          var evt = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true });
          box.dispatchEvent(evt);
          log("pressed Enter");
          // Belt and braces: if the handler didn't fire, click the real send button.
          setTimeout(function () {
            var btn = document.querySelector("button.send-btn");
            if (btn && !btn.disabled) { btn.click(); log("clicked send-btn as fallback"); }
          }, 1200);
        }, ${typeDelayMs});
      }, 250);
    })();
  `;
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
    console.error("Usage: --url <page> --session-space <spaceId> --session-json <path> [--type <text>] [--wait ms] [--out file.png]");
    process.exit(1);
  }

  const session = JSON.parse(fs.readFileSync(args["session-json"], "utf8"));
  const injector = buildInjector({
    sessionKey: `naelao_product_session:${args["session-space"]}`,
    sessionValue: JSON.stringify(session),
    text: args.type ?? "",
    typeDelayMs: Number(args["type-delay"] ?? 800),
  });

  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering`;
  const headers = { authorization: `Bearer ${apiToken}`, "content-type": "application/json" };
  // domcontentloaded, not networkidle0: the session has to land in localStorage BEFORE the app
  // hydrates, or the shell's own auth guard bounces to /login first.
  const common = {
    url: args.url,
    viewport: { width: Number(args.width ?? 1400), height: Number(args.height ?? 950) },
    gotoOptions: { waitUntil: "domcontentloaded", timeout: 45000 },
    addScriptTag: [{ content: injector }],
    waitForTimeout: Number(args.wait ?? 45000),
  };

  // The rendered text tells you what actually happened; the screenshot shows how it looked.
  const contentRes = await fetch(`${base}/content`, {
    method: "POST",
    headers,
    body: JSON.stringify(common),
  });
  const contentJson = await contentRes.json().catch(() => ({}));
  if (!contentRes.ok || contentJson.success === false) {
    console.error("content failed:", contentRes.status, JSON.stringify(contentJson).slice(0, 600));
  } else {
    const html = contentJson.result ?? "";
    const text = html
      .replace(/<script[\s\S]*?<\/script>/g, " ")
      .replace(/<style[\s\S]*?<\/style>/g, " ")
      .replace(/<[^>]+>/g, "\n")
      .replace(/&nbsp;/g, " ")
      .replace(/\n{2,}/g, "\n")
      .trim();
    console.log("--- VISIBLE TEXT ---");
    console.log(text.slice(-4000));
    fs.writeFileSync(args["text-out"] ?? "/tmp/shell-interact-text.txt", text);
  }

  const shotRes = await fetch(`${base}/screenshot`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...common, screenshotOptions: { fullPage: false } }),
  });
  if (!shotRes.ok) {
    console.error("screenshot failed:", shotRes.status, (await shotRes.text()).slice(0, 400));
    process.exit(1);
  }
  const out = args.out ?? "shell-interact.png";
  fs.writeFileSync(out, Buffer.from(await shotRes.arrayBuffer()));
  console.log("screenshot →", out);
}

main().catch((e) => { console.error(e); process.exit(1); });
