import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { Env } from "../env.js";

export interface ScheduledReminderParams { spaceId: string; tenantId: string; from?: string; }
export interface ReminderResult { scanned: number; called: number; updated: number; }

type CalendarEvent = { id: string; start_at: string; phone: string };

/** Class 1 scheduled workflow: deterministic orchestration, no conversational agent loop. */
export class ScheduledReminderWorkflow extends WorkflowEntrypoint<Env, ScheduledReminderParams> {
  async run(event: WorkflowEvent<ScheduledReminderParams>, step: WorkflowStep): Promise<ReminderResult> {
    const from = event.payload.from ?? new Date().toISOString();
    const to = new Date(Date.parse(from) + 24 * 60 * 60 * 1000).toISOString();
    const events = await step.do("query-tomorrows-confirmed-bookings", async () => {
      const response = await this.env.SPACES_WORKER.fetch(`http://spaces-do/internal/calendar/reminders?space_id=${encodeURIComponent(event.payload.spaceId)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
      if (!response.ok) throw new Error(`Calendar reminder query failed (${response.status})`);
      const rows = (await response.json<{ events: Array<{ id: string; start_at: string; client_details: { phone?: string; phone_number?: string } }> }>()).events;
      return rows.map((row) => ({ id: row.id, start_at: row.start_at, phone: String(row.client_details.phone ?? row.client_details.phone_number ?? "") }));
    });
    let called = 0;
    let updated = 0;
    for (const appointment of events) {
      const phone = appointment.phone;
      if (!phone || !this.env.VOICE_CALLS) continue;
      const outcome = await step.do(`one-minute-reminder-${appointment.id}`, { retries: { limit: 2, delay: 1000, backoff: "exponential" }, timeout: "2 minutes" }, async () => {
        const response = await this.env.VOICE_CALLS!.fetch("https://calls.naelao/internal/outbound", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ to: phone, max_duration_seconds: 60, purpose: "appointment_reminder", appointment }),
        });
        if (!response.ok) throw new Error(`Outbound reminder failed (${response.status})`);
        const result = await response.json<{ response: "confirmed" | "reschedule_requested" }>();
        return result.response;
      });
      called++;
      const status = outcome === "reschedule_requested" ? "RESCHEDULE_REQUESTED" : "CONFIRMED";
      await step.do(`record-reminder-${appointment.id}`, async () => {
        const response = await this.env.SPACES_WORKER.fetch("http://spaces-do/internal/calendar/reminders/outcome", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event_id: appointment.id, status }),
        });
        if (!response.ok) throw new Error(`Reminder outcome update failed (${response.status})`);
        return { ok: true };
      });
      updated++;
    }
    return { scanned: events.length, called, updated };
  }
}
