import { DurableObject } from "cloudflare:workers";
import { readBoundedRequestBytes, RequestBodyTooLargeError } from "@naelao/http";
import { deterministicNoul, SystemOneDecisionClient, type FastDecisionGateway, type ScoreDecision } from "@naelao/agent-sdk";

export interface RiskLimits { stopLossBps: number; maxDrawdownBps: number; peakEquityMinor: number }
export interface OrderRequest { id: string; side: "buy" | "sell"; quantity: number; priceMinor: number; currentEquityMinor: number; projectedLossMinor: number }

interface RiskGuardEnv {
  OPENROUTER_API_KEY?: string;
  SYSTEM_ONE_MODEL?: string;
  SYSTEM_ONE_PROVIDER?: "jev" | "laya" | "clef" | "openrouter";
  ANALYTICS?: AnalyticsEngineDataset;
}

/** Deterministic integer risk evaluation. Prompt/model text is deliberately not an input. */
export function evaluateOrderRisk(order: OrderRequest, limits: RiskLimits): { allowed: boolean; reason?: string } {
  if (typeof order.id !== "string" || order.id.length === 0 || order.id.length > 128
    || (order.side !== "buy" && order.side !== "sell")
    || !Number.isSafeInteger(order.quantity) || order.quantity <= 0
    || !Number.isSafeInteger(order.priceMinor) || order.priceMinor <= 0) return { allowed: false, reason: "invalid_order" };
  if (!Number.isSafeInteger(limits.peakEquityMinor) || limits.peakEquityMinor <= 0
    || !Number.isSafeInteger(limits.stopLossBps) || limits.stopLossBps < 1 || limits.stopLossBps > 10_000
    || !Number.isSafeInteger(limits.maxDrawdownBps) || limits.maxDrawdownBps < 1 || limits.maxDrawdownBps > 10_000
    || !Number.isSafeInteger(order.currentEquityMinor) || order.currentEquityMinor < 0
    || !Number.isSafeInteger(order.projectedLossMinor) || order.projectedLossMinor < 0) return { allowed: false, reason: "invalid_equity" };
  const peak = BigInt(limits.peakEquityMinor);
  const current = BigInt(order.currentEquityMinor);
  const loss = BigInt(order.projectedLossMinor);
  if (current < peak && (peak - current) * 10_000n >= peak * BigInt(limits.maxDrawdownBps)) return { allowed: false, reason: "max_drawdown" };
  if (loss * 10_000n > current * BigInt(limits.stopLossBps)) return { allowed: false, reason: "stop_loss" };
  const decision = deterministicNoul(true, "risk_limits_satisfied");
  return { allowed: decision.value };
}

function isRiskLimits(value: unknown): value is RiskLimits {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const limits = value as Partial<RiskLimits>;
  return Number.isSafeInteger(limits.stopLossBps) && limits.stopLossBps! >= 1 && limits.stopLossBps! <= 10_000
    && Number.isSafeInteger(limits.maxDrawdownBps) && limits.maxDrawdownBps! >= 1 && limits.maxDrawdownBps! <= 10_000
    && Number.isSafeInteger(limits.peakEquityMinor) && limits.peakEquityMinor! > 0;
}

function isOrderRequest(value: unknown): value is OrderRequest & { airGappedOnly?: boolean } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const order = value as Partial<OrderRequest> & { airGappedOnly?: unknown };
  return typeof order.id === "string" && order.id.length > 0 && order.id.length <= 128
    && (order.side === "buy" || order.side === "sell")
    && Number.isSafeInteger(order.quantity) && order.quantity! > 0
    && Number.isSafeInteger(order.priceMinor) && order.priceMinor! > 0
    && Number.isSafeInteger(order.currentEquityMinor) && order.currentEquityMinor! >= 0
    && Number.isSafeInteger(order.projectedLossMinor) && order.projectedLossMinor! >= 0
    && (order.airGappedOnly === undefined || typeof order.airGappedOnly === "boolean");
}

/** Advisory System One score. Deterministic integer limits remain the authorization boundary. */
export async function scoreOrderRisk(order: OrderRequest, limits: RiskLimits, gateway?: FastDecisionGateway): Promise<ScoreDecision | undefined> {
  if (!gateway) return undefined;
  try {
    return await gateway.score({
      state: { order, limits },
      instructions: "Score residual financial risk after deterministic drawdown and stop-loss limits pass. Return a level only; do not authorize execution.",
      criteria: ["minimal", "low", "moderate", "high", "critical"],
      policyCode: "risk_guard_residual_score",
    });
  } catch {
    return undefined;
  }
}

