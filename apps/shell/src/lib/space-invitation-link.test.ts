import { describe, expect, it } from "vitest";
import { buildSpaceInvitationLink, parseSpaceInvitationFragment } from "./space-invitation-link";

describe("copy-only Space invitation link", () => {
  it("keeps the bearer token in the URL fragment and round-trips only bounded fields", () => {
    const token = "A".repeat(43);
    const link = new URL(buildSpaceInvitationLink({ origin: "https://example.test", productSlug: "pharmacy",
      spaceId: "space-a", invitationId: "invite-a", token }));
    expect(link.pathname).toBe("/p/pharmacy/accept-invitation");
    expect(link.search).toBe("");
    expect(link.hash).toContain("token=" + token);
    expect(parseSpaceInvitationFragment(link.hash)).toEqual({ spaceId: "space-a", invitationId: "invite-a", token });
  });

  it("rejects malformed or partially copied credentials", () => {
    expect(parseSpaceInvitationFragment("#space_id=space-a&invitation_id=invite-a")).toBeNull();
    expect(() => buildSpaceInvitationLink({ origin: "https://example.test", productSlug: "pharmacy",
      spaceId: "space-a", invitationId: "invite-a", token: "short" })).toThrow("space_invitation_link_invalid");
  });
});
