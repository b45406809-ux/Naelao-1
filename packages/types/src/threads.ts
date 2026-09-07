export type ThreadTier = 1 | 2 | 3 | 4;

export type ThreadKind =
  | "team_room"           // Tier 1: Main public collaborative channel
  | "task_workstation"    // Tier 2: Feature/DAG sprint thread bound to a Git branch
  | "system_consult"      // Tier 3: Collapsed background sub-agent coordination
  | "private_scratchpad"  // Tier 4: Personal 1-on-1 simulation sandbox
  | "heartbeat_wake"      // System: Scheduled cron background session
  | "voice_call";         // Telephony: Inbound/outbound phone call transcript

export interface AvosThread {
  id: string;
  spaceId: string;
  projectId: string;
  tier: ThreadTier;
  threadKind: ThreadKind;
  title: string;
  boundBranchName?: string;
  associatedTaskId?: string;
  sessionId?: string;
  parentThreadId?: string;
  isSimulationOnly: boolean; // True for Tier 4 scratchpads
  createdByUserId: string;
  status: "active" | "archived" | "completed";
  metadataJson: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateThreadParams {
  projectId: string;
  title: string;
  tier?: ThreadTier;
  threadKind?: ThreadKind;
  boundBranchName?: string;
  associatedTaskId?: string;
  sessionId?: string;
  parentThreadId?: string;
  isSimulationOnly?: boolean;
  createdByUserId: string;
  metadata?: Record<string, any>;
  spaceId?: string;
}

export interface ListThreadsQuery {
  projectId: string;
  tier?: ThreadTier;
  threadKind?: ThreadKind;
  parentThreadId?: string;
  includeArchived?: boolean;
  includeSystem?: boolean; // If false, hides Tier 3 system_consult and heartbeat_wake
  callerUserId: string;
}

export interface ThreadElevationStatus {
  projectId: string;
  isCockpitMode: boolean; // True if human member count <= 1
  memberCount: number;
  directMainWritesAllowed: boolean;
  activeTiers: ThreadTier[];
}
