export type PresenceStatus = "active" | "idle" | "coding" | "reviewing" | "sleeping";

export interface MultiplayerPresencePayload {
  userId: string;
  userName: string;
  userAvatar: string;
  role: "HUMAN" | "ARCHITECT" | "DEV" | "REVIEW" | "GROWTH";
  status: PresenceStatus;
  currentFile?: string;
  cursorPosition?: { line: number; column: number };
  lastHeartbeat: number;
}

export interface WorkspaceMutationEvent {
  eventType: "file_changed" | "file_locked" | "file_unlocked" | "pr_opened" | "pr_merged";
  spaceId: string;
  projectId: string;
  filePath?: string;
  actorId: string;
  actorType: "human" | "agent";
  timestamp: string;
  metadata?: Record<string, any>;
}
