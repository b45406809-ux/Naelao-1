export type RecipeCategory = "COMMERCE" | "FINANCE" | "ENGINEERING" | "SUPPORT" | "LOGISTICS";

export interface AutomationRecipeManifest {
  id: string; // e.g. "recipe_shopify_fulfillment_v1"
  name: string; // e.g. "Shopify Order-to-Fulfillment Pipeline"
  description: string;
  category: RecipeCategory;
  authorUserId: string;
  requiredConnectors: string[]; // e.g. ["shopify", "twilio"]
  
  webhookConfig: {
    provider: string; // e.g. "shopify"
    suggestedSlug: string; // e.g. "shopify-orders"
    signatureHeaderName: string; // e.g. "x-shopify-hmac-sha256"
  };

  bundledWorkflow: {
    id: string;
    name: string;
    scriptPath: string; // e.g. "/.avos/shared/workflows/shopify-fulfillment.ts"
  };

  bundledGadget?: {
    gadgetId: string; // e.g. "gadget_fulfillment_ledger"
    purpose: string;
    initialSqlSchema: string;
  };
}
