export interface PhoneExtensionLineReadinessInput {
  status: string;
  handler_status: string | null;
  installation_id: string | null;
  handler_sha256: string | null;
  handler_candidates: readonly { installation_id: string; handler_sha256: string }[];
}

export type PhoneExtensionLineReadiness =
  | { state: "line_unavailable"; label: "Phone line unavailable" }
  | { state: "handler_unavailable"; label: "No active signed handler" }
  | { state: "handler_unverified"; label: "Assigned handler is not currently verified" }
  | { state: "ready"; label: "Ready for supported keypad events" };

/** A cached assignment is not enough; require a current candidate to match both pins. */
export function phoneExtensionLineReadiness(input: PhoneExtensionLineReadinessInput): PhoneExtensionLineReadiness {
  if (input.status !== "active") return { state: "line_unavailable", label: "Phone line unavailable" };
  if (input.handler_status !== "active") return { state: "handler_unavailable", label: "No active signed handler" };
  if (!input.installation_id || !/^[a-f0-9]{64}$/.test(input.handler_sha256 ?? "") ||
      !input.handler_candidates.some(candidate => candidate.installation_id === input.installation_id && candidate.handler_sha256 === input.handler_sha256))
    return { state: "handler_unverified", label: "Assigned handler is not currently verified" };
  return { state: "ready", label: "Ready for supported keypad events" };
}
