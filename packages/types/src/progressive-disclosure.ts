export type UIWorkspaceMode = "business_mode" | "developer_mode";

export interface UserWorkspacePreferences {
  userId: string;
  spaceId: string;
  uiMode: UIWorkspaceMode;
  showBotHeartbeats: boolean;
  showGitCommitGraphs: boolean;
  showTokenMeters: boolean;
  updatedAt: string;
}

export interface ProgressiveDisclosureViewConfig {
  displayNavbarDetails: boolean;
  enableRawTerminalAccess: boolean;
  enableTimeMachineScrubbing: boolean;
  renderTechnicalMetadata: boolean;
}

/**
 * Resolves UI configuration flags based on the user's active workspace mode.
 */
export function resolveViewConfig(mode: UIWorkspaceMode): ProgressiveDisclosureViewConfig {
  if (mode === "developer_mode") {
    return {
      displayNavbarDetails: true,
      enableRawTerminalAccess: true,
      enableTimeMachineScrubbing: true,
      renderTechnicalMetadata: true
    };
  }

  // Default Business Mode: Clean, human-centric abstraction
  return {
    displayNavbarDetails: false,
    enableRawTerminalAccess: false,
    enableTimeMachineScrubbing: false,
    renderTechnicalMetadata: false
  };
}
