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
    expect(markup).toContain("supported SpaceDO rows, listed workspace/extension objects");
    expect(markup).toContain("safe per-Project main runtime profiles and inert restart recipe configuration");
    expect(markup).toContain("signed shared/project MicroApp data, action receipts and events");
    expect(markup).toContain("1 MiB per MicroApp actor");
    expect(markup).toContain("4 MiB total MicroApp data");
    expect(markup).toContain("runtime allocations, live observations, provider snapshots");
    expect(markup).toContain("recipes remain manual and never execute");
    expect(markup).toContain("local-machine, shared-filesystem and Project Knowledge grants");
    expect(markup).toContain("Reapprove grants after recovery");
    expect(markup).toContain("8 MiB encrypted-manifest plaintext");
    expect(markup).toContain("10,000 rows per table");
    expect(markup).toContain("16 MiB per object");
    expect(markup).toContain("64 MiB total captured object bytes");
  });
});
