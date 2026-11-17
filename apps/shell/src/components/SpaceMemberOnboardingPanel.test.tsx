import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SpaceMemberOnboardingPanel } from "./SpaceMemberOnboardingPanel";

const session = { sessionToken: "cookie", endUserId: "owner-a" };

describe("SpaceMemberOnboardingPanel", () => {
  it("keeps invitations owner/admin-only and presents a truthful non-granting handoff", () => {
    const ownerMarkup = renderToStaticMarkup(<SpaceMemberOnboardingPanel spaceId="space-a" session={session}
      productSlug="product-a" canManage canInviteAdmin members={[{ end_user_id: "owner-a", role: "owner", status: "active", joined_at: "2026-11-17" }]} />);
    expect(ownerMarkup).toContain("Create copy-only invitation");
    expect(ownerMarkup).toContain("Optional builder-defined role proposal");
    expect(ownerMarkup).toContain("does not grant Project, app, Knowledge, channel, or spending access");
    expect(ownerMarkup).toContain("No email or SMS is sent.");
    expect(ownerMarkup).toContain("Administrator");

    const adminMarkup = renderToStaticMarkup(<SpaceMemberOnboardingPanel spaceId="space-a" session={session}
      productSlug="product-a" canManage canInviteAdmin={false} members={[]} />);
    expect(adminMarkup).not.toContain("<option value=\"admin\">Administrator</option>");
  });

  it("shows members their self-scoped role surface without invitation controls", () => {
    const markup = renderToStaticMarkup(<SpaceMemberOnboardingPanel spaceId="space-a" session={session}
      productSlug="product-a" canManage={false} canInviteAdmin={false} members={[]} />);
    expect(markup).toContain("Your template roles");
    expect(markup).toContain("do not grant Project, app, Knowledge, channel, or spending access");
    expect(markup).not.toContain("member-invite-email");
    expect(markup).not.toContain("Invitation status");
  });

  it("offers owners only a non-granting role proposal flow for existing members", () => {
    const markup = renderToStaticMarkup(<SpaceMemberOnboardingPanel spaceId="space-a" session={session}
      productSlug="product-a" canManage canInviteAdmin={false} members={[
        { end_user_id: "member-a", role: "member", status: "active", joined_at: "2026-11-17" },
      ]} />);
    expect(markup).toContain("Assign onboarding guidance to an existing member");
    expect(markup).toContain("Record role proposal");
    expect(markup).toContain("does not apply Project, app, Knowledge, channel, assistant, or spending permissions");
  });
});
