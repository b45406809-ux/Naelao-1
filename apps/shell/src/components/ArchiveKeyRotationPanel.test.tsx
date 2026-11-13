import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ArchiveKeyRotationPanel } from "./ArchiveKeyRotationPanel";

describe("ArchiveKeyRotationPanel export caller", () => {
  it("does not render archive controls for a non-manager", () => {
    const markup = renderToStaticMarkup(<ArchiveKeyRotationPanel spaceId="space-a" session={{ sessionToken: "session", endUserId: "member-a" }} canManage={false} />);
    expect(markup).toBe("");
  });

  it("shows the owner/admin full export action with scope and size limits", () => {
    const markup = renderToStaticMarkup(<ArchiveKeyRotationPanel spaceId="space-a" session={{ sessionToken: "session", endUserId: "owner-a" }} canManage={true} />);
    expect(markup).toContain("Create encrypted full archive");
    expect(markup).toContain("supported SpaceDO rows and listed workspace/extension objects");
    expect(markup).toContain("provider data and opaque Container snapshots");
    expect(markup).toContain("8 MiB plaintext");
    expect(markup).toContain("10,000 rows per table");
  });
});
