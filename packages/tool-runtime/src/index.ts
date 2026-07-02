// Dynamic tool registry (D1-backed), tool contract validation

export interface ToolDefinition {
  id: string;
  space_id: string;
  tenant_id: string;
  name: string;
  description: string;
  input_schema: Record<string, unknown>; // JSON Schema
  output_schema?: Record<string, unknown>;
  tool_type: "http" | "code" | "mcp" | "builtin";
  config: ToolConfig;
  requires_confirmation: boolean;
  enabled: boolean;
  created_at: string;
}

export type ToolConfig =
  | HttpToolConfig
  | McpToolConfig
  | BuiltinToolConfig;

export interface HttpToolConfig {
  type: "http";
  url: string;
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  headers?: Record<string, string>;
  auth_type?: "none" | "bearer" | "basic" | "hmac";
  auth_secret_key?: string; // name of credential in credentials store
}

export interface McpToolConfig {
  type: "mcp";
  mcp_server_id: string;
  tool_name: string;
}

export interface BuiltinToolConfig {
  type: "builtin";
  builtin_name: "web_search" | "kb_search" | "browser_navigate" | "code_execute";
}

export interface ToolCall {
  tool_id: string;
  tool_name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  tool_id: string;
  tool_name: string;
  output: unknown;
  error?: string;
  duration_ms: number;
}

export class ToolRegistry {
  constructor(private readonly db: D1Database) {}

  async getToolsForSpace(spaceId: string, tenantId: string): Promise<ToolDefinition[]> {
    const { results } = await this.db.prepare(
      "SELECT * FROM tools WHERE space_id = ? AND tenant_id = ? AND enabled = 1 ORDER BY name"
    ).bind(spaceId, tenantId).all<ToolDefinition & { config: string; input_schema: string; output_schema: string }>();
    return results.map(deserializeTool);
  }

  async getTool(toolId: string, tenantId: string): Promise<ToolDefinition | null> {
    const row = await this.db.prepare(
      "SELECT * FROM tools WHERE id = ? AND tenant_id = ?"
    ).bind(toolId, tenantId).first<ToolDefinition & { config: string; input_schema: string; output_schema: string }>();
    return row ? deserializeTool(row) : null;
  }

  async registerTool(tool: Omit<ToolDefinition, "id" | "created_at">): Promise<string> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await this.db.prepare(
      `INSERT INTO tools (id, space_id, tenant_id, name, description, input_schema, output_schema, tool_type, config, requires_confirmation, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id, tool.space_id, tool.tenant_id, tool.name, tool.description,
      JSON.stringify(tool.input_schema), tool.output_schema ? JSON.stringify(tool.output_schema) : null,
      tool.tool_type, JSON.stringify(tool.config),
      tool.requires_confirmation ? 1 : 0, tool.enabled ? 1 : 0, now, now
    ).run();
    return id;
  }

  async deleteTool(toolId: string, tenantId: string): Promise<boolean> {
    const result = await this.db.prepare(
      "DELETE FROM tools WHERE id = ? AND tenant_id = ?"
    ).bind(toolId, tenantId).run();
    return result.meta.changes > 0;
  }
}

// Validate tool input against its JSON Schema
export function validateToolInput(
  input: Record<string, unknown>,
  schema: Record<string, unknown>
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const required = (schema["required"] as string[] | undefined) ?? [];
  const properties = (schema["properties"] as Record<string, Record<string, unknown>> | undefined) ?? {};

  for (const field of required) {
    if (!(field in input) || input[field] === undefined || input[field] === null) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  for (const [field, value] of Object.entries(input)) {
    const propSchema = properties[field];
    if (!propSchema) continue;
    const expectedType = propSchema["type"] as string | undefined;
    if (expectedType) {
      const actualType = Array.isArray(value) ? "array" : typeof value;
      if (actualType !== expectedType) {
        errors.push(`Field '${field}' expected type '${expectedType}', got '${actualType}'`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

function deserializeTool(row: ToolDefinition & { config: string; input_schema: string; output_schema: string }): ToolDefinition {
  const result: ToolDefinition = {
    ...row,
    config: typeof row.config === "string" ? JSON.parse(row.config) as ToolConfig : row.config,
    input_schema: typeof row.input_schema === "string" ? JSON.parse(row.input_schema) as Record<string, unknown> : row.input_schema,
  };
  if (row.output_schema) {
    result.output_schema = typeof row.output_schema === "string" ? JSON.parse(row.output_schema) as Record<string, unknown> : row.output_schema;
  }
  return result;
}
