type CustomerChannelContext = {
  channel: {
    event: { payload: Readonly<Record<string, unknown>> };
    answer(input: { question: string }): Promise<{ answerId: string }>;
    session?: {
      get(): Promise<unknown>;
      set(value: unknown): Promise<{ saved: true }>;
    };
  };
};

function needsStaffReview(message: string): boolean {
  return [
    /\b(?:speak|talk|connect|transfer)\s+(?:to\s+)?(?:a\s+)?(?:human|person|agent|staff|representative)\b/i,
    /\b(?:refund|chargeback|cancel(?:lation)?|complaint|complain|fraud|scam|unauthorized charge|charged twice)\b/i,
    /\b(?:my\s+)?(?:order|delivery|booking|appointment|payment|invoice|account)\s+(?:status|where|when|missing|late|wrong|charged|cancel(?:led|ed)?)\b/i,
    /\b(?:urgent|emergency|unsafe|dangerous|injured|allergic reaction|safety issue)\b/i,
  ].some((pattern) => pattern.test(message));
}

/**
 * Example channel-only handler. The host retrieves only the declared, owner-published
 * `support_articles` collection when an answer is requested. This handler has no tools,
 * provider credentials, member identity, or project file access.
 */
export async function run(_args: Record<string, never>, ctx: CustomerChannelContext) {
  const rawMessage = ctx.channel.event.payload.text;
  const message = typeof rawMessage === "string"
    ? rawMessage.replace(/\s+/g, " ").trim().slice(0, 2_000)
    : "";

  if (!message || needsStaffReview(message)) {
    // Do not call reply() or answer(). Live dispatch treats zero channel outputs as a
    // staff-review handoff; the returned object is informational and is not the handoff API.
    return { outcome: "staff_review" as const };
  }

  if (ctx.channel.session) {
    const previous = await ctx.channel.session.get();
    const stored = previous && typeof previous === "object"
      ? (previous as { answeredGeneralQuestions?: unknown }).answeredGeneralQuestions
      : undefined;
    const count = Number.isSafeInteger(stored) ? Math.max(0, Math.min(99_999, Number(stored))) : 0;
    // Store only a bounded counter. Do not keep names, phone numbers, message text or account data.
    await ctx.channel.session.set({ answeredGeneralQuestions: Math.min(100_000, count + 1) });
  }

  const request = await ctx.channel.answer({ question: message });
  return { outcome: "answer_requested" as const, answerId: request.answerId };
}
