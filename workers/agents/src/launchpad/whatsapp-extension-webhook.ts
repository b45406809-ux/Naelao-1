export interface WhatsAppExtensionWebhookMessage {
  phoneNumberId: string;
  payload: Record<string, unknown>;
}

/** Split one Meta app-level webhook into one adapter-ready payload per inbound message. */
export function splitWhatsAppExtensionWebhook(input: unknown): WhatsAppExtensionWebhookMessage[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  const payload = input as Record<string, unknown>;
  if (payload.object !== "whatsapp_business_account" || !Array.isArray(payload.entry)) return [];
  const result: WhatsAppExtensionWebhookMessage[] = [];
  for (const rawEntry of payload.entry) {
    if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) continue;
    const entry = rawEntry as Record<string, unknown>;
    if (!Array.isArray(entry.changes)) continue;
    for (const rawChange of entry.changes) {
      if (!rawChange || typeof rawChange !== "object" || Array.isArray(rawChange)) continue;
      const change = rawChange as Record<string, unknown>;
      if (change.field !== "messages" || !change.value || typeof change.value !== "object" || Array.isArray(change.value)) continue;
      const value = change.value as Record<string, unknown>;
      const metadata = value.metadata && typeof value.metadata === "object" && !Array.isArray(value.metadata)
        ? value.metadata as Record<string, unknown> : null;
      const phoneNumberId = typeof metadata?.phone_number_id === "string" ? metadata.phone_number_id : "";
      if (!/^\d{5,32}$/.test(phoneNumberId) || !Array.isArray(value.messages)) continue;
      for (const message of value.messages) {
        if (!message || typeof message !== "object" || Array.isArray(message)) continue;
        if (result.length >= 100) return result;
        result.push({ phoneNumberId, payload: { object: payload.object, entry: [{ id: entry.id, changes: [{ field: change.field,
          value: { ...value, messages: [message] } }] }] } });
      }
    }
  }
  return result;
}
