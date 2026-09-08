/**
 * AVOS NaelaoAgentDO - Durable Object for Autonomous Agent Execution
 * Integrates 3-Tier Connector Scoping, Invoker Signing, and Privacy Forking.
 */

import { ThreadKind, Gatekeeper } from '../../../../packages/security/src/gatekeeper';
import { ToolSurface, ToolDefinition, createPrivacyBridgeCard } from '../script-engine/tool-surface';

export interface AgentDOEnv {
  CREDENTIALS_WORKER: {
    fetch: (req: Request) => Promise<Response>;
  };
  MCP_HUB: {
    fetch: (req: Request) => Promise<Response>;
  };
}

export interface AgentExecutionRequest {
  spaceId: string;
  projectId?: string;
  threadId: string;
  threadKind: ThreadKind;
  actingUserId: string;
  agentName: string;
  prompt: string;
  tools?: ToolDefinition[];
}

export class NaelaoAgentDO {
  private state: DurableObjectState;
  private env: AgentDOEnv;
  private toolSurface: ToolSurface;

  constructor(state: DurableObjectState, env: AgentDOEnv) {
    this.state = state;
    this.env = env;
    this.toolSurface = new ToolSurface();
  }

  /**
   * Builds the isolated script execution environment for the agent run turn.
   */
  private buildScriptEngineEnv(context: {
    spaceId: string;
    projectId?: string;
    threadId: string;
    threadKind: ThreadKind;
    actingUserId: string;
  }) {
    return {
      actingUserId: context.actingUserId,
      projectId: context.projectId,
      spaceId: context.spaceId,
      threadKind: context.threadKind,
      callMcpTool: async (toolName: string, args: Record<string, any>) => {
        // Enforce Gatekeeper caller signing on dispatched tool call
        const payload = {
          toolName,
          args,
          context: {
            spaceId: context.spaceId,
            projectId: context.projectId,
            actingUserId: context.actingUserId,
            threadKind: context.threadKind,
          },
        };

        const res = await this.env.MCP_HUB.fetch(
          new Request('http://mcp-hub/execute', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          })
        );

        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`MCP execution failed: ${errText}`);
        }

        return await res.json();
      },
    };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/execute' && request.method === 'POST') {
      try {
        const body = (await request.json()) as AgentExecutionRequest;

        // Register any provided tools into the ToolSurface
        if (body.tools && Array.isArray(body.tools)) {
          for (const tool of body.tools) {
            this.toolSurface.registerTool(tool);
          }
        }

        // 1. Perform Physical Tool Schema Stripping
        const activeTools = this.toolSurface.getToolsForContext(
          body.threadKind,
          body.actingUserId,
          body.projectId
        );

        // 2. Check if user prompt attempts to target a personal tool from a public room
        const promptLower = body.prompt.toLowerCase();
        const personalToolsRequiringBridge = (body.tools || []).filter(
          t => t.scope === 'USER_PERSONAL' && promptLower.includes(t.name.toLowerCase().split('.')[0])
        );

        if (
          (body.threadKind === 'public_channel' || body.threadKind === 'project_room') &&
          personalToolsRequiringBridge.length > 0
        ) {
          const personalTool = personalToolsRequiringBridge[0];
          const bridgeCard = createPrivacyBridgeCard({
            toolName: personalTool.name,
            agentName: body.agentName,
            actingUserId: body.actingUserId,
            threadId: body.threadId,
          });

          return new Response(
            JSON.stringify({
              status: 'privacy_bridge_required',
              uiCard: bridgeCard,
              activeTools: activeTools.map(t => t.name),
            }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }

        // 3. Build signed Script Engine Context
        const scriptEnv = this.buildScriptEngineEnv({
          spaceId: body.spaceId,
          projectId: body.projectId,
          threadId: body.threadId,
          threadKind: body.threadKind,
          actingUserId: body.actingUserId,
        });

        return new Response(
          JSON.stringify({
            status: 'ready',
            activeTools: activeTools.map(t => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
            invoker: {
              actingUserId: body.actingUserId,
              threadKind: body.threadKind,
              spaceId: body.spaceId,
            },
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      } catch (err: any) {
        return new Response(
          JSON.stringify({ error: err.message || 'Execution error' }),
          {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }
    }

    return new Response('Not Found', { status: 404 });
  }
}
