/**
 * AVOS Tool Surface & Dynamic Schema Filter
 * Implements Physical Tool Schema Stripping and Privacy Forking detection.
 */

import { ThreadKind } from '../../../packages/security/src/gatekeeper';

export interface DiscoveredGadgetEndpoint {
  instanceId: string;
  manifestId: string;
  tier: 1 | 2 | 3;
  internalMcpUrl: string; // e.g. "http://internal/spaces/s1/gadgets/g102/mcp"
}

export interface GadgetMcpToolMap {
  qualifiedToolName: string; // "mcp.gadget_g102.find_callers"
  instanceId: string;
  originalToolName: string;  // "find_callers"
  description: string;
  inputSchema: Record<string, any>;
}

export type ToolScope = 'SPACE_SHARED' | 'PROJECT_BOUND' | 'USER_PERSONAL';

export interface ToolParameterSchema {
  type: string;
  properties?: Record<string, any>;
  required?: string[];
  [key: string]: any;
}

export interface ToolDefinition {
  name: string;
  description: string;
  scope: ToolScope;
  ownerUserId?: string;
  projectId?: string;
  inputSchema: ToolParameterSchema;
}

export interface PrivacyForkEvent {
  type: 'PRIVACY_FORK_REQUIRED';
  toolName: string;
  requestedByUserId: string;
  sourceThreadKind: ThreadKind;
  targetThreadKind: 'private_scratchpad';
  message: string;
}

/**
 * Physically strips tools that the current thread context is not permitted to see or invoke.
 * If in a Public Room, all USER_PERSONAL tools are removed completely from the prompt.
 */
export function filterToolsByThreadScope(
  allTools: ToolDefinition[],
  threadKind: ThreadKind,
  actingUserId?: string,
  projectId?: string
): ToolDefinition[] {
  if (threadKind !== 'private_scratchpad' && threadKind !== 'direct_message') {
    // PUBLIC / PROJECT ROOM:
    // 1. Physically strip all USER_PERSONAL tools
    // 2. Only include SPACE_SHARED or matching PROJECT_BOUND tools
    return allTools.filter(tool => {
      if (tool.scope === 'USER_PERSONAL') return false;
      if (tool.scope === 'PROJECT_BOUND') {
        return !tool.projectId || tool.projectId === projectId;
      }
      return tool.scope === 'SPACE_SHARED';
    });
  }

  // PRIVATE SCRATCHPAD / DM:
  // Allow SPACE_SHARED, matching PROJECT_BOUND, and strictly actingUser's USER_PERSONAL tools
  return allTools.filter(tool => {
    if (tool.scope === 'USER_PERSONAL') {
      return tool.ownerUserId === actingUserId;
    }
    if (tool.scope === 'PROJECT_BOUND') {
      return !tool.projectId || tool.projectId === projectId;
    }
    return true;
  });
}

/**
 * Checks if the LLM or user is trying to invoke a personal tool in a public scope.
 * Generates an interactive Privacy Forking Bridge UI descriptor.
 */
export function createPrivacyBridgeCard(params: {
  toolName: string;
  agentName: string;
  actingUserId: string;
  threadId: string;
}): {
  type: 'mcp_ui_card';
  cardType: 'InlinePrivacyBridge';
  props: {
    title: string;
    description: string;
    ctaLabel: string;
    action: string;
    payload: Record<string, any>;
  };
} {
  const { toolName, agentName, actingUserId, threadId } = params;

  return {
    type: 'mcp_ui_card',
    cardType: 'InlinePrivacyBridge',
    props: {
      title: '🔒 Personal Integration Required',
      description: `To protect your privacy, @${agentName} cannot access your personal connector (${toolName}) in this public channel.`,
      ctaLabel: '🚀 Continue in Private Scratchpad',
      action: 'FORK_TO_PRIVATE_SCRATCHPAD',
      payload: {
        sourceThreadId: threadId,
        actingUserId,
        requiredTool: toolName,
      },
    },
  };
}

export class ToolSurface {
  private tools: Map<string, ToolDefinition> = new Map();

  registerTool(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  getToolsForContext(
    threadKind: ThreadKind,
    actingUserId?: string,
    projectId?: string
  ): ToolDefinition[] {
    const all = Array.from(this.tools.values());
    return filterToolsByThreadScope(all, threadKind, actingUserId, projectId);
  }

  isPersonalTool(toolName: string): boolean {
    const tool = this.tools.get(toolName);
    return tool?.scope === 'USER_PERSONAL';
  }
}

export class ScriptToolSurface extends ToolSurface {
  private gadgetMcpTools = new Map<string, { internalMcpUrl: string; toolName: string }>();
  private operations = new Map<string, any>();

  /**
   * Queries each discovered gadget's /mcp discovery endpoint and registers
   * its tools into the agent's available tool operations map.
   */
  async registerDiscoveredGadgetTools(
    gadgets: DiscoveredGadgetEndpoint[],
    ctx: { mcpHub: any; spaceId: string }
  ): Promise<void> {
    for (const gadget of gadgets) {
      try {
        // Query the gadget's auto-generated MCP v2 tool list
        const mcpResponse = await ctx.mcpHub.listToolsOverInternalRpc({
          endpointUrl: gadget.internalMcpUrl,
          spaceId: ctx.spaceId
        });

        if (mcpResponse && Array.isArray(mcpResponse.tools)) {
          for (const tool of mcpResponse.tools) {
            const qualifiedName = `mcp.gadget_${gadget.instanceId}.${tool.name}`;

            this.gadgetMcpTools.set(qualifiedName, {
              internalMcpUrl: gadget.internalMcpUrl,
              toolName: tool.name
            });

            // Register qualified operation in tool surface
            this.registerOperation(qualifiedName, {
              description: `[Gadget: ${gadget.manifestId}] ${tool.description}`,
              parameters: tool.inputSchema || { type: "object", properties: {} },
              handler: async (args: Record<string, any>) => {
                return await ctx.mcpHub.callToolOverInternalRpc({
                  endpointUrl: gadget.internalMcpUrl,
                  toolName: tool.name,
                  arguments: args,
                  spaceId: ctx.spaceId
                });
              }
            });

            // Also register as standard ToolDefinition so filterToolsByThreadScope can see it
            this.registerTool({
              name: qualifiedName,
              description: `[Gadget: ${gadget.manifestId}] ${tool.description}`,
              scope: gadget.tier === 1 ? 'USER_PERSONAL' : 'SPACE_SHARED',
              inputSchema: tool.inputSchema || { type: "object", properties: {} }
            });
          }
        }
      } catch (err: any) {
        console.warn(`⚠️ Failed to register MCP tools for gadget '${gadget.instanceId}':`, err.message);
      }
    }
  }

  private registerOperation(name: string, opConfig: any) {
    this.operations.set(name, opConfig);
  }

  getOperation(name: string) {
    return this.operations.get(name);
  }
}
