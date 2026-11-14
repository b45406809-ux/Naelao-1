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

function normalizePhrase(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

function matchesLabel(input: string, label: string): boolean {
  const phrase = normalizePhrase(label);
  if (!phrase) return false;
  return ` ${normalizePhrase(input)} `.includes(` ${phrase} `);
}

/** Deterministic two-choice phone menu. Twilio speech is a single host-collected turn and routes
 * only when the owner enables it. This handler never calls an LLM, transfers, or dials calls. */
export async function run(_args: Record<string, never>, ctx: PhoneChannelContext) {
  const values = ctx.channel.settings?.values ?? {};
  const greeting = setting(values, "greeting", "Thank you for calling.", 160);
  const first = setting(values, "option_1_label", "Sales", 60);
  const second = setting(values, "option_2_label", "Support", 60);
  const payload = ctx.channel.event.payload;
  const voiceEvent = payload.voice_event;
  const speechEnabled = payload.provider === "twilio" && payload.speech_input_allowed === true;

  let response: { schema_version: 1; actions: Array<Record<string, string | number>> };
  if (voiceEvent === "call.received") {
    response = { schema_version: 1, actions: [{
      type: "gather", input: speechEnabled ? "dtmf speech" : "dtmf", digits: 1,
      text: `${greeting} Press 1 for ${first}${speechEnabled ? ` or say ${first}` : ""}. Press 2 for ${second}${speechEnabled ? ` or say ${second}` : ""}.`,
    }] };
  } else if (voiceEvent === "call.digits") {
    const digits = typeof payload.digits === "string" ? payload.digits : "";
    const text = digits === "1"
      ? setting(values, "option_1_response", "Please contact our sales team for help.", 240)
      : digits === "2"
        ? setting(values, "option_2_response", "Please contact our support team for help.", 240)
        : setting(values, "fallback_response", "Sorry, that selection is not available.", 240);
    response = { schema_version: 1, actions: [{ type: "say", text }, { type: "hangup" }] };
  } else if (voiceEvent === "call.speech" && speechEnabled && typeof payload.speech === "string") {
    const spoken = payload.speech.slice(0, 2_000);
    const matches = [matchesLabel(spoken, first), matchesLabel(spoken, second)];
    const text = matches[0] !== matches[1]
      ? setting(values, matches[0] ? "option_1_response" : "option_2_response", matches[0] ? "Please contact our sales team for help." : "Please contact our support team for help.", 240)
      : setting(values, "fallback_response", "Sorry, that selection is not available.", 240);
    response = { schema_version: 1, actions: [{ type: "say", text }, { type: "hangup" }] };
  } else {
    response = { schema_version: 1, actions: [{ type: "hangup" }] };
  }

  await ctx.channel.reply({ text: JSON.stringify(response) });
  return { accepted: true };
}
