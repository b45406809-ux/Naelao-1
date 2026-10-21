"use client";

// AVOS plan step 6 — a single, hardened HTML preview surface shared by every place this shell
// shows agent-generated/uploaded HTML (the Files panels, the Artifacts panel, and an artifact
// rendered inline in the chat transcript). Consolidates three previously-independent iframe
// implementations that had DRIFTED to three different sandbox postures — including
// InlineArtifactCard's `allow-scripts allow-same-origin`, a real, latent risk: a `srcDoc` iframe
// sandboxed with BOTH flags together is treated by the browser as sharing the PARENT document's
// origin, so a script embedded in agent-generated HTML (e.g. from a prompt-injected inbound
// message summarized into a report) could reach `window.parent` directly rather than being
// confined to postMessage. Every caller now gets the same, safe combination instead:
// `sandbox="allow-scripts"` alone — scripts run, but the iframe resolves to a NULL/opaque origin
// with no access to the parent's DOM/cookies/storage; the only channel out is postMessage, which
// is also exactly the mechanism the click-to-inspect feature below uses.
//
// `interactive` (default false) gates whether the click-to-inspect script is injected at all — it
// is only turned on by callers that know a listener actually exists (Chat.tsx's own `window`
// "message" handler, mounted for the lifetime of a conversation). Without it, this renders a
// genuinely read-only preview with no injected script, rather than an affordance that would
// silently do nothing on a page with no chat nearby (e.g. the project overview page's own Files
// list, which has no composer to pin a selection into).
//
// This deliberately does NOT attempt real source-file/line mapping ("Header.astro:42") — that
// needs a compiler emitting source maps into the DOM, and nothing on this platform does that;
// agent-generated HTML here is a flat file/artifact, not a tracked multi-file source project.
// What IS real and honest: a CSS-selector-shaped description (tag, id/class, position among
// siblings) plus a short text excerpt — exactly as much as a person clicking the same element
// could describe in words, not a fabricated precision the platform can't actually back up.

import * as React from "react";

const INSPECTOR_SCRIPT = `
(function () {
  var hovered = null;
  function describe(el) {
    if (!el || el === document.body || el === document.documentElement) return null;
    var tag = el.tagName ? el.tagName.toLowerCase() : "el";
    var id = el.id ? "#" + el.id : "";
    var cls = el.className && typeof el.className === "string"
      ? "." + el.className.trim().split(/\\s+/).filter(Boolean).slice(0, 2).join(".")
      : "";
    var text = (el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 80);
    var idx = el.parentElement ? Array.prototype.indexOf.call(el.parentElement.children, el) : 0;
    var selector = tag + id + cls + (id ? "" : ":nth-child(" + (idx + 1) + ")");
    return { tag: tag, selector: selector, text: text };
  }
  document.addEventListener("mouseover", function (e) {
    if (hovered && hovered.style) hovered.style.outline = "";
    hovered = e.target;
    if (hovered && hovered.style && hovered !== document.body && hovered !== document.documentElement) {
      hovered.style.outline = "2px solid #6d5ef8";
      hovered.style.outlineOffset = "-1px";
    }
  }, true);
  document.addEventListener("click", function (e) {
    var d = describe(e.target);
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      window.parent.postMessage({ type: "AVOS_DOM_CLICK", selector: d.selector, tag: d.tag, text: d.text }, "*");
    } catch (err) { /* postMessage never throws in practice; ignore defensively */ }
  }, true);
})();`;

/**
 * Isolate previews from the shell page and give the inspector only its own one-time script
 * capability. User-authored HTML stays inside the frame; its scripts, event handlers, network
 * requests, forms, nested frames and top-level navigation are blocked by CSP and sandboxing.
 */
export function buildSandboxedPreviewDocument(html: string, interactive = false, nonce?: string): string {
  const trustedNonce = interactive && nonce && /^[a-f0-9]{32,128}$/i.test(nonce) ? nonce : undefined;
  const policy = [
    "default-src 'none'",
    trustedNonce ? `script-src 'nonce-${trustedNonce}'` : "script-src 'none'",
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "font-src data:",
    "media-src data: blob:",
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "navigate-to 'none'",
  ].join("; ");
  const inspector = trustedNonce
    ? `<script nonce="${trustedNonce}">${INSPECTOR_SCRIPT}</script>`
    : "";
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer"></head><body>${html}${inspector}</body></html>`;
}

function createNonce(): string | undefined {
  try {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    // Fail closed: preview remains visible, but the inspector script is omitted.
    return undefined;
  }
}

export interface InspectedElement {
  selector: string;
  tag: string;
  text: string;
}

export function HtmlPreviewFrame({
  html,
  title,
  height = 260,
  interactive = false,
}: {
  html: string;
  title?: string;
  height?: number;
  /** Injects the click-to-inspect script — only pass true when a Chat.tsx "message" listener is
   *  actually mounted somewhere on this page (see the header comment above). */
  interactive?: boolean;
}) {
  const [srcDoc, setSrcDoc] = React.useState("");
  React.useEffect(() => {
    const nonce = interactive ? createNonce() : undefined;
    setSrcDoc(buildSandboxedPreviewDocument(html, interactive, nonce));
  }, [html, interactive]);
  return (
    <iframe
      title={title ?? "Preview"}
      sandbox={interactive ? "allow-scripts" : ""}
      data-naelao-dom-inspector={interactive ? "true" : undefined}
      srcDoc={srcDoc}
      referrerPolicy="no-referrer"
      style={{ width: "100%", height, border: "1px solid var(--border)", borderRadius: 6, background: "#fff" }}
    />
  );
}
