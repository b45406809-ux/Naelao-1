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
<script>
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
    
    // Check if element or ancestor declares an MCP-UI action
    var actionEl = e.target.closest ? e.target.closest("[data-mcp-action], button, a, form") : null;
    var mcpAction = actionEl && actionEl.getAttribute ? actionEl.getAttribute("data-mcp-action") : null;
    var mcpPayload = actionEl && actionEl.getAttribute ? actionEl.getAttribute("data-mcp-payload") : null;
    
    if (mcpAction) {
      try {
        var parsedPayload = mcpPayload ? JSON.parse(mcpPayload) : { id: actionEl.id, text: d.text };
        window.parent.postMessage({
          type: "MCP_UI_ACTION",
          action: mcpAction,
          payload: parsedPayload,
          selector: d.selector,
          tag: d.tag
        }, "*");
      } catch (err) {}
    }

    e.preventDefault();
    e.stopPropagation();
    try {
      window.parent.postMessage({ type: "AVOS_DOM_CLICK", selector: d.selector, tag: d.tag, text: d.text }, "*");
    } catch (err) { /* postMessage never throws in practice; ignore defensively */ }
  }, true);
})();
</script>`;

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
  const srcDoc = interactive ? html + INSPECTOR_SCRIPT : html;
  return (
    <iframe
      title={title ?? "Preview"}
      sandbox="allow-scripts"
      srcDoc={srcDoc}
      style={{ width: "100%", height, border: "1px solid var(--border)", borderRadius: 6, background: "#fff" }}
    />
  );
}
