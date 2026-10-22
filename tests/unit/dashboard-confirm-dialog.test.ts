import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { ConfirmByTypingDialog } from "../../apps/dashboard/src/components/ConfirmByTypingDialog";

const dashboardRequire = createRequire(new URL("../../apps/dashboard/package.json", import.meta.url));
const React = dashboardRequire("react");
const { renderToStaticMarkup } = dashboardRequire("react-dom/server");

describe("ConfirmByTypingDialog accessibility structure", () => {
  it("renders a labelled modal alert dialog with an associated confirmation field", () => {
    const html = renderToStaticMarkup(React.createElement(ConfirmByTypingDialog, {
      title: "Delete product",
      description: "This cannot be undone.",
      confirmText: "Acme",
      actionLabel: "Delete permanently",
      busy: false,
      onConfirm: () => {},
      onCancel: () => {},
    }));

    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby=');
    expect(html).toContain('aria-describedby=');
    const fieldId = html.match(/<label for="([^"]+)"/)?.[1];
    expect(fieldId).toBeTruthy();
    expect(html).toContain(`id="${fieldId}"`);
  });
});
