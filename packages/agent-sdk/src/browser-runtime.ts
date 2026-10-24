/** Browser observations are untrusted evidence, never task permissions. */
export type BrowserRuntimeEngine = "kitesurf" | "chromium";
export type BrowserActionKind = "click" | "type" | "select" | "scroll";
export interface BrowserRuntimeScope {
  tenantId: string; spaceId: string; projectId?: string; actorId: string; agentId: string;
  runId: string; sessionId: string; expiresAt: number;
  authorizedOrigins: readonly string[]; authorizedActions: readonly BrowserActionKind[];
  /** Host-authorized reusable website account; never an ambient Space credential. */
  connectionId?: string;
  maxTier: 4 | 5 | 6;
}
export interface BrowserObservedElement {
  handle: string; role: string; name: string; frameId: string;
  enabled: boolean; permittedActions: readonly BrowserActionKind[];
}
export interface BrowserObservation {
  schema: 1; sessionId: string; revision: string; engine: BrowserRuntimeEngine;
  url: string; title: string; text: string; elements: readonly BrowserObservedElement[];
  untrusted: true; capturedAt: number; expiresAt: number;
  screenshot?: { path: string; mimeType: "image/png"; bytes: number; sha256: string };
  features: { interactive: boolean; pixelAccurate: boolean; persistentLogin: boolean };
}
export interface BrowserScopedAction {
  actionId: string; observationRevision: string; type: BrowserActionKind;
  handle?: string; text?: string; value?: string; x?: number; y?: number;
}
export function validateBrowserScope(scope: BrowserRuntimeScope, now = Date.now()): void {
  const token = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
  if (!scope || ![scope.tenantId, scope.spaceId, scope.actorId, scope.agentId, scope.runId, scope.sessionId, ...(scope.projectId ? [scope.projectId] : [])].every((id) => typeof id === "string" && token.test(id))) throw new Error("browser_scope_invalid");
  if (scope.connectionId !== undefined && !token.test(scope.connectionId)) throw new Error("browser_connection_invalid");
  if (scope.actorId === "system" || !Number.isSafeInteger(scope.expiresAt) || scope.expiresAt <= now || scope.expiresAt > now + 3600_000) throw new Error("browser_scope_expired");
  if (![4, 5, 6].includes(scope.maxTier) || !Array.isArray(scope.authorizedOrigins) || scope.authorizedOrigins.length < 1 || scope.authorizedOrigins.length > 16) throw new Error("browser_grant_invalid");
  for (const origin of scope.authorizedOrigins) { const url = new URL(origin); if (!["https:", "http:"].includes(url.protocol) || url.origin !== origin || url.username || url.password) throw new Error("browser_origin_invalid"); }
  if (!Array.isArray(scope.authorizedActions) || scope.authorizedActions.some((action) => !["click", "type", "select", "scroll"].includes(action))) throw new Error("browser_action_grant_invalid");
}
export function assertBrowserUrl(scope: BrowserRuntimeScope, url: string): void {
  const destination = new URL(url);
  if (!["http:", "https:"].includes(destination.protocol) || !scope.authorizedOrigins.includes(destination.origin) || destination.username || destination.password) throw new Error("browser_origin_not_authorized");
}
export function assertBrowserAction(scope: BrowserRuntimeScope, observation: BrowserObservation, action: BrowserScopedAction, now = Date.now()): BrowserObservedElement | undefined {
  validateBrowserScope(scope, now);
  if (observation.schema !== 1 || observation.untrusted !== true || observation.sessionId !== scope.sessionId || !Number.isSafeInteger(observation.expiresAt) || observation.expiresAt <= now || action.observationRevision !== observation.revision) throw new Error("browser_observation_stale");
  if (typeof action.actionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(action.actionId) || !scope.authorizedActions.includes(action.type)) throw new Error("browser_action_not_authorized");
  assertBrowserUrl(scope, observation.url);
  if (action.type === "scroll") { if (![action.x ?? 0, action.y ?? 0].every((coordinate) => Number.isFinite(coordinate) && Math.abs(coordinate) <= 2000)) throw new Error("browser_scroll_limit"); return undefined; }
  const element = observation.elements.find((candidate) => candidate.handle === action.handle);
  if (!element || !element.enabled || !element.permittedActions.includes(action.type)) throw new Error("browser_handle_not_authorized");
  if (action.type === "type" && (typeof action.text !== "string" || action.text.length > 8192)) throw new Error("browser_type_limit");
  if (action.type === "select" && (typeof action.value !== "string" || action.value.length > 1024)) throw new Error("browser_select_limit");
  return element;
}
export function browserEngineFor(scope: BrowserRuntimeScope, needs: { visual?: boolean; webgl?: boolean; persistentLogin?: boolean }): { engine: BrowserRuntimeEngine; reason?: string } {
  const reason = needs.visual ? "pixel_accuracy_required" : needs.webgl ? "webgl_required" : needs.persistentLogin ? "persistent_authenticated_session" : undefined;
  if (reason && scope.maxTier < 5) throw new Error("browser_escalation_exceeds_ceiling");
  return { engine: reason ? "chromium" : "kitesurf", ...(reason ? { reason } : {}) };
}
