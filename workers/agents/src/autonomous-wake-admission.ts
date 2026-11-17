export type AutonomousWakeAdmission =
  | { allowed: true }
  | { allowed: false; status: 409 | 503; errorCode: "assistant_busy" | "active_run_status_unavailable"; activeRunId?: string | null };

/** A missing or malformed active-run answer cannot prove that dispatch is safe. */
export async function admitAutonomousWake(response: Response | null): Promise<AutonomousWakeAdmission> {
  if (!response?.ok) return { allowed: false, status: 503, errorCode: "active_run_status_unavailable" };
  try {
    const body = await response.json() as { active?: unknown; run_id?: unknown };
    if (typeof body.active !== "boolean") return { allowed: false, status: 503, errorCode: "active_run_status_unavailable" };
    if (body.active) return { allowed: false, status: 409, errorCode: "assistant_busy",
      activeRunId: typeof body.run_id === "string" ? body.run_id : null };
    return { allowed: true };
  } catch {
    return { allowed: false, status: 503, errorCode: "active_run_status_unavailable" };
  }
}
