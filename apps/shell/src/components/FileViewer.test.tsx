import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FileViewer } from "./FileViewer";
import type { WorkspaceFileContent } from "@/lib/api";

describe("FileViewer spreadsheet boundaries", () => {
  it("offers spreadsheet binaries as downloads without invoking a workbook parser", () => {
    const file: WorkspaceFileContent = {
      path: "reports/quarterly.xlsx",
      content: "UEsDBA==",
      encoding: "base64",
      content_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    };

    const html = renderToStaticMarkup(<FileViewer file={file} />);

    expect(html).toContain("Preview isn’t available for this file type.");
    expect(html).toContain('download="quarterly.xlsx"');
    expect(html).toContain("data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,UEsDBA==");
    expect(html).not.toContain("Opening spreadsheet");
  });

  it("offers Word archives as downloads without invoking an archive or XML parser", () => {
    const file: WorkspaceFileContent = {
      path: "reports/notes.docx",
      content: "UEsDBA==",
      encoding: "base64",
      content_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    };

    const html = renderToStaticMarkup(<FileViewer file={file} />);

    expect(html).toContain('download="notes.docx"');
    expect(html).toContain("data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,UEsDBA==");
    expect(html).not.toContain("Opening document");
  });

  it("does not create a preview or download URL for content above the server limit", () => {
    const file: WorkspaceFileContent = {
      path: "reports/oversized.xlsx",
      content: "UEsDBA==",
      too_large: true,
      encoding: "base64",
      content_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    };

    const html = renderToStaticMarkup(<FileViewer file={file} />);

    expect(html).toContain("Too large to preview inline.");
    expect(html).not.toContain("data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(html).not.toContain("download=");
  });

  it("parses only the header and the 500 CSV rows the preview can show", () => {
    const file: WorkspaceFileContent = {
      path: "reports/large.csv",
      content: `name\n${Array.from({ length: 10_000 }, (_, i) => `row-${i}`).join("\n")}`,
    };
    const html = renderToStaticMarkup(<FileViewer file={file} />);

    expect(html.match(/<tr/g)).toHaveLength(501); // one header + at most 500 body rows
    expect(html).toContain("row-499");
    expect(html).not.toContain("row-500");
  });

  it("keeps pathological wide CSV rows within the 100-column preview limit", () => {
    const file: WorkspaceFileContent = {
      path: "reports/wide.csv",
      content: Array.from({ length: 2_000 }, (_, i) => `column-${i}`).join(","),
    };
    const html = renderToStaticMarkup(<FileViewer file={file} />);

    expect(html.match(/<th(?=[ >])/g)).toHaveLength(100);
    expect(html).not.toContain("column-100");
  });
});
