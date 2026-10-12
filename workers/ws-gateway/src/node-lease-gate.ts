export interface NodeLeaseStatus {
  active?: boolean;
  holder_type?: string;
  holder_id?: string;
}

/** Human edits must not silently replace another human's active document node. */
export function blocksNodeEdit(status: NodeLeaseStatus, actorId: string): boolean {
  return status.active === true && status.holder_type === "HUMAN" && status.holder_id !== actorId;
}
