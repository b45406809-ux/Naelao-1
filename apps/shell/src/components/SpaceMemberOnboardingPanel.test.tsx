import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SpaceMemberOnboardingPanel } from "./SpaceMemberOnboardingPanel";

const session = { sessionToken: "cookie", endUserId: "owner-a" };

describe("SpaceMemberOnboardingPanel", () => {
  it("keeps invitations owner/admin-only and presents a truthful non-granting handoff", () => {
    const ownerMarkup = renderToStaticMarkup(<SpaceMemberOnboardingPanel spaceId="space-a" session={session}
      productSlug="product-a" canManage canInviteAdmin />);
    expect(ownerMarkup).toContain("Create copy-only invitation");
    expect(ownerMarkup).toContain("Optional builder-defined role proposal");
    expect(ownerMarkup).toContain("does not grant Project, app, Knowledge, channel, or spending access");
    expect(ownerMarkup).toContain("No email or SMS is sent.");
    expect(ownerMarkup).toContain("Administrator");

    const adminMarkup = renderToStaticMarkup(<SpaceMemberOnboardingPanel spaceId="space-a" session={session}
      productSlug="product-a" canManage canInviteAdmin={false} />);
    expect(adminMarkup).not.toContain("<option value=\"admin\">Administrator</option>");
  });

  it("shows members their self-scoped role surface without invitation controls", () => {
    const markup = renderToStaticMarkup(<SpaceMemberOnboardingPanel spaceId="space-a" session={session}
      productSlug="product-a" canManage={false} canInviteAdmin={false} />);
    expect(markup).toContain("Your template roles");
    expect(markup).toContain("do not grant Project, app, Knowledge, channel, or spending access");
    expect(markup).not.toContain("member-invite-email");
    expect(markup).not.toContain("Invitation status");
  });
});
