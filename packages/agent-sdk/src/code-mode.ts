/** Host-owned descriptions. Discovery never grants a capability. */
export interface CodeModeTool {
  name: string;
  description: string;
  parameterHint?: string;
  inputSchema?: Record<string, unknown>;
}
export interface CodeModeTools {
  search(query: string, limit?: number): Promise<ReturnType<typeof searchCodeModeTools>>;
  describe(name: string): Promise<ReturnType<typeof describeCodeModeTool>>;
  call(operation: string, params: Record<string, unknown>): Promise<unknown>;
}

function schemaType(schema: Record<string, unknown>, depth = 0): string {
  if (depth > 8) return "unknown";
  if (Array.isArray(schema.enum) && schema.enum.length <= 50 && schema.enum.every(value => value === null || ["string", "number", "boolean"].includes(typeof value))) return schema.enum.map(value => JSON.stringify(value)).join(" | ") || "never";
  if (schema.type === "string") return "string";
  if (schema.type === "number" || schema.type === "integer") return "number";
  if (schema.type === "boolean") return "boolean";
  if (schema.type === "null") return "null";
  if (schema.type === "array") return `Array<${schema.items && typeof schema.items === "object" ? schemaType(schema.items as Record<string, unknown>, depth + 1) : "unknown"}>`;
  if (schema.type === "object" && schema.properties && typeof schema.properties === "object") {
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const fields = Object.entries(schema.properties).slice(0, 100).map(([key, value]) => `${JSON.stringify(key)}${required.has(key) ? "" : "?"}: ${value && typeof value === "object" ? schemaType(value as Record<string, unknown>, depth + 1) : "unknown"}`);
    if (schema.additionalProperties !== false) fields.push("[key: string]: unknown");
    return `{ ${fields.join("; ")} }`;
  }
  if (schema.type === "object") return "Record<string, unknown>";
  return "unknown";
}

export function describeCodeModeTool(tool: CodeModeTool) {
  return { ...tool, types: `call(operation: ${JSON.stringify(tool.name)}, params: ${tool.inputSchema ? schemaType(tool.inputSchema) : "Record<string, unknown>"}): Promise<unknown>;` };
}

/** Bounded deterministic discovery over an already authorized invocation catalogue. */
export function searchCodeModeTools(tools: readonly CodeModeTool[], query: string, limit = 10) {
  if (typeof query !== "string" || query.length > 500 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error("code_discovery_input_invalid");
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const ranked = tools.map(tool => ({ tool, score: words.reduce((score, word) => score + (tool.name.toLowerCase().includes(word) ? 3 : `${tool.description} ${tool.parameterHint ?? ""}`.toLowerCase().includes(word) ? 1 : 0), 0) }))
    .filter(row => words.length === 0 || row.score > 0).sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));
  return { results: ranked.slice(0, limit).map(({ tool }) => ({ name: tool.name, description: tool.description })), total: ranked.length, truncated: ranked.length > limit };
}
