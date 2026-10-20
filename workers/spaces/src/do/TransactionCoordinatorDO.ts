/**
 * TransactionCoordinatorDO — Saga-based cross-DO transaction coordinator.
 *
 * G-AY25: Implements the compensating transaction (saga) pattern for operations
 * that span multiple Durable Objects. Guarantees eventual consistency by
 * persisting saga state before each step and executing compensations on failure.
 *
 * Saga lifecycle:
 *   pending → running → completed | compensating → compensated | failed
 *
 * Usage:
 *   POST /sagas                                  — begin new saga
 *   GET  /sagas/:sagaId                          — get saga state
 *   POST /sagas/:sagaId/steps/:stepIndex/complete — mark step complete
 *   POST /sagas/:sagaId/steps/:stepIndex/fail    — mark step failed, begin compensation
 *   GET  /sagas                                   — list sagas (with ?status= filter)
 */

import { DurableObject } from "cloudflare:workers";
import { readBoundedRequestBytes, RequestBodyTooLargeError } from "@naelao/http";
import { checkSsrf } from "@naelao/security";

type SagaStatus = "pending" | "running" | "completed" | "compensating" | "compensated" | "failed";
const MAX_SAGA_STEPS = 16;
const MAX_SAGA_NAME = 120;
const MAX_SAGA_URL = 2048;
const MAX_SAGA_STEP_JSON_BYTES = 128 * 1024;

interface SagaStep {
  index: number;
  name: string;
  action_url: string;        // DO/service to call for this step
  action_body: string;       // JSON body for the action
  compensation_url: string;  // DO/service to call for compensation
  compensation_body: string; // JSON body for compensation
  status: "pending" | "completed" | "failed" | "compensated";
  completed_at?: string;
  failed_at?: string;
  error?: string;
}

interface SagaRow {
  id: string;
  name: string;
  tenant_id: string;
  status: SagaStatus;
  steps_json: string;     // JSON SagaStep[]
  current_step: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  error: string | null;
}

export class TransactionCoordinatorDO extends DurableObject {
  private initialized = false;

