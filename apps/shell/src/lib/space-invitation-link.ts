export interface SpaceInvitationLinkPayload { spaceId: string; invitationId: string; token: string; }

export function buildSpaceInvitationLink(input: SpaceInvitationLinkPayload & { origin: string; productSlug: string }): string {
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(input.spaceId) || !/^[A-Za-z0-9_-]{1,160}$/.test(input.invitationId)
    || !/^[A-Za-z0-9_-]{40,48}$/.test(input.token) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(input.productSlug)) {
    throw new TypeError("space_invitation_link_invalid");
  }
  const url = new URL("/p/" + encodeURIComponent(input.productSlug) + "/accept-invitation", input.origin);
  url.hash = new URLSearchParams({ space_id: input.spaceId, invitation_id: input.invitationId, token: input.token }).toString();
  return url.toString();
}

export function parseSpaceInvitationFragment(hash: string): SpaceInvitationLinkPayload | null {
  if (hash.length > 512) return null;
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const spaceId = params.get("space_id") ?? "";
  const invitationId = params.get("invitation_id") ?? "";
  const token = params.get("token") ?? "";
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(spaceId) || !/^[A-Za-z0-9_-]{1,160}$/.test(invitationId)
    || !/^[A-Za-z0-9_-]{40,48}$/.test(token)) return null;
  return { spaceId, invitationId, token };
}
