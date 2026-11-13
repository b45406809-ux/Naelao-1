type Settings = Readonly<Record<string, string | number | boolean>>;

type PhoneChannelContext = {
  channel: {
    event: { payload: Readonly<Record<string, unknown>> };
    settings?: { values: Settings };
    reply(message: { text: string }): Promise<unknown>;
  };
};

function setting(values: Settings, key: string, fallback: string, maximum: number): string {
  const value = values[key];
  return typeof value === "string" ? value.trim().slice(0, maximum) || fallback : fallback;
}

/** Deterministic two-choice keypad menu. It does not call an LLM, collect speech, transfer calls,
 * or dial another number. The host validates the data-only response and renders carrier actions. */
export async function run(_args: Record<string, never>, ctx: PhoneChannelContext) {
  const values = ctx.channel.settings?.values ?? {};
  const greeting = setting(values, "greeting", "Thank you for calling.", 160);
  const first = setting(values, "option_1_label", "Sales", 60);
  const second = setting(values, "option_2_label", "Support", 60);
  const payload = ctx.channel.event.payload;
  const voiceEvent = payload.voice_event;

  let response: { schema_version: 1; actions: Array<Record<string, string | number>> };
  if (voiceEvent === "call.received") {
    response = { schema_version: 1, actions: [{
      type: "gather", input: "dtmf", digits: 1,
      text: `${greeting} Press 1 for ${first}. Press 2 for ${second}.`,
    }] };
  } else if (voiceEvent === "call.digits") {
    const digits = typeof payload.digits === "string" ? payload.digits : "";
    const text = digits === "1"
      ? setting(values, "option_1_response", "Please contact our sales team for help.", 240)
      : digits === "2"
        ? setting(values, "option_2_response", "Please contact our support team for help.", 240)
        : setting(values, "fallback_response", "Sorry, that selection is not available.", 240);
    response = { schema_version: 1, actions: [{ type: "say", text }, { type: "hangup" }] };
  } else {
    response = { schema_version: 1, actions: [{ type: "hangup" }] };
  }

  await ctx.channel.reply({ text: JSON.stringify(response) });
  return { accepted: true };
}
