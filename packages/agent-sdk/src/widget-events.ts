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
/** Safe, display-only output returned by a pure extension widget handler. It has no buttons,
 * links, HTML or tool actions: consequential interactions must go through Naelao's normal
 * permission and approval paths. */
export interface ExtensionWidgetView {
  title: string;
  body?: string;
  tone?: "neutral" | "success" | "warning" | "danger";
  fields?: ReadonlyArray<{ label: string; value: string }>;
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

export function validateExtensionWidgetView(input: unknown): ExtensionWidgetView {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("widget_view_invalid");
  const view = input as Record<string, unknown>;
  if (Object.keys(view).some(key => !["title", "body", "tone", "fields"].includes(key))
    || typeof view.title !== "string" || !view.title.trim() || view.title.length > 160
    || (view.body !== undefined && (typeof view.body !== "string" || view.body.length > 2_000))
    || (view.tone !== undefined && !["neutral", "success", "warning", "danger"].includes(String(view.tone)))) throw new Error("widget_view_invalid");
  let fields: Array<{ label: string; value: string }> | undefined;
  if (view.fields !== undefined) {
    if (!Array.isArray(view.fields) || view.fields.length > 12) throw new Error("widget_view_invalid");
    fields = view.fields.map(field => {
      if (!field || typeof field !== "object" || Array.isArray(field)) throw new Error("widget_view_invalid");
      const item = field as Record<string, unknown>;
      if (Object.keys(item).some(key => key !== "label" && key !== "value")
        || typeof item.label !== "string" || !item.label.trim() || item.label.length > 80
        || typeof item.value !== "string" || item.value.length > 500) throw new Error("widget_view_invalid");
      return { label: item.label, value: item.value };
    });
  }
  return { title: view.title.trim(), ...(typeof view.body === "string" ? { body: view.body } : {}),
    ...(view.tone !== undefined ? { tone: view.tone as NonNullable<ExtensionWidgetView["tone"]> } : {}), ...(fields ? { fields } : {}) };
}

/** Only a host-verified installation scope and its declared event grants may be passed here. */
export function widgetSubscriptionAllows(event: WidgetHostEvent, installation: { spaceId: string; projectId?: string; allowedProjectIds?: readonly string[]; allowedEvents: readonly WidgetEventType[] }): boolean {
  const projectAllowed = installation.projectId !== undefined ? event.projectId === installation.projectId
    : event.projectId === undefined || installation.allowedProjectIds?.includes(event.projectId) === true;
  return event.spaceId === installation.spaceId && projectAllowed && installation.allowedEvents.includes(event.type);
}