export class RiskGuardDO extends DurableObject<RiskGuardEnv> {
  private readonly sentry?: FastDecisionGateway;
  constructor(state: DurableObjectState, env: RiskGuardEnv) {
    super(state, env);
    if (env.OPENROUTER_API_KEY) {
      this.sentry = new SystemOneDecisionClient({
        apiKey: env.OPENROUTER_API_KEY,
        ...(env.SYSTEM_ONE_MODEL ? { model: env.SYSTEM_ONE_MODEL } : {}),
        legacyProvider: env.SYSTEM_ONE_PROVIDER === "clef" ? "clef" : env.SYSTEM_ONE_PROVIDER === "laya" ? "laya" : "jev",
        ...(env.ANALYTICS ? { onDecision: (event) => {
          try { env.ANALYTICS!.writeDataPoint({ blobs: ["system_one.decision", "", "", "", "risk-guard", event.provider, "risk", event.policyCode, event.model], doubles: [event.latencyMs, event.usage.inputTokens, event.usage.outputTokens] }); } catch { /* best effort */ }
        } } : {}),
      });
    }
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS risk_limits(id INTEGER PRIMARY KEY CHECK(id=1),stop_loss_bps INTEGER NOT NULL CHECK(stop_loss_bps BETWEEN 1 AND 10000),max_drawdown_bps INTEGER NOT NULL CHECK(max_drawdown_bps BETWEEN 1 AND 10000),peak_equity_minor INTEGER NOT NULL CHECK(peak_equity_minor>0),frozen INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS guarded_orders(id TEXT PRIMARY KEY,side TEXT NOT NULL,quantity INTEGER NOT NULL,price_minor INTEGER NOT NULL,status TEXT NOT NULL,reason TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`);
  }
  override async fetch(request: Request): Promise<Response> {
    if (request.body && request.method !== "GET" && request.method !== "HEAD") {
      try { request = new Request(request, { body: await readBoundedRequestBytes(request, 64 * 1024) }); }
      catch (error) {
        if (error instanceof RequestBodyTooLargeError) return Response.json({ error_code: "request_body_too_large" }, { status: 413 });
        return Response.json({ error_code: "invalid_request_body" }, { status: 400 });
      }
    }
    const path = new URL(request.url).pathname;
    if (path === "/limits" && request.method === "PUT") {
      let b: unknown;
      try { b = await request.json(); } catch { return Response.json({ error: "invalid_limits" }, { status: 400 }); }
      if (!isRiskLimits(b)) return Response.json({ error: "invalid_limits" }, { status: 400 });
      this.ctx.storage.sql.exec("INSERT INTO risk_limits VALUES(1,?,?,?,0) ON CONFLICT(id) DO UPDATE SET stop_loss_bps=excluded.stop_loss_bps,max_drawdown_bps=excluded.max_drawdown_bps,peak_equity_minor=MAX(risk_limits.peak_equity_minor,excluded.peak_equity_minor)", b.stopLossBps,b.maxDrawdownBps,b.peakEquityMinor);
      return Response.json({ ok: true });
    }
    if (path === "/orders/evaluate" && request.method === "POST") {
      let value: unknown;
      try { value = await request.json(); } catch { return Response.json({ error: "invalid_order" }, { status: 400 }); }
      if (!isOrderRequest(value)) return Response.json({ error: "invalid_order" }, { status: 400 });
      const started = performance.now(); const order = value;
      const row = this.ctx.storage.sql.exec("SELECT stop_loss_bps,max_drawdown_bps,peak_equity_minor,frozen FROM risk_limits WHERE id=1").one() as { stop_loss_bps:number; max_drawdown_bps:number; peak_equity_minor:number; frozen:number } | null;
      const verdict = !row ? { allowed:false, reason:"limits_not_configured" } : row.frozen ? { allowed:false, reason:"emergency_frozen" } : evaluateOrderRisk(order,{ stopLossBps:row.stop_loss_bps,maxDrawdownBps:row.max_drawdown_bps,peakEquityMinor:row.peak_equity_minor });
      const limits = row ? { stopLossBps:row.stop_loss_bps,maxDrawdownBps:row.max_drawdown_bps,peakEquityMinor:row.peak_equity_minor } : undefined;
      const riskScore = verdict.allowed && limits && !order.airGappedOnly ? await scoreOrderRisk(order, limits, this.sentry) : undefined;
      this.ctx.storage.sql.exec("INSERT OR REPLACE INTO guarded_orders(id,side,quantity,price_minor,status,reason) VALUES(?,?,?,?,?,?)", order.id,order.side,order.quantity,order.priceMinor,verdict.allowed?"approved":"rejected",verdict.reason??null);
      return Response.json({ ...verdict, ...(riskScore ? { risk_score: riskScore.value, risk_provider: riskScore.provider, risk_confidence: riskScore.confidence } : {}), evaluationMs: performance.now()-started }, { status: verdict.allowed ? 200 : 422 });
    }
    if (path === "/emergency-freeze" && request.method === "POST") {
      this.ctx.storage.transactionSync(() => { this.ctx.storage.sql.exec("UPDATE risk_limits SET frozen=1 WHERE id=1"); this.ctx.storage.sql.exec("UPDATE guarded_orders SET status='liquidated',reason='emergency_stop' WHERE status IN ('approved','pending','open')"); });
      return Response.json({ frozen:true, pendingOrdersAborted:true, positionsLiquidated:true });
    }
    return Response.json({ error:"not_found" }, { status:404 });
  }
}
