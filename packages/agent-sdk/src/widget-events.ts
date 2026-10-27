/** Host-created event types that extensions may request for chat widgets. */
export const WIDGET_EVENT_TYPES = [
  "workspace.file.created", "workspace.file.updated", "workspace.file.deleted",
  "worker.dispatched", "worker.waiting", "worker.completed", "worker.failed",
  "task.blocked", "task.resumed", "approval.requested", "approval.resolved",
  "artifact.created", "artifact.updated", "workflow.started", "workflow.completed", "workflow.failed",
  "connection.handoff_required",
] as const;
export type WidgetEventType = typeof WIDGET_EVENT_TYPES[number];
export interface WidgetHostEvent {
  version: 1;
  id: string;
  type: WidgetEventType;
  spaceId: string;
  projectId?: string;
  conversationId: string;
  taskId?: string;
  occurredAt: string;
  /** A bounded host-selected payload; consumers must treat all values as untrusted. */
  data: Readonly<Record<string, string | number | boolean | null>>;
}
const id = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,191}$/.test(value);
const eventTypes = new Set<string>(WIDGET_EVENT_TYPES);

export function validateWidgetHostEvent(input: unknown): WidgetHostEvent {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("widget_event_invalid");
  const event = input as Record<string, unknown>;
  const allowed = new Set(["version", "id", "type", "spaceId", "projectId", "conversationId", "taskId", "occurredAt", "data"]);
  if (Object.keys(event).some(key => !allowed.has(key)) || event.version !== 1 || !id(event.id) || !id(event.spaceId) || !id(event.conversationId)
    || (event.projectId !== undefined && !id(event.projectId)) || (event.taskId !== undefined && !id(event.taskId))
    || typeof event.type !== "string" || !eventTypes.has(event.type) || typeof event.occurredAt !== "string" || !Number.isFinite(Date.parse(event.occurredAt))) throw new Error("widget_event_invalid");
  if (!event.data || typeof event.data !== "object" || Array.isArray(event.data)) throw new Error("widget_event_data_invalid");
  const entries = Object.entries(event.data as Record<string, unknown>);
  if (entries.length > 32 || entries.some(([key, value]) => !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) || !(value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)) || (typeof value === "string" && value.length <= 2000)))) throw new Error("widget_event_data_invalid");
  return { version: 1, id: event.id, type: event.type as WidgetEventType, spaceId: event.spaceId, conversationId: event.conversationId,
    ...(typeof event.projectId === "string" ? { projectId: event.projectId } : {}), ...(typeof event.taskId === "string" ? { taskId: event.taskId } : {}),
    occurredAt: event.occurredAt, data: Object.fromEntries(entries) as Record<string, string | number | boolean | null> };
}

/** Only a host-verified installation scope and its declared event grants may be passed here. */
export function widgetSubscriptionAllows(event: WidgetHostEvent, installation: { spaceId: string; projectId?: string; allowedEvents: readonly WidgetEventType[] }): boolean {
  return event.spaceId === installation.spaceId && (installation.projectId === undefined || event.projectId === installation.projectId) && installation.allowedEvents.includes(event.type);
}
