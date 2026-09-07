export interface McpJsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, any>;
}

export interface McpJsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

export interface McpToolParameterSchema {
  type: "object";
  properties: Record<string, {
    type: string;
    description?: string;
    enum?: string[];
  }>;
  required?: string[];
}

export interface McpToolDeclaration {
  name: string;
  description: string;
  inputSchema: McpToolParameterSchema;
}

export interface McpMeshEndpointManifest {
  mcpVersion: "2026-07-28";
  serverInfo: {
    name: string;
    version: string;
    environment: "cloudflare_edge_v8";
  };
  capabilities: {
    tools: { listChanged: boolean };
    prompts: { listChanged: boolean };
    resources: { subscribe: boolean; listChanged: boolean };
    elicitation: { supported: boolean };
  };
  tools: McpToolDeclaration[];
}

export interface McpElicitationRequest {
  type: "elicitation_required";
  actionName: string;
  reason: string;
  parameters: Record<string, any>;
  approvalToken: string;
}
