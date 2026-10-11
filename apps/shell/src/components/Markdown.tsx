"use client";

import * as React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { GeneratedWidget } from "@/components/widgets/GeneratedWidget";
import type { WorkflowReceiptCard as WorkflowReceipt } from "@naelao/agent-sdk";

function WorkflowReceiptCard({ card }: { card: WorkflowReceipt }): React.ReactElement {
  const status = card.status === "succeeded" ? "🟢 Succeeded" : card.status === "failed" ? "🔴 Failed" : "🟡 Cancelled";
  return <details className="workflow-receipt-card">
    <summary>⏰ Workflow Completed: {card.workflowName} | Status: {status} | Duration: {card.durationMs}ms | <span>Inspect Full Logs</span></summary>
    <div><p>{card.summary}</p><a href={card.logUrl} target="_blank" rel="noopener noreferrer">Open full logs</a><code>{card.runId}</code></div>
  </details>;
}

function parseReceipt(text: string): WorkflowReceipt | null {
  if (!text.startsWith("{\"kind\":\"workflow_receipt\"")) return null;
  try {
    const value = JSON.parse(text) as WorkflowReceipt;
    return value.kind === "workflow_receipt" && Array.isArray(value.lines) ? value : null;
  } catch { return null; }
}

/**
 * Chat text rendered as markdown.
 *
 * Until now every bubble rendered its content as a raw React text child, so an assistant reply
 * arrived with its `**bold**`, `- bullets` and ``` fences intact as literal characters — while
 * `packages/ui/src/styles.css` had been carrying finished styles for `.bubble p/ul/strong/em/
 * pre/code` the whole time with nothing ever emitting those elements.
 *
 * `react-markdown` rather than `marked`/`showdown` for one reason that matters here: it builds
 * React elements and never touches `dangerouslySetInnerHTML`. An agent in this product renders
 * web-fetched pages, customer emails and connector output into these bubbles — content this
 * platform explicitly treats as untrusted everywhere else — so a renderer that cannot inject HTML
 * at all is worth more than the bundle it costs. For the same reason `rehype-raw` is deliberately
 * NOT installed: inline HTML in markdown stays inert text.
 *
 * Links open in a new tab with `noopener noreferrer` — a chat reply is the one place in this app
 * where the href is routinely chosen by a model rather than by us.
 */

const COMPONENTS = {
  a: ({
    href,
    children,
  }: { href?: string | undefined; children?: React.ReactNode }) => {
    // Citation URLs are immutable stream markers, not navigable bucket URLs. Chat mounts the
    // authenticated CitationBadges resolver; Markdown only renders an inert escaped marker.
    if (href?.startsWith("citation:"))
      return <span className="citation-marker">{children}</span>;
    return (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
} as const;

function MarkdownImpl({ text, onAction }: { text: string; onAction?: (widgetId: string, value: unknown) => void }): React.ReactElement {
  const receipt = parseReceipt(text);
  if (receipt) return <WorkflowReceiptCard card={receipt} />;
  const parts = text.split(/(<ui_widget\s+type="[^"]+">[\s\S]*?<\/ui_widget>)/g);
  return (
    <>{parts.map((part, index) => { const match = part.match(/^<ui_widget\s+type="([^"]+)">([\s\S]*)<\/ui_widget>$/); if (!match) return <ReactMarkdown key={index} remarkPlugins={[remarkGfm]} components={COMPONENTS as never}>{part}</ReactMarkdown>; try { const json = JSON.parse(match[2]!); return <GeneratedWidget key={index} value={{ ...json, type: match[1] }} {...(onAction ? { onAction } : {})}/>; } catch { return <span key={index}>Invalid widget</span>; } })}</>
  );
}

/**
 * Memoised on the exact text. This renders on every tick of a reveal animation and on every poll
 * of a growing answer, and re-parsing an unchanged string each time is pure waste.
 */
export const Markdown = React.memo(MarkdownImpl, (a, b) => a.text === b.text && a.onAction === b.onAction);
