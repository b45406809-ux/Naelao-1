import { createMcpHandler } from "@cloudflare/mcp";

/**
 * Automatically wraps a Gadget's SQLite schema into a set of standard MCP tools.
 */
export function generateMcpHandlerForGadget(
  gadgetId: string, 
  doStorage: DurableObjectStorage
) {
  return createMcpHandler({
    tools: {
      // 1. Semantic Search / Query Tool
      [`query_${gadgetId}`]: {
        description: `Run a read-only SQL query against the ${gadgetId} relational graph.`,
        parameters: {
          sql: { type: "string", description: "The SQL SELECT statement to execute." },
          params: { type: "array", items: { type: "string" }, description: "Query parameters." }
        },
        execute: async ({ sql, params }) => {
          // Strictly enforce read-only SELECT
          if (!sql.trim().toLowerCase().startsWith("select")) {
            throw new Error("Only SELECT queries are permitted via MCP.");
          }
          return doStorage.sql.exec(sql, ...(params || [])).toArray();
        }
      },
      // 2. Schema Discovery Tool
      [`inspect_${gadgetId}_schema`]: {
        description: `List tables and columns available in the ${gadgetId} indexer.`,
        parameters: {},
        execute: async () => {
          return doStorage.sql.exec("SELECT name, sql FROM sqlite_master WHERE type='table'").toArray();
        }
      }
    }
  });
}
