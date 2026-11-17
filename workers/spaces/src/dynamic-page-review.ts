export interface PublicPageActionDraft { key: string; fields: string[] }
export interface PublicPageDraft { slug: string; html: string; actions: Record<string, PublicPageActionDraft> }

/** Canonical bounded page draft shared by owner review and final publication. */
export function validatePublicPageDraft(value: unknown): PublicPageDraft {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_public_page");
  const body = value as Record<string, unknown>;
  if (typeof body.slug !== "string" || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(body.slug)
    || typeof body.html !== "string" || !body.actions || typeof body.actions !== "object" || Array.isArray(body.actions)) throw new Error("invalid_public_page");
  if (new TextEncoder().encode(body.html).byteLength > 512_000 || /<\s*script\b|\bon[a-z]+\s*=|javascript\s*:/i.test(body.html))
    throw new Error("active_content_not_allowed");
  const actions: Record<string, PublicPageActionDraft> = {};
  const entries = Object.entries(body.actions as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0 || entries.length > 16) throw new Error("public_page_action_required");
  for (const [name, raw] of entries) {
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(name) || !raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid_public_page_action");
    const action = raw as Record<string, unknown>;
    if (Object.keys(action).some(key => key !== "key" && key !== "fields") || typeof action.key !== "string"
      || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(action.key) || !Array.isArray(action.fields) || action.fields.length > 32
      || !action.fields.every(field => typeof field === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(field))
      || new Set(action.fields).size !== action.fields.length) throw new Error("invalid_public_page_action");
    if (!body.html.includes(`{{NAELAO_ACTION_TOKEN:${name}}}`)) throw new Error("action_token_placeholder_missing");
    actions[name] = { key: action.key, fields: [...action.fields] as string[] };
  }
  return { slug: body.slug, html: body.html, actions };
}

export async function publicPageArtifactSha256(draft: PublicPageDraft): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(draft));
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
