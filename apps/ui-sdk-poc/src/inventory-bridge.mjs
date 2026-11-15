import { LIST_LOW_STOCK_INPUT_SCHEMA, LIST_LOW_STOCK_OUTPUT_SCHEMA, validateListLowStockOutput } from "@naelao/agent-sdk";

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`).join(",")}}`;
  return JSON.stringify(value);
}

export function resolveBusinessActionEndpoint(pathname, embedded) {
  if (!embedded || typeof pathname !== "string" || pathname.length > 2048) return null;
  const match = pathname.match(/^(\/spaces\/[^/]+(?:\/projects\/[^/]+)?\/apps\/[a-z][a-z0-9_-]{1,63})(?:\/app)?\/?$/);
  return match?.[1] ?? null;
}

export async function readAuthorizedLowStock(client) {
  if (!client || typeof client.list !== "function" || typeof client.invoke !== "function") {
    throw new Error("host_business_action_client_unavailable");
  }
  const catalog = await client.list();
  if (!catalog || catalog.version !== 1 || !Array.isArray(catalog.actions) || catalog.actions.length > 32) {
    throw new Error("host_business_action_catalog_invalid");
  }
  const action = catalog.actions.find(candidate => candidate?.id === "listLowStock");
  if (!action || action.permission !== "inventory.stock.read" || action.effects !== "read_only" || action.idempotency !== "none"
    || action.approval !== "none" || !Array.isArray(action.roles) || !action.roles.includes("owner") && !action.roles.includes("admin")
    || canonicalJson(action.inputSchema) !== canonicalJson(LIST_LOW_STOCK_INPUT_SCHEMA)
    || canonicalJson(action.outputSchema) !== canonicalJson(LIST_LOW_STOCK_OUTPUT_SCHEMA)) {
    throw new Error("host_low_stock_action_unavailable");
  }
  const result = await client.invoke("listLowStock", { maximumQuantity: 20, limit: 100 });
  return validateListLowStockOutput(result);
}
