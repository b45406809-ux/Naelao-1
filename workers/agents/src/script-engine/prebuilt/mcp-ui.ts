// workers/agents/src/script-engine/prebuilt/mcp-ui.ts

export interface McpUiAction {
  type: "mcp_ui_card";
  component: string;
  props: Record<string, any>;
}

/**
 * Emits an interactive UI card instructing the frontend to fork the current conversation
 * into a Tier 4 Private Scratchpad so the user can safely utilize personal credentials.
 */
export function emitPrivacyBridgeCard(
  missingToolAlias: string, 
  originalPrompt: string,
  sourceThreadId: string
): McpUiAction {
  return {
    type: "mcp_ui_card",
    component: "PrivacyBridgeCard",
    props: {
      title: "🔒 Personal Integration Required",
      message: `To protect your privacy and credentials in team channels, access to your personal connector '${missingToolAlias}' is restricted to private workspaces.`,
      actionLabel: "🚀 Continue in Private Scratchpad",
      // Metadata passed back to the frontend to construct the fork request
      handoffPayload: {
        sourceThreadId,
        userPrompt: originalPrompt,
        requiredTool: missingToolAlias
      }
    }
  };
}

/**
 * Emits an interactive UI card requesting a single-use ephemeral action grant.
 * Used when a user wants a bot to perform one quick action with their credentials 
 * without leaving the public channel.
 */
export function emitEphemeralActionGrantCard(
  actionName: string,
  targetResource: string,
  reasoning: string
): McpUiAction {
  return {
    type: "mcp_ui_card",
    component: "EphemeralGrantCard",
    props: {
      title: "🔐 One-Time Action Authorization",
      message: `The agent is requesting permission to use your Personal Credentials for a single action in this channel.`,
      actionDetails: {
        action: actionName,
        target: targetResource,
        reason: reasoning
      },
      approveLabel: "✅ Authorize 1-Time Action",
      denyLabel: "❌ Deny"
    }
  };
}
