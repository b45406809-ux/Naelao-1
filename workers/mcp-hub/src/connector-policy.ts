export type ConnectorScope = "space_shared" | "project_bound" | "user_personal";

export const REQUIRED_TOOL_SCOPES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  send_email: ["email.send"],
  delete_email: ["email.modify"],
  create_calendar_event: ["calendar.events.write"],
  update_calendar_event: ["calendar.events.write"],
  delete_calendar_event: ["calendar.events.write"],
});

export function missingToolScopes(toolName: string, granted: readonly string[]): string[] {
  const present = new Set(granted);
  return [...(REQUIRED_TOOL_SCOPES[toolName] ?? [])].filter((scope) => !present.has(scope));
}

export interface ScopedConnector {
  connectorId: string;
  scope: ConnectorScope;
  projectId?: string;
  userId?: string;
}

/** Pure form of the database resolver, used to keep background-user denial independently tested. */
export function resolveScopedConnector(
  rows: readonly ScopedConnector[],
  execution: { projectId?: string; userId?: string }
): ScopedConnector | undefined {
  return rows
    .filter((row) => row.scope === "space_shared"
      || (row.scope === "project_bound" && Boolean(execution.projectId) && row.projectId === execution.projectId)
      || (row.scope === "user_personal" && Boolean(execution.userId) && row.userId === execution.userId))
    .sort((a, b) => ({ space_shared: 1, project_bound: 2, user_personal: 3 })[b.scope]
      - ({ space_shared: 1, project_bound: 2, user_personal: 3 })[a.scope])[0];
}
