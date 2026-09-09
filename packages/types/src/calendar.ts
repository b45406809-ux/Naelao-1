export type CalendarEventStatus = "CONFIRMED" | "CANCELLED" | "RESCHEDULED" | "COMPLETED";

export interface SpaceCalendarEvent {
  id: string;
  spaceId: string;
  projectId?: string;
  clientName: string;
  clientContact: string; // Email or Phone (E.164)
  eventType: string;     // e.g. "dental_cleaning", "consultation", "inspection"
  startTime: string;     // ISO-8601 UTC
  endTime: string;       // ISO-8601 UTC
  status: CalendarEventStatus;
  metadataJson: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

export interface SlotAvailabilityResult {
  available: boolean;
  conflictingEventId?: string;
  nextAvailableSlot?: string;
}
