// workers/agents/src/script-engine/prebuilt/mcp-ui.ts

export interface McpUiAction {
  type: "mcp_ui_card";
  component: string;
  props: Record<string, any>;
}

export type McpUiCard = McpUiAction;

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
 * Emits an interactive card requesting a 15-second ephemeral grant from the credential owner.
 * Only the owner specified in `ownerUserId` will see the 'Authorize' button in the frontend.
 */
export function emitEphemeralGrantCard(
  actionName: string, 
  credentialName: string, 
  ownerUserId: string
): McpUiCard {
  return {
    type: "mcp_ui_card",
    component: "EphemeralGrantCard",
    props: {
      ownerUserId: ownerUserId,
      credentialName: credentialName,
      actionName: actionName,
      title: "🔒 Personal Integration Required",
      message: `The agent is requesting 1-time permission to use your Personal ${credentialName} to perform: ${actionName}.`,
      actionLabel: "Authorize 1-Time Action (15s Window)",
      fallbackLabel: "Continue in Private Scratchpad"
    }
  };
}
