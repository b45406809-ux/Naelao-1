/** Stable identifiers used by the one-click recipe installer. */
export type RecipeId =
  | "shopify_order_to_shipstation"
  | "dental_receptionist_desk"
  | "ecommerce_returns_assistant";

export interface AutomationRecipe {
  readonly id: RecipeId;
  readonly name: string;
  readonly description: string;
  /** External channel recipes use a quarantined runtime context. */
  readonly runtimeContext: "standard" | "CustomerBotContext";
  readonly webhooks: readonly { id: string; provider: string; event: string }[];
  readonly queues: readonly { id: string; consumer: string }[];
  readonly workflows: readonly {
    id: string;
    trigger: string;
    steps: readonly string[];
  }[];
  readonly viewports: readonly {
    id: string;
    title: string;
    kind: "table" | "inbox" | "calendar";
  }[];
}

export const RECIPE_CATALOG = {
  shopify_order_to_shipstation: {
    id: "shopify_order_to_shipstation",
    name: "Shopify order to ShipStation",
    description: "Creates a shipping label for every paid Shopify order.",
    runtimeContext: "standard",
    webhooks: [
      {
        id: "shopify-orders-paid",
        provider: "shopify",
        event: "orders/paid",
      },
    ],
    queues: [{ id: "shipping-orders", consumer: "create-shipping-label" }],
    workflows: [
      {
        id: "fulfil-shopify-order",
        trigger: "shopify-orders-paid",
        steps: [
          "verify_webhook",
          "enqueue_order",
          "shipstation_create_label",
          "persist_tracking",
        ],
      },
    ],
    viewports: [
      { id: "shipping-labels", title: "Shipping labels", kind: "table" },
    ],
  },
  dental_receptionist_desk: {
    id: "dental_receptionist_desk",
    name: "Dental receptionist desk",
    description: "Answers WhatsApp and calls and books available appointments.",
    runtimeContext: "CustomerBotContext",
    webhooks: [
      {
        id: "whatsapp-inbound",
        provider: "whatsapp",
        event: "message.received",
      },
      { id: "call-inbound", provider: "telephony", event: "call.received" },
    ],
    queues: [{ id: "reception-inbox", consumer: "quarantined-receptionist" }],
    workflows: [
      {
        id: "book-dental-appointment",
        trigger: "reception-inbox",
        steps: [
          "customer_bot_guard",
          "collect_booking_details",
          "calendar_find_slot",
          "calendar_book",
          "confirm_customer",
        ],
      },
    ],
    viewports: [
      { id: "appointment-calendar", title: "Appointments", kind: "calendar" },
    ],
  },
  ecommerce_returns_assistant: {
    id: "ecommerce_returns_assistant",
    name: "E-commerce returns assistant",
    description:
      "Resolves Zendesk and email returns using policy-grounded answers.",
    runtimeContext: "CustomerBotContext",
    webhooks: [
      { id: "zendesk-ticket", provider: "zendesk", event: "ticket.created" },
      { id: "returns-email", provider: "email", event: "message.received" },
    ],
    queues: [
      { id: "returns-inbox", consumer: "quarantined-returns-assistant" },
    ],
    workflows: [
      {
        id: "process-return",
        trigger: "returns-inbox",
        steps: [
          "customer_bot_guard",
          "retrieve_return_policy",
          "validate_return",
          "create_exchange_label",
          "reply_to_customer",
        ],
      },
    ],
    viewports: [{ id: "returns-inbox", title: "Returns inbox", kind: "inbox" }],
  },
} satisfies Record<RecipeId, AutomationRecipe>;

export function getRecipe(recipeId: string): AutomationRecipe | undefined {
  return RECIPE_CATALOG[recipeId as RecipeId];
}
