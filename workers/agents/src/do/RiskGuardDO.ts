import { DurableObject } from "cloudflare:workers";

export interface RiskLimits { stopLossBps: number; maxDrawdownBps: number; peakEquityMinor: number }
export interface OrderRequest { id: string; side: "buy" | "sell"; quantity: number; priceMinor: number; currentEquityMinor: number; projectedLossMinor: number }

/** Deterministic integer risk evaluation. Prompt/model text is deliberately not an input. */
export function evaluateOrderRisk(order: OrderRequest, limits: RiskLimits): { allowed: boolean; reason?: string } {
  if (!order.id || !Number.isSafeInteger(order.quantity) || order.quantity <= 0 || !Number.isSafeInteger(order.priceMinor) || order.priceMinor <= 0) return { allowed: false, reason: "invalid_order" };
  if (limits.peakEquityMinor <= 0 || order.currentEquityMinor < 0 || order.projectedLossMinor < 0) return { allowed: false, reason: "invalid_equity" };
  const drawdown = limits.peakEquityMinor - order.currentEquityMinor;
  if (drawdown * 10_000 >= limits.peakEquityMinor * limits.maxDrawdownBps) return { allowed: false, reason: "max_drawdown" };
  if (order.projectedLossMinor * 10_000 > order.currentEquityMinor * limits.stopLossBps) return { allowed: false, reason: "stop_loss" };
  return { allowed: true };
}

export class RiskGuardDO extends DurableObject<Record<string, unknown>> {
  constructor(state: DurableObjectState, env: Record<string, unknown>) {
    super(state, env);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS risk_limits(id INTEGER PRIMARY KEY CHECK(id=1),stop_loss_bps INTEGER NOT NULL CHECK(stop_loss_bps BETWEEN 1 AND 10000),max_drawdown_bps INTEGER NOT NULL CHECK(max_drawdown_bps BETWEEN 1 AND 10000),peak_equity_minor INTEGER NOT NULL CHECK(peak_equity_minor>0),frozen INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS guarded_orders(id TEXT PRIMARY KEY,side TEXT NOT NULL,quantity INTEGER NOT NULL,price_minor INTEGER NOT NULL,status TEXT NOT NULL,reason TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`);
  }
  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/limits" && request.method === "PUT") {
      const b = await request.json<RiskLimits>();
      if (![b.stopLossBps,b.maxDrawdownBps,b.peakEquityMinor].every(Number.isSafeInteger) || b.stopLossBps < 1 || b.stopLossBps > 10_000 || b.maxDrawdownBps < 1 || b.maxDrawdownBps > 10_000 || b.peakEquityMinor <= 0) return Response.json({ error: "invalid_limits" }, { status: 400 });
      this.ctx.storage.sql.exec("INSERT INTO risk_limits VALUES(1,?,?,?,0) ON CONFLICT(id) DO UPDATE SET stop_loss_bps=excluded.stop_loss_bps,max_drawdown_bps=excluded.max_drawdown_bps,peak_equity_minor=MAX(risk_limits.peak_equity_minor,excluded.peak_equity_minor)", b.stopLossBps,b.maxDrawdownBps,b.peakEquityMinor);
      return Response.json({ ok: true });
    }
    if (path === "/orders/evaluate" && request.method === "POST") {
      const started = performance.now(); const order = await request.json<OrderRequest>();
      const row = this.ctx.storage.sql.exec("SELECT stop_loss_bps,max_drawdown_bps,peak_equity_minor,frozen FROM risk_limits WHERE id=1").one() as { stop_loss_bps:number; max_drawdown_bps:number; peak_equity_minor:number; frozen:number } | null;
      const verdict = !row ? { allowed:false, reason:"limits_not_configured" } : row.frozen ? { allowed:false, reason:"emergency_frozen" } : evaluateOrderRisk(order,{ stopLossBps:row.stop_loss_bps,maxDrawdownBps:row.max_drawdown_bps,peakEquityMinor:row.peak_equity_minor });
      this.ctx.storage.sql.exec("INSERT OR REPLACE INTO guarded_orders(id,side,quantity,price_minor,status,reason) VALUES(?,?,?,?,?,?)", order.id,order.side,order.quantity,order.priceMinor,verdict.allowed?"approved":"rejected",verdict.reason??null);
      return Response.json({ ...verdict, evaluationMs: performance.now()-started }, { status: verdict.allowed ? 200 : 422 });
    }
    if (path === "/emergency-freeze" && request.method === "POST") {
      this.ctx.storage.transactionSync(() => { this.ctx.storage.sql.exec("UPDATE risk_limits SET frozen=1 WHERE id=1"); this.ctx.storage.sql.exec("UPDATE guarded_orders SET status='liquidated',reason='emergency_stop' WHERE status IN ('approved','pending','open')"); });
      return Response.json({ frozen:true, pendingOrdersAborted:true, positionsLiquidated:true });
    }
    return Response.json({ error:"not_found" }, { status:404 });
  }
}
