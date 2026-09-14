// Builder-facing SDK for programmatic Space/session access and agent tool building

import type {
  ApiResult,
  Message,
  NaelaoClient,
  Session,
  Space,
} from "@naelao/client-sdk";
export type { Space, Session, Message, ApiResult };

// ── Agent tool definition ────────────────────────────────────────────────────

export interface AgentTool<
  TInput = Record<string, unknown>,
  TOutput = unknown,
> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  handler: (input: TInput, context: ToolContext) => Promise<TOutput>;
}

export interface ToolContext {
  tenantId: string;
  spaceId: string;
  sessionId: string;
  traceId: string;
  env: Record<string, string>;
}

export interface JsonSchema {
  type: "object";
  properties: Record<
    string,
    {
      type: "string" | "number" | "boolean" | "array" | "object";
      description?: string;
      enum?: unknown[];
      items?: JsonSchema;
    }
  >;
  required?: string[];
  description?: string;
}

// ── Space SDK — higher-level wrapper around NaelaoClient ────────────────────

export class SpaceSDK {
  constructor(
    private readonly client: NaelaoClient,
    private readonly spaceId: string
  ) {}

  async createSession(endUserId?: string): Promise<Session> {
    const result = await this.client.sessions.create(
      this.spaceId,
      endUserId ? { end_user_id: endUserId } : {}
    );
    if ("error" in result) throw new Error(result.error.message);
    return result.data;
  }

  async sendMessage(sessionId: string, content: string): Promise<Message> {
    const result = await this.client.messages.send(
      this.spaceId,
      sessionId,
      content
    );
    if ("error" in result) throw new Error(result.error.message);
    return result.data;
  }

  async getMessages(sessionId: string): Promise<Message[]> {
    const result = await this.client.messages.list(this.spaceId, sessionId);
    if ("error" in result) throw new Error(result.error.message);
    return result.data;
  }

  async endSession(sessionId: string): Promise<void> {
    await this.client.sessions.end(this.spaceId, sessionId);
  }

  // Convenience: one-shot question → answer
  async ask(question: string, endUserId?: string): Promise<string> {
    const session = await this.createSession(endUserId);
    const message = await this.sendMessage(session.id, question);
    await this.endSession(session.id);
    return message.content;
  }
}

// ── Tool builder ─────────────────────────────────────────────────────────────

export function defineTool<TInput = Record<string, unknown>, TOutput = unknown>(
  tool: AgentTool<TInput, TOutput>
): AgentTool<TInput, TOutput> {
  return tool;
}

// Convert AgentTool to the wire format expected by the platform's tool registry
export function toolToRegistryFormat(
  tool: AgentTool,
  spaceId: string,
  tenantId: string
) {
  return {
    space_id: spaceId,
    tenant_id: tenantId,
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
    tool_type: "code" as const,
    config: { type: "code" as const },
    requires_confirmation: false,
    enabled: true,
  };
}

// ── Agent loop helper ─────────────────────────────────────────────────────────

export interface AgentRunOptions {
  maxSteps?: number;
  onStep?: (step: AgentStep) => void;
  tools?: AgentTool[];
}

export interface AgentStep {
  step: number;
  action?: { tool: string; input: unknown };
  observation?: unknown;
  thinking?: string;
}

// Execute registered tools when the agent calls them
export async function executeTool(
  toolName: string,
  input: Record<string, unknown>,
  tools: AgentTool[],
  context: ToolContext
): Promise<unknown> {
  const tool = tools.find((t) => t.name === toolName);
  if (!tool) throw new Error(`Unknown tool: ${toolName}`);
  return tool.handler(input, context);
}

// Create a SpaceSDK instance
export function createSpaceSDK(
  client: NaelaoClient,
  spaceId: string
): SpaceSDK {
  return new SpaceSDK(client, spaceId);
}

// Launchpad is the platform's single SpaceType. These runtime primitives are deliberately
// exported from the SDK rather than a SpaceType-specific package so authored scripts and the
// Launchpad shell use the exact same contracts as the workers.
export * from "./launchpad-runtime.js";
export * from "./canvas-runtime.js";
export * from "./workflow-taxonomy.js";
export * from "./extensions.js";
export * from "./avos-features.js";
