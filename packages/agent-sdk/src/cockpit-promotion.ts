export type CockpitMode = "solo_cockpit" | "multiplayer_office";

export interface CockpitPromotionState {
  mode: CockpitMode;
  promotionVersion: number;
  promotedAt: string | null;
  promotedBy: string | null;
}

/** The transition changes metadata only; all conversation and artifact identities remain intact. */
export function promoteCockpit(
  state: CockpitPromotionState,
  actorId: string | null,
  promotedAt: string,
): CockpitPromotionState {
  if (state.mode === "multiplayer_office") return { ...state };
  return {
    mode: "multiplayer_office",
    promotionVersion: state.promotionVersion + 1,
    promotedAt,
    promotedBy: actorId,
  };
}
