// Model switcher preference storage (Claude Code's own "pick a model for this session" UX,
// applied here per-space rather than globally). Deliberately localStorage, not sessionStorage
// (chatSession.ts's scope) — a model choice is a durable preference a user expects to persist
// across tabs and reloads, not per-tab transient state like an in-flight run id.
//
// This is NOT the same thing as updateModelConfig (api.ts) — that PATCHes the business's own
// stored default model (a builder/business-admin setting everyone gets by default). This is a
// purely client-side override for what THIS signed-in user's own messages run on, same relationship
// Claude Code's own per-session model picker has to an org-wide default.

function modelStorageKey(spaceId: string): string {
  return `naelao_preferred_model:${spaceId}`;
}

function reasoningStorageKey(spaceId: string, model: string): string {
  return `naelao_preferred_reasoning:${spaceId}:${model}`;
}

export function getPreferredModel(spaceId: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(modelStorageKey(spaceId));
  } catch {
    return null;
  }
}

export function storePreferredModel(spaceId: string, model: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(modelStorageKey(spaceId), model);
  } catch {
    /* ignore */
  }
}

/** Reasoning level is stored PER MODEL (not just per space) — different models offer different
 *  level sets, and a level chosen for one model is meaningless (or invalid) for another. */
export function getPreferredReasoningLevel(spaceId: string, model: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(reasoningStorageKey(spaceId, model));
  } catch {
    return null;
  }
}

export function storePreferredReasoningLevel(spaceId: string, model: string, level: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(reasoningStorageKey(spaceId, model), level);
  } catch {
    /* ignore */
  }
}

// Effort (billing-core's EffortLevel) supersedes the raw reasoning-level preference above as the
// thing a person actually sets — the model's own native reasoning param is now DERIVED from
// Effort (nativeReasoningForEffort), not chosen directly. Still stored per (space, model), same
// reasoning as reasoningStorageKey: a level valid for one model may not exist on another's ladder.

function effortStorageKey(spaceId: string, model: string): string {
  return `naelao_preferred_effort:${spaceId}:${model}`;
}

export function getPreferredEffort(spaceId: string, model: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(effortStorageKey(spaceId, model));
  } catch {
    return null;
  }
}

export function storePreferredEffort(spaceId: string, model: string, effort: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(effortStorageKey(spaceId, model), effort);
  } catch {
    /* ignore */
  }
}
