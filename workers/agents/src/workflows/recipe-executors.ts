import { WorkflowStep, WorkflowEvent } from "cloudflare:workers";

export async function executeShopifyFulfillmentRecipe(
  event: WorkflowEvent<{ payload: any; spaceId: string; projectId: string }>,
  step: WorkflowStep,
  ctx: any
) {
  const { payload, spaceId, projectId } = event.payload;

  // Step 1: Extract order details safely
  const orderInfo = await step.do("extract-order-details", async () => {
    return {
      orderId: payload.id?.toString() || "ord_unknown",
      customerEmail: payload.email || payload.customer?.email || "unknown@client.com",
      lineItems: payload.line_items || [],
      totalPrice: payload.total_price || "0.00"
    };
  });

  // Step 2: Query Stateful Gadget (DO Facet SQLite via MCP v2)
  const inventoryCheck = await step.do("verify-inventory", async () => {
    return await ctx.mcp.call("gadget_fulfillment_ledger", "app_fulfillment_ledger_list", {
      filter: `status = 'IN_STOCK'`
    });
  });

  // Step 3: Simulate Fulfillment & Generate Tracking Number
  const fulfillmentResult = await step.do("process-fulfillment", async () => {
    const trackingNum = `TRK_${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
    await ctx.mcp.call("gadget_fulfillment_ledger", "app_fulfillment_ledger_insert", {
      data: {
        order_id: orderInfo.orderId,
        customer_email: orderInfo.customerEmail,
        status: "FULFILLED",
        tracking_number: trackingNum
      }
    });
    return { trackingNumber: trackingNum };
  });

  // Step 4: Dispatch SMS Notification via Twilio Connector
  await step.do("send-sms-notification", async () => {
    const smsClient = await ctx.connectors.use("twilio");
    if (smsClient) {
      await smsClient.call("send_sms", {
        to: payload.shipping_address?.phone || "+13055550199",
        body: `Your AVOS order #${orderInfo.orderId} has shipped! Tracking: ${fulfillmentResult.trackingNumber}`
      });
    }
  });

  return { ok: true, orderId: orderInfo.orderId, trackingNumber: fulfillmentResult.trackingNumber };
}
