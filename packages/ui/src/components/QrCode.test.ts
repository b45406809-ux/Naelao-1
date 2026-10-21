import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { QrCode } from "./QrCode";

describe("QrCode", () => {
  it("renders SVG nodes and escapes attacker-controlled accessible labels as text", () => {
    const markup = renderToStaticMarkup(
      React.createElement(QrCode, {
        value: "https://example.test/?q=%3Cscript%3Ealert(1)%3C/script%3E",
        label: '<img src=x onerror="alert(1)">',
      })
    );

    expect(markup).toContain("<svg");
    expect(markup).toContain("<path d=\"");
    expect(markup).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(markup).not.toContain("<script>");
    expect(markup).not.toContain("<img src=x");
  });

  it("returns null when the QR encoder's input bound is exceeded", () => {
    const markup = renderToStaticMarkup(React.createElement(QrCode, { value: "x".repeat(214) }));
    expect(markup).toBe("");
  });
});
