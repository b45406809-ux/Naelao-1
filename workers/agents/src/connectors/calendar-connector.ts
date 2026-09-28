import { mintInternalToken } from "@naelao/http";

export type CalendarTool = "calendar.get_availability" | "calendar.create_booking" | "calendar.cancel_booking";
export interface CalendarConnectorContext {
  spaceId: string;
  tenantId: string;
  projectId?: string;
  userId?: string;
}

/** Resolves the logical primary_calendar alias for every call. This deliberately does not cache:
 * changing a Space's provider takes effect in every sibling project immediately. External
 * providers travel through MCP; the edge_sqlite provider uses SpaceDO's shared state plane. */
export class PrimaryCalendarConnector {
  constructor(private readonly services: { spacesWorker: Fetcher; mcpHubWorker: Fetcher; platformSecret: string }) {}

  async call(context: CalendarConnectorContext, tool: CalendarTool, input: Record<string, unknown>): Promise<unknown> {
    const token = await mintInternalToken(this.services.platformSecret, context.tenantId);
    const headers = {
      "content-type": "application/json", "x-naelao-tenant-id": context.tenantId,
      "x-naelao-internal-token": token, ...(context.projectId ? { "x-naelao-project-id": context.projectId } : {}),
      ...(context.userId ? { "x-naelao-user-id": context.userId } : {}),
    };
    const aliasUrl = `http://spaces-worker/internal/connector-aliases/primary_calendar?space_id=${encodeURIComponent(context.spaceId)}${context.projectId ? `&project_id=${encodeURIComponent(context.projectId)}` : ""}`;
    const resolution = await this.services.spacesWorker.fetch(new Request(aliasUrl, { headers }));
    const binding = resolution.ok
      ? await resolution.json<{ connector_id: string; scope: string }>()
      : { connector_id: "edge_sqlite", scope: "space_shared" };
    if (binding.scope !== "space_shared") throw new Error("primary_calendar must be space_shared");
    if (binding.connector_id !== "edge_sqlite") {
      const response = await this.services.mcpHubWorker.fetch(new Request(
        `http://mcp-hub/v1/spaces/${encodeURIComponent(context.spaceId)}/connector-aliases/primary_calendar/tools/call`,
        { method: "POST", headers, body: JSON.stringify({ tool_name: tool, input }) }));
      const result = await response.json<unknown>();
      if (!response.ok) throw new Error(`primary_calendar provider failed: ${response.status}`);
      return result;
    }
    return this.callLocal(context.spaceId, tool, input, headers);
  }

  private async callLocal(spaceId: string, tool: CalendarTool, input: Record<string, unknown>, headers: Record<string, string>): Promise<unknown> {
    let request: Request;
    if (tool === "calendar.get_availability") {
      const query = new URLSearchParams({ space_id: spaceId, calendar_id: String(input["calendarId"] ?? "primary"), start_date: String(input["startDate"] ?? ""), end_date: String(input["endDate"] ?? "") });
      request = new Request(`http://spaces-worker/internal/primary-calendar/availability?${query}`, { headers });
    } else if (tool === "calendar.create_booking") {
      request = new Request("http://spaces-worker/internal/primary-calendar/bookings", { method: "POST", headers, body: JSON.stringify({ space_id: spaceId, calendar_id: input["calendarId"] ?? "primary", slot: input["slot"], client_details: input["clientDetails"] ?? {} }) });
    } else {
      const bookingId = String(input["bookingId"] ?? "");
      request = new Request(`http://spaces-worker/internal/primary-calendar/bookings/${encodeURIComponent(bookingId)}?space_id=${encodeURIComponent(spaceId)}`, { method: "DELETE", headers });
    }
    const response = await this.services.spacesWorker.fetch(request);
    const result = await response.json<unknown>();
    if (!response.ok) throw new Error(`primary_calendar edge fallback failed: ${response.status}`);
    return result;
  }
}
