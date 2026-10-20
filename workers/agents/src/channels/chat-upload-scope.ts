import { mintInternalToken } from "@naelao/http";

export interface ChatUploadScope {
  projectId?: string;
}

/** Resolve the session's canonical workspace before reading or writing upload objects. */
export async function resolveChatUploadScope(input: {
  platformSecret: string;
  tenantId: string;
  spaceId: string;
  sessionId: string;
  userId: string;
  callerRole: string;
  fetchSpaces(request: Request): Promise<Response>;
}): Promise<ChatUploadScope | null> {
  const headers = {
    "x-naelao-tenant-id": input.tenantId,
    "x-naelao-user-id": input.userId,
    "x-naelao-role": input.callerRole,
    "x-naelao-internal-token": await mintInternalToken(
      input.platformSecret,
      input.tenantId
    ),
  };
  let response: Response;
  try {
    response = await input.fetchSpaces(
      new Request(
        `http://spaces-worker/spaces/${encodeURIComponent(input.spaceId)}/sessions/${encodeURIComponent(input.sessionId)}/compact-scope`,
        { headers }
      )
    );
  } catch {
    return null;
  }
  if (!response.ok) return null;

  let parsedScope: unknown;
  try {
    parsedScope = await response.json();
  } catch {
    return null;
  }
  if (
    !parsedScope ||
    typeof parsedScope !== "object" ||
    Array.isArray(parsedScope)
  )
    return null;
  const scope = parsedScope as {
    project_id?: unknown;
    private_scratchpad?: unknown;
  };
  if (scope.private_scratchpad === true) return null;
  if (
    scope.project_id !== null &&
    scope.project_id !== undefined &&
    (typeof scope.project_id !== "string" || scope.project_id.length > 128)
  )
    return null;
  const projectId =
    typeof scope.project_id === "string" ? scope.project_id : undefined;

  if (projectId) {
    try {
      const project = await input.fetchSpaces(
        new Request(
          `http://spaces-worker/spaces/${encodeURIComponent(input.spaceId)}/projects/${encodeURIComponent(projectId)}`,
          { headers }
        )
      );
      if (!project.ok) return null;
    } catch {
      return null;
    }
  }
  return projectId ? { projectId } : {};
}
