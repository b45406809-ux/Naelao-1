type OrderParams = {
  confirmed?: boolean;
  symbol?: string;
  side?: "buy" | "sell";
  quantity?: number;
  requestId?: string;
};

type WorkflowStep = {
  do<T>(name: string, callback: () => Promise<T>): Promise<T>;
};

type WorkflowContext = {
  params: OrderParams;
  identity: { runId: string; actorId: string; projectId?: string };
  tools: {
    call<T>(stepKey: string, operation: string, params: Record<string, unknown>): Promise<T>;
  };
};

/** Project member worker entry. The planner delegates a reviewed request here; this workflow
 * does not become a conversational planner or read chat threads. The host checks tool access
 * and journals the effect under the verified actor, project, installation and run ID. */
export async function execute(step: WorkflowStep, ctx: WorkflowContext) {
  const order = ctx.params;
  const symbol = typeof order.symbol === "string" ? order.symbol.trim().toUpperCase() : "";
  const quantity = order.quantity;
  if (order.confirmed !== true) throw new Error("order_requires_explicit_member_confirmation");
  if (!/^[A-Z0-9.-]{1,16}$/.test(symbol)) throw new Error("order_symbol_invalid");
  if (order.side !== "buy" && order.side !== "sell") throw new Error("order_side_invalid");
  if (typeof quantity !== "number" || !Number.isFinite(quantity) || quantity <= 0 || quantity > 100_000) {
    throw new Error("order_quantity_out_of_bounds");
  }

  return step.do("place-order", () => ctx.tools.call("place-order-effect", "orders.place", {
    symbol,
    side: order.side,
    quantity,
    requestId: order.requestId,
    actorId: ctx.identity.actorId,
    projectId: ctx.identity.projectId,
    workflowRunId: ctx.identity.runId,
  }));
}
