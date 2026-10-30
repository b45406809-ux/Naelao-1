/** @deprecated Compatibility exports for older internal consumers. New code uses space-auth. */
export {
  requireSpaceMembership as requireBusinessMembership,
  resolveEndUserSpaceRole as resolveEndUserBusinessRole,
  spaceRoleKnowledgeMask as businessRoleKnowledgeMask,
} from "./space-auth.js";
export type { SpaceRole as BusinessRole } from "./space-auth.js";
