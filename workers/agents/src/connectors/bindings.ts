import { ConnectorResolutionResult } from "@naelao/types";

/**
 * Resolves a logical connector alias into a physical connection ID by querying SpaceDO.
 * If the binding doesn't exist, it returns an elicitation payload to prompt the user in the UI.
 */
export async function resolveConnectorAlias(
  projectId: string, 
  entityId: string, 
  logicalAlias: string, 
  spaceDOStub: DurableObjectStub
): Promise<ConnectorResolutionResult> {
  
  // 1. Fetch the binding matrix row from SpaceDO
  const res = await spaceDOStub.fetch(`http://internal/projects/${projectId}/bindings/${entityId}/${logicalAlias}`);
  
  if (res.status === 404) {
    // 2. Missing Binding: Trigger MCP v2 Elicitation flow!
    // This tells the orchestrator to pause execution and render a UI card asking the user
    // to connect an account for this specific logical alias.
    return {
      connected: false,
      requiresElicitation: true,
      elicitationPayload: {
        message: `This automation requires an active account connection for '${logicalAlias}'.`,
        requestedAlias: logicalAlias,
        suggestedProviders: [] // UI will display the generic app catalog
      }
    };
  }

  const binding = await res.json() as any;

  // 3. Return the physical credentials mapping for Outbound Egress
  return {
    connected: true,
    connectionId: binding.mappedConnectionId,
    connectionType: binding.connectionType,
    config: JSON.parse(binding.customConfigJson || "{}")
  };
}
