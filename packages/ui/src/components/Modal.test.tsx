import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Modal } from "./Modal";

describe("Modal accessibility contract", () => {
  it("renders a labelled modal dialog and does not expose closed content", () => {
    const open = renderToStaticMarkup(<Modal open onClose={() => {}} title="Confirm removal">Content</Modal>);
    expect(open).toContain('role="dialog"');
    expect(open).toContain('aria-modal="true"');
    expect(open).toMatch(/aria-labelledby="[^"]+"/);
    expect(open).toMatch(/<h3 id="[^"]+"[^>]*>Confirm removal<\/h3>/);

    expect(renderToStaticMarkup(<Modal open={false} onClose={() => {}} title="Hidden">Secret</Modal>)).toBe("");
  });
});
