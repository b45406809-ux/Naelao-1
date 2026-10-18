import { describe, expect, it } from "vitest";
import { splitWhatsAppExtensionWebhook } from "./whatsapp-extension-webhook.js";

describe("Meta WhatsApp extension webhooks", () => {
  it("splits each inbound message by verified phone-number metadata and preserves adapter context", () => {
    const messages = splitWhatsAppExtensionWebhook({ object: "whatsapp_business_account", entry: [{ id: "waba-1", changes: [{ field: "messages", value: {
      metadata: { phone_number_id: "123456789012345", display_phone_number: "+15550000000" },
      contacts: [{ wa_id: "15551234567" }], messages: [{ id: "wamid-1", from: "15551234567", type: "text", text: { body: "one" } },
        { id: "wamid-2", from: "15557654321", type: "text", text: { body: "two" } }],
    } }, { field: "statuses", value: { statuses: [{ id: "wamid-1", status: "read" }] } }] }] });
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ phoneNumberId: "123456789012345", payload: { entry: [{ changes: [{ value: {
      metadata: { phone_number_id: "123456789012345" }, contacts: [{ wa_id: "15551234567" }], messages: [{ id: "wamid-1" }],
    } }] }] } });
    expect(messages[1]?.payload.entry).toMatchObject([{ changes: [{ value: { messages: [{ id: "wamid-2" }] } }] }]);
  });

  it("ignores status-only, malformed and unsupported webhook payloads", () => {
    expect(splitWhatsAppExtensionWebhook(null)).toEqual([]);
    expect(splitWhatsAppExtensionWebhook({ object: "other", entry: [] })).toEqual([]);
    expect(splitWhatsAppExtensionWebhook({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "statuses", value: { statuses: [{}] } }] }] })).toEqual([]);
    expect(splitWhatsAppExtensionWebhook({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "bad" }, messages: [{}] } }] }] })).toEqual([]);
  });
});
