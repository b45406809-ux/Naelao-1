import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown";

describe("Markdown untrusted content boundaries", () => {
  it("does not render HTML or executable links from untrusted markdown", () => {
    const html = renderToStaticMarkup(<Markdown text={'<img src=x onerror="alert(1)"> [bad](javascript:alert(1))'} />);
    expect(html).not.toContain("<img");
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain("bad");
  });

  it("rejects malformed workflow receipts without crashing the renderer", () => {
    const text = JSON.stringify({ kind: "workflow_receipt", lines: [], workflowName: { toString: "bad" } });
    expect(() => renderToStaticMarkup(<Markdown text={text} />)).not.toThrow();
    expect(renderToStaticMarkup(<Markdown text={text} />)).not.toContain("workflow-receipt-card");
  });

  it("does not make non-HTTPS or protocol-relative receipt log links clickable", () => {
    const card = {
      kind: "workflow_receipt", runId: "run-1", workflowName: "nightly", status: "succeeded",
      durationMs: 12, logUrl: "//attacker.example/logs", summary: "done", collapsed: true,
      lines: ["Workflow completed", "Inspect logs"],
    };
    const html = renderToStaticMarkup(<Markdown text={JSON.stringify(card)} />);
    expect(html).toContain("Full log link unavailable");
    expect(html).not.toContain("href=\"//attacker.example");
  });

  it("renders a valid HTTPS workflow receipt", () => {
    const card = {
      kind: "workflow_receipt", runId: "run-1", workflowName: "nightly", status: "succeeded",
      durationMs: 12, logUrl: "https://logs.example/run-1", summary: "done", collapsed: true,
      lines: ["Workflow completed", "Inspect logs"],
    };
    const html = renderToStaticMarkup(<Markdown text={JSON.stringify(card)} />);
    expect(html).toContain('href="https://logs.example/run-1"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});
