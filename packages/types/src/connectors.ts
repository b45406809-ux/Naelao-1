export interface ConnectorBinding {
  projectId: string;
  entityId: string;           // Workflow ID, Micro-App ID, or "default"
  logicalAlias: string;       // e.g., "primary_inbox"
  mappedConnectionId: string; // The physical Composio/Pipedream/Vault ID
  connectionType: string;     // e.g., "gmail", "stripe", "notion"
  customConfigJson: string;   // JSON string of app-specific configurations
  updatedBy: string;          // User ID or Agent ID who mapped it
  updatedAt: string;
}

export interface ConnectorResolutionResult {
  connected: boolean;
  connectionId?: string;
  connectionType?: string;
  config?: Record<string, any>;
  requiresElicitation?: boolean;
  elicitationPayload?: {
    message: string;
    requestedAlias: string;
    suggestedProviders: string[];
  };
}
