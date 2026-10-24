import { resolveAssistantVoice, validateAssistantVoicePatch, type AssistantVoicePreferences } from "@naelao/agent-sdk";

type Row = { preferences_json: string; revision: number };
/** Internal DO handler. The gateway attests scope and authorizes the human before forwarding. */
export async function assistantVoiceSettings(storage: DurableObjectStorage, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const spaceId = url.searchParams.get("space_id") ?? "";
  const projectId = url.searchParams.get("project_id");
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(spaceId) || projectId !== null && !/^[a-zA-Z0-9_-]{1,128}$/.test(projectId))
    return Response.json({ error_code: "invalid_voice_scope" }, { status: 400 });
  const sql = storage.sql;
  if (projectId && !sql.exec("SELECT id FROM projects WHERE id=? AND space_id=? AND status!='archived'", projectId, spaceId).toArray().length)
    return Response.json({ error_code: "project_not_found" }, { status: 404 });
  const read = (scope: string) => sql.exec<Row>("SELECT preferences_json,revision FROM assistant_voice_preferences WHERE space_id=? AND scope_key=?", spaceId, scope).toArray()[0];
  const key = projectId ? `project:${projectId}` : "space";
  if (request.method === "PATCH") {
    let patch: Partial<AssistantVoicePreferences>, revision: number;
    try {
      const body = await request.json<{ preferences: unknown; revision: number }>();
      if (!body || Object.keys(body).some(k => !["preferences", "revision"].includes(k)) || !Number.isSafeInteger(body.revision) || body.revision < 0) throw new Error("invalid_revision");
      patch = validateAssistantVoicePatch(body.preferences); revision = body.revision;
      // Profiles must be created and authorized before references may be assigned.
      if (patch.voiceProfileId !== undefined && patch.voiceProfileId !== null)
        return Response.json({ error_code: "voice_profile_not_available" }, { status: 409 });
    } catch { return Response.json({ error_code: "invalid_voice_preferences" }, { status: 400 }); }
    const result = storage.transactionSync(() => {
      const current = read(key), base = read("space");
      if ((current?.revision ?? 0) !== revision) return "revision";
      if (projectId && !resolveAssistantVoice(base ? JSON.parse(base.preferences_json) : {}).allowProjectOverrides) return "locked";
      const merged = { ...(current ? JSON.parse(current.preferences_json) : {}), ...patch };
      sql.exec("INSERT INTO assistant_voice_preferences(space_id,scope_key,preferences_json,revision,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(space_id,scope_key) DO UPDATE SET preferences_json=excluded.preferences_json,revision=excluded.revision,updated_at=excluded.updated_at", spaceId, key, JSON.stringify(merged), revision + 1, new Date().toISOString());
      return "ok";
    });
    if (result !== "ok") return Response.json({ error_code: result === "revision" ? "voice_revision_conflict" : "voice_project_overrides_disabled" }, { status: 409 });
  }
  const current = read(key), base = projectId ? read("space") : current;
  const overrides = current ? JSON.parse(current.preferences_json) : {};
  return Response.json({
    preferences: resolveAssistantVoice(base ? JSON.parse(base.preferences_json) : {}, projectId ? overrides : undefined),
    overrides, revision: current?.revision ?? 0, inherited: !!projectId && !current,
  });
}
