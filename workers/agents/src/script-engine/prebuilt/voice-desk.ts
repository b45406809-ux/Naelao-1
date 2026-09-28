import type { VoiceAgentManifest } from "@naelao/agent-sdk";

export const VOICE_AGENT_MANIFEST: VoiceAgentManifest = {
  kind: "voice_agent",
  managementThreadTier: "tier_2_task",
  callThreadTier: "tier_3_consult",
  executionCeiling: 2,
  enabledTools: ["primary_calendar", "faq_search"],
};

export interface VoiceDeskContext {
  connectors: { use(name: "primary_calendar"): { get_availability(input: Record<string, unknown>): Promise<unknown>; book(input: Record<string, unknown>): Promise<unknown> } };
  concurrency: { acquireSlotHold(input: { slotKey: string; holderId: string; ttlMs: 15000 }): Promise<{ success: boolean; reason?: string }>; confirmSlotBooking(input: { slotKey: string; holderId: string }): Promise<{ success: boolean; reason?: string }>; releaseSlotHold(input: { slotKey: string; holderId: string }): Promise<unknown> };
}

export async function getVoiceDeskAvailability(ctx: VoiceDeskContext, input: Record<string, unknown>): Promise<unknown> {
  return ctx.connectors.use("primary_calendar").get_availability(input);
}

/** Consent is checked before any mutation; the serialized 15s hold always precedes booking. */
export async function confirmVoiceAppointment(ctx: VoiceDeskContext, input: {
  callSid: string; calendarId?: string; start: string; end: string; clientDetails: Record<string, unknown>; patientConsented: boolean;
}): Promise<{ confirmed: boolean; booking?: unknown; reason?: string }> {
  if (!input.patientConsented) return { confirmed: false, reason: "PATIENT_CONSENT_REQUIRED" };
  const slotKey = `${input.calendarId ?? "primary"}:${input.start}`;
  const hold = await ctx.concurrency.acquireSlotHold({ slotKey, holderId: input.callSid, ttlMs: 15000 });
  if (!hold.success) return { confirmed: false, reason: hold.reason ?? "SLOT_UNAVAILABLE" };
  try {
    const booking = await ctx.connectors.use("primary_calendar").book({ calendar_id: input.calendarId ?? "primary", slot: { start: input.start, end: input.end }, client_details: input.clientDetails });
    const committed = await ctx.concurrency.confirmSlotBooking({ slotKey, holderId: input.callSid });
    if (!committed.success) throw new Error(committed.reason ?? "Slot hold expired before confirmation");
    return { confirmed: true, booking };
  } catch (error) {
    await ctx.concurrency.releaseSlotHold({ slotKey, holderId: input.callSid });
    throw error;
  }
}