  private ensureInit(): void {
    if (this.initialized) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS sagas (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        tenant_id    TEXT NOT NULL,
        status       TEXT NOT NULL DEFAULT 'pending',
        steps_json   TEXT NOT NULL DEFAULT '[]',
        current_step INTEGER NOT NULL DEFAULT 0,
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT,
        error        TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sagas_tenant ON sagas(tenant_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sagas_status ON sagas(status, created_at DESC);
    `);
    this.initialized = true;
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.body && request.method !== "GET" && request.method !== "HEAD") {
      try { request = new Request(request, { body: await readBoundedRequestBytes(request, 1024 * 1024) }); }
      catch (error) {
        if (error instanceof RequestBodyTooLargeError) return Response.json({ error_code: "request_body_too_large" }, { status: 413 });
        return Response.json({ error_code: "invalid_request_body" }, { status: 400 });
      }
    }
    this.ensureInit();
    const url = new URL(request.url);
    const method = request.method;

    // POST /sagas — begin a new saga
    if (method === "POST" && url.pathname === "/sagas") {
      const body = await request.json<{
        name: string;
        tenant_id: string;
        steps: Array<{
          name: string;
          action_url: string;
          action_body: Record<string, unknown>;
          compensation_url: string;
          compensation_body: Record<string, unknown>;
        }>;
      }>().catch(() => null);

      if (!body || typeof body.name !== "string" || !body.name.trim() || body.name.length > MAX_SAGA_NAME
        || typeof body.tenant_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(body.tenant_id)
        || !Array.isArray(body.steps) || body.steps.length === 0 || body.steps.length > MAX_SAGA_STEPS) {
        return Response.json({ error: "name, tenant_id, and steps[] required" }, { status: 400 });
      }

      const steps: SagaStep[] = [];
      for (const [i, s] of body.steps.entries()) {
        if (!s || typeof s !== "object" || typeof s.name !== "string" || !s.name.trim() || s.name.length > 120
          || !this.isHttpsUrl(s.action_url) || !this.isHttpsUrl(s.compensation_url)
          || !s.action_body || typeof s.action_body !== "object" || Array.isArray(s.action_body)
          || !s.compensation_body || typeof s.compensation_body !== "object" || Array.isArray(s.compensation_body))
          return Response.json({ error: "invalid_saga_step" }, { status: 400 });
        const actionBody = JSON.stringify(s.action_body), compensationBody = JSON.stringify(s.compensation_body);
        if (new TextEncoder().encode(actionBody).byteLength > MAX_SAGA_STEP_JSON_BYTES || new TextEncoder().encode(compensationBody).byteLength > MAX_SAGA_STEP_JSON_BYTES)
          return Response.json({ error: "saga_step_payload_too_large" }, { status: 413 });
        steps.push({ index: i, name: s.name, action_url: s.action_url, action_body: actionBody,
          compensation_url: s.compensation_url, compensation_body: compensationBody, status: "pending" });
      }
      if (new TextEncoder().encode(JSON.stringify(steps)).byteLength > 512 * 1024) return Response.json({ error: "saga_payload_too_large" }, { status: 413 });

      const sagaId = crypto.randomUUID();

      this.ctx.storage.sql.exec(
        `INSERT INTO sagas (id, name, tenant_id, status, steps_json, current_step)
         VALUES (?, ?, ?, 'pending', ?, 0)`,
        sagaId, body.name, body.tenant_id, JSON.stringify(steps)
      );

      return Response.json({ saga_id: sagaId, status: "pending", step_count: steps.length }, { status: 201 });
    }

    // GET /sagas — list sagas
    if (method === "GET" && url.pathname === "/sagas") {
      const tenantId = url.searchParams.get("tenant_id");
      const status = url.searchParams.get("status");
      if (tenantId && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(tenantId)) return Response.json({ error: "invalid_tenant_id" }, { status: 400 });
      if (status && !["pending", "running", "completed", "compensating", "compensated", "failed"].includes(status)) return Response.json({ error: "invalid_status" }, { status: 400 });
      let rows: SagaRow[];

      if (tenantId && status) {
        rows = this.ctx.storage.sql
          .exec(`SELECT * FROM sagas WHERE tenant_id = ? AND status = ? ORDER BY created_at DESC LIMIT 50`, tenantId, status)
          .toArray() as unknown as SagaRow[];
      } else if (tenantId) {
        rows = this.ctx.storage.sql
          .exec(`SELECT * FROM sagas WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 50`, tenantId)
          .toArray() as unknown as SagaRow[];
      } else {
        rows = this.ctx.storage.sql
          .exec(`SELECT * FROM sagas ORDER BY created_at DESC LIMIT 50`)
          .toArray() as unknown as SagaRow[];
      }

      return Response.json({ sagas: rows.map(r => this.rowToApi(r)) });
    }

    // GET /sagas/:sagaId
    const sagaMatch = url.pathname.match(/^\/sagas\/([^/]+)$/);
    if (method === "GET" && sagaMatch?.[1]) {
      const saga = this.getSaga(sagaMatch[1]);
      if (!saga) return Response.json({ error: "not_found" }, { status: 404 });
      return Response.json(this.rowToApi(saga));
    }

    // POST /sagas/:sagaId/steps/:stepIndex/complete
    const completeMatch = url.pathname.match(/^\/sagas\/([^/]+)\/steps\/(\d+)\/complete$/);
    if (method === "POST" && completeMatch?.[1] && completeMatch?.[2] !== undefined) {
      return this.markStepComplete(completeMatch[1], parseInt(completeMatch[2], 10));
    }

    // POST /sagas/:sagaId/steps/:stepIndex/fail
    const failMatch = url.pathname.match(/^\/sagas\/([^/]+)\/steps\/(\d+)\/fail$/);
    if (method === "POST" && failMatch?.[1] && failMatch?.[2] !== undefined) {
      const body = await request.json<{ error?: string }>().catch(() => ({}));
      return this.markStepFailed(
        failMatch[1],
        parseInt(failMatch[2], 10),
        (body as { error?: string }).error ?? "Step failed"
      );
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  }

  private getSaga(id: string): SagaRow | null {
    const rows = this.ctx.storage.sql
      .exec(`SELECT * FROM sagas WHERE id = ?`, id)
      .toArray() as unknown as SagaRow[];
    return rows[0] ?? null;
  }

  private markStepComplete(sagaId: string, stepIndex: number): Response {
    const saga = this.getSaga(sagaId);
    if (!saga) return Response.json({ error: "not_found" }, { status: 404 });
    if (["completed", "compensating", "compensated", "failed"].includes(saga.status)) {
      return Response.json({ error: "saga_already_terminal", status: saga.status }, { status: 409 });
    }

    const steps = JSON.parse(saga.steps_json) as SagaStep[];
    const step = steps[stepIndex];
    if (!step) return Response.json({ error: "step_not_found" }, { status: 404 });
    if (step.status === "completed") return Response.json({ saga_id: sagaId, step: stepIndex, saga_status: saga.status, deduplicated: true });
    if (stepIndex !== saga.current_step || step.status !== "pending") return Response.json({ error: "saga_step_out_of_order", current_step: saga.current_step }, { status: 409 });

    step.status = "completed";
    step.completed_at = new Date().toISOString();

    const allComplete = steps.every(s => s.status === "completed");
    const newStatus: SagaStatus = allComplete ? "completed" : "running";
    const nextStep = allComplete ? stepIndex : stepIndex + 1;

    this.ctx.storage.sql.exec(
      `UPDATE sagas SET status = ?, steps_json = ?, current_step = ?, updated_at = datetime('now'),
       completed_at = CASE WHEN ? = 'completed' THEN datetime('now') ELSE NULL END
       WHERE id = ?`,
      newStatus, JSON.stringify(steps), nextStep, newStatus, sagaId
    );

    console.log(`[Saga] ${sagaId} step ${stepIndex} (${step.name}) completed — saga status: ${newStatus}`);
    return Response.json({ saga_id: sagaId, step: stepIndex, saga_status: newStatus });
  }

  private markStepFailed(sagaId: string, stepIndex: number, errorMsg: string): Response {
    const saga = this.getSaga(sagaId);
    if (!saga) return Response.json({ error: "not_found" }, { status: 404 });
    if (["completed", "compensating", "compensated", "failed"].includes(saga.status)) return Response.json({ error: "saga_already_terminal", status: saga.status }, { status: 409 });

    const steps = JSON.parse(saga.steps_json) as SagaStep[];
    const step = steps[stepIndex];
    if (!step) return Response.json({ error: "step_not_found" }, { status: 404 });
    if (stepIndex !== saga.current_step || step.status !== "pending") return Response.json({ error: "saga_step_out_of_order", current_step: saga.current_step }, { status: 409 });

    step.status = "failed";
    step.failed_at = new Date().toISOString();
    const boundedError = typeof errorMsg === "string" ? errorMsg.slice(0, 1000) : "Step failed";
    step.error = boundedError;

    // Begin compensation: mark saga as compensating
    this.ctx.storage.sql.exec(
      `UPDATE sagas SET status = 'compensating', steps_json = ?, updated_at = datetime('now'), error = ? WHERE id = ?`,
      JSON.stringify(steps), boundedError, sagaId
    );

    console.log(`[Saga] ${sagaId} step ${stepIndex} (${step.name}) failed — starting compensation`);

    // Fire compensations for all previously completed steps in reverse order
    this.ctx.waitUntil(this.runCompensations(sagaId, steps, stepIndex - 1));

    return Response.json({ saga_id: sagaId, step: stepIndex, saga_status: "compensating" });
  }

  private async runCompensations(
    sagaId: string,
    steps: SagaStep[],
    fromStep: number,
  ): Promise<void> {
    // Execute compensation in reverse order (fromStep down to 0)
    for (let i = fromStep; i >= 0; i--) {
      const step = steps[i];
      if (!step || step.status !== "completed") continue;

      try {
        const ssrf = await checkSsrf(step.compensation_url);
        if (ssrf.blocked) throw new Error("compensation_destination_denied");
        const resp = await fetch(step.compensation_url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: step.compensation_body,
          redirect: "manual",
          signal: AbortSignal.timeout(10_000),
        });
        if (resp.ok) {
          step.status = "compensated";
          console.log(`[Saga] ${sagaId} compensation step ${i} (${step.name}) succeeded`);
        } else {
          await resp.body?.cancel().catch(() => undefined);
          console.error(`[Saga] ${sagaId} compensation step ${i} (${step.name}) failed: ${resp.status}`);
          step.error = `Compensation failed: ${resp.status}`;
        }
      } catch (err) {
        console.error(`[Saga] ${sagaId} compensation step ${i} failed`);
        step.error = "Compensation request failed";
      }

      // Persist updated step state after each compensation
      this.ctx.storage.sql.exec(
        `UPDATE sagas SET steps_json = ?, updated_at = datetime('now') WHERE id = ?`,
        JSON.stringify(steps), sagaId
      );
    }

    const allCompensated = steps.filter(s => s.status === "completed").every(s => s.status === "compensated");
    const finalStatus: SagaStatus = allCompensated ? "compensated" : "failed";
    this.ctx.storage.sql.exec(
      `UPDATE sagas SET status = ?, updated_at = datetime('now') WHERE id = ?`,
      finalStatus, sagaId
    );

    console.log(`[Saga] ${sagaId} compensation complete — final status: ${finalStatus}`);
  }

  private isHttpsUrl(value: unknown): value is string {
    if (typeof value !== "string" || value.length > MAX_SAGA_URL) return false;
    try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password; }
    catch { return false; }
  }

  private rowToApi(row: SagaRow): Record<string, unknown> {
    return {
      saga_id: row.id,
      name: row.name,
      tenant_id: row.tenant_id,
      status: row.status,
      steps: JSON.parse(row.steps_json),
      current_step: row.current_step,
      created_at: row.created_at,
      updated_at: row.updated_at,
      completed_at: row.completed_at,
      error: row.error,
    };
  }
}
