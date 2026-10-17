type ChannelContext = {
  channel: {
    event: { payload: Readonly<Record<string, unknown>> };
    answer(input: { question: string }): Promise<{ answerId: string }>;
    session?: {
      get(): Promise<unknown>;
      set(value: unknown): Promise<{ saved: true }>;
    };
    sessions?: {
      get(sessionId: string): Promise<unknown>;
      set(sessionId: string, value: unknown): Promise<{ saved: true }>;
    };
  };
};

/** Restricted public handler example. Provider delivery, Knowledge retrieval, and persistence
 * remain host-owned; this script only requests a grounded answer and updates its own small state. */
export async function run(_args: Record<string, never>, ctx: ChannelContext) {
  const payload = ctx.channel.event.payload;
  const question =
    typeof payload.text === "string" ? payload.text.trim().slice(0, 2_000) : "";
  if (!question) return { accepted: false };

  if (ctx.channel.session) {
    const previous = await ctx.channel.session.get();
    const turns =
      previous &&
      typeof previous === "object" &&
      Number.isInteger((previous as { turns?: unknown }).turns)
        ? Math.max(
            0,
            Math.min(10_000, Number((previous as { turns: number }).turns))
          )
        : 0;
    await ctx.channel.session.set({
      turns: turns + 1,
      lastQuestionAt: new Date().toISOString(),
    });
  }
  // Extensions may keep several bounded records for one verified external conversation. The
  // host scopes each key to this project, installation and conversation; it is not a provider
  // contact ID and does not grant access to other users' sessions.
  if (ctx.channel.sessions) {
    const progress = await ctx.channel.sessions.get("lesson_progress");
    const lessonsCompleted = progress && typeof progress === "object" && Number.isInteger((progress as { lessonsCompleted?: unknown }).lessonsCompleted)
      ? Math.max(0, Math.min(10_000, Number((progress as { lessonsCompleted: number }).lessonsCompleted))) : 0;
    await ctx.channel.sessions.set("lesson_progress", { lessonsCompleted, lastQuestionAt: new Date().toISOString() });
  }

  // The host searches only this package's owner-published collections and supplies up to three
  // source excerpts. If none match or search fails, dispatch goes to human review before this runs.
  const request = await ctx.channel.answer({ question });
  return { accepted: true, answerId: request.answerId };
}
