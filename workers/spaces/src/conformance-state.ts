import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { readBoundedRequestBytes, RequestBodyTooLargeError } from "@naelao/http";
import { lintArtifact, parseArtifactLinters } from "@naelao/agent-sdk";

interface Environment { CONFORMANCE_SANDBOX_DO: DurableObjectNamespace }
export interface FixtureSeed { schema: string[]; statements: Array<{ sql: string; args?: Array<string | number | null> }>; files: Record<string, string>; artifactLinters?: unknown }
export interface StateAssertion { sql: string; args?: Array<string | number | null>; rows: unknown[] }
const MAX_BODY = 524288;
function safeSql(sql: string, readOnly = false): boolean {
  return sql.length <= 4096 && !/[;]|--|\/\*|sqlite_|__oracle|pragma|\b(?:attach|detach|alter|drop|trigger|join|with|union|intersect|except|zeroblob|randomblob)\b/i.test(sql) &&
    (sql.match(/\bSELECT\b/gi)?.length ?? 0) <= 1 && !/\bFROM\s+[a-zA-Z_][a-zA-Z0-9_]*\s*,/i.test(sql) &&
    (readOnly ? /^\s*SELECT\b/i.test(sql) : /^\s*(SELECT|INSERT|UPDATE|DELETE)\b/i.test(sql));
}
function filePath(path: string): boolean { return /^\/workspace\/(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+$/.test(path) && !path.split("/").some(p => p === "." || p === ".."); }

/** Scratch state lives outside the submitted worker's isolate; it cannot forge the oracle. */
export class ConformanceSandboxDO extends DurableObject<Environment> {
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    let bytes: Uint8Array;
    try { bytes = await readBoundedRequestBytes(request, MAX_BODY); }
    catch (error) {
      if (error instanceof RequestBodyTooLargeError) return Response.json({ error: "fixture_size_limit" }, { status: 413 });
      return Response.json({ error: "invalid_fixture_body" }, { status: 400 });
    }
    let raw: string;
    try { raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes); }
    catch { return Response.json({ error: "invalid_json" }, { status: 400 }); }
    let body: Record<string, unknown>;
    try { body = raw ? JSON.parse(raw) as Record<string, unknown> : {}; }
    catch { return Response.json({ error: "invalid_json" }, { status: 400 }); }
    const sql = this.ctx.storage.sql;
    if (path === "/prepare") {
      const seed = body as unknown as FixtureSeed;
      if (!Array.isArray(seed.schema) || seed.schema.length > 16 || !Array.isArray(seed.statements) || seed.statements.length > 500 || !seed.files || Object.keys(seed.files).length > 64) return Response.json({ error: "invalid_fixture_seed" }, { status: 400 });
      if (sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='__oracle_budget'").toArray().length) return Response.json({ error: "fixture_already_prepared" }, { status: 409 });
      this.ctx.storage.transactionSync(() => {
        sql.exec("CREATE TABLE __oracle_budget (id INTEGER PRIMARY KEY, operations INTEGER NOT NULL, rows_written INTEGER NOT NULL, sealed INTEGER NOT NULL, failures INTEGER NOT NULL)");
        sql.exec("INSERT INTO __oracle_budget VALUES (1,0,0,0,0)");
        let seedWrites = 0;
        sql.exec("CREATE TABLE __oracle_files (path TEXT PRIMARY KEY, content TEXT NOT NULL)");
        sql.exec("CREATE TABLE __oracle_linters (id INTEGER PRIMARY KEY, policy_json TEXT NOT NULL)");
        sql.exec("INSERT INTO __oracle_linters VALUES (1,?)", JSON.stringify(parseArtifactLinters(seed.artifactLinters)));
        for (const schema of seed.schema) {
          if (typeof schema !== "string" || schema.length > 4096 || !/^CREATE TABLE [a-zA-Z][a-zA-Z0-9_]*\s*\(/i.test(schema) || /;|--|\/\*|sqlite_|__oracle|\b(?:trigger|pragma|attach|zeroblob|randomblob|select)\b/i.test(schema)) throw new Error("invalid_fixture_schema");
          seedWrites += sql.exec(schema).rowsWritten;
        }
        for (const statement of seed.statements) {
          if (!safeSql(statement.sql) || !/^\s*INSERT\s+INTO\s+[a-zA-Z_][a-zA-Z0-9_]*(?:\s*\([^)]*\))?\s+VALUES\s*\([^)]*\)\s*$/i.test(statement.sql)) throw new Error("invalid_fixture_statement");
          seedWrites += sql.exec(statement.sql, ...(statement.args ?? [])).rowsWritten;
        }
        for (const [path, content] of Object.entries(seed.files)) {
          if (!filePath(path) || typeof content !== "string" || content.length > 65536) throw new Error("invalid_fixture_file");
          seedWrites += sql.exec("INSERT INTO __oracle_files VALUES (?,?)", path, content).rowsWritten;
        }
        sql.exec("UPDATE __oracle_budget SET rows_written=? WHERE id=1", seedWrites);
      });
      return Response.json({ prepared: true });
    }
    if (path === "/cleanup") { await this.ctx.storage.deleteAll(); return Response.json({ cleaned: true }); }
    if (path === "/assert") {
      const assertions = body.assertions as StateAssertion[];
      if (!Array.isArray(assertions) || assertions.length > 32 || assertions.some(assertion => !assertion || !safeSql(assertion.sql, true) || !Array.isArray(assertion.args ?? []))) return Response.json({ error: "invalid_assertions" }, { status: 400 });
      try {
        const rows = assertions.map(assertion => sql.exec(assertion.sql, ...(assertion.args ?? [])).toArray());
        sql.exec("UPDATE __oracle_budget SET sealed=1 WHERE id=1");
        const files = Object.fromEntries(sql.exec("SELECT path, content FROM __oracle_files ORDER BY path").toArray().map(row => [row.path, row.content]));
        const budget = sql.exec("SELECT operations, rows_written, failures FROM __oracle_budget WHERE id=1").toArray()[0];
        return Response.json({ rows, files, budget });
      } catch {
        return Response.json({ error: "invalid_oracle_query" }, { status: 400 });
      }
    }
    if (!['/sql','/files/read','/files/write','/files/validate'].includes(path)) return Response.json({ error: "capability_denied" }, { status: 403 });
    const budget = sql.exec("SELECT operations, rows_written, sealed FROM __oracle_budget WHERE id=1").toArray()[0] as { operations: number; rows_written: number; sealed: number };
    if (!budget || budget.sealed || budget.operations >= 64 || budget.rows_written > 10000) return Response.json({ error: "fixture_budget_exceeded" }, { status: 403 });
    // Attempts count even if the guest catches an error or its state transaction rolls back.
    sql.exec("UPDATE __oracle_budget SET operations=operations+1 WHERE id=1");
    let rowsWritten = 0;
    try {
    const result = this.ctx.storage.transactionSync(() => {
      if (path === "/sql") {
        const statement = body.sql;
        if (typeof statement !== "string" || !safeSql(statement) || !Array.isArray(body.args)) throw new Error("fixture_sql_denied");
        const cursor = sql.exec(statement, ...(body.args as Array<string | number | null>));
        const rows = cursor.toArray(); if (rows.length > 1000) throw new Error("fixture_query_size_limit");
        rowsWritten += cursor.rowsWritten;
        return { rows };
      }
      if (typeof body.path !== "string" || !filePath(body.path)) throw new Error("fixture_file_denied");
      if (path === "/files/read") return { content: sql.exec("SELECT content FROM __oracle_files WHERE path=?", body.path).toArray()[0]?.content ?? null };
      if (typeof body.content !== "string" || body.content.length > 65536) throw new Error("fixture_file_size_limit");
      const policy = sql.exec("SELECT policy_json FROM __oracle_linters WHERE id=1").toArray()[0]?.policy_json;
      const diagnostics = lintArtifact(body.path, body.content, parseArtifactLinters(JSON.parse(String(policy))));
      if (path === "/files/validate") return { diagnostics };
      if (diagnostics.length) throw new Error("fixture_structural_linter_failed");
      rowsWritten += sql.exec("INSERT INTO __oracle_files VALUES (?,?) ON CONFLICT(path) DO UPDATE SET content=excluded.content", body.path, body.content).rowsWritten;
      return { written: true };
    });
    return Response.json(result);
    } catch (error) {
      sql.exec("UPDATE __oracle_budget SET failures=failures+1 WHERE id=1");
      return Response.json({ error: (error as Error).message.slice(0, 200) }, { status: 403 });
    } finally { sql.exec("UPDATE __oracle_budget SET rows_written=rows_written+? WHERE id=1", rowsWritten); }
  }
}

/** The guest receives only this narrow capability, not a raw DO namespace or host environment. */
export class ConformanceState extends WorkerEntrypoint<Environment, { sandboxId: string }> {
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method !== "POST" || !['/sql','/files/read','/files/write','/files/validate'].includes(path)) return Response.json({ error: "capability_denied" }, { status: 403 });
    try {
      const body = await readBoundedRequestBytes(request, MAX_BODY);
      return this.env.CONFORMANCE_SANDBOX_DO.get(this.env.CONFORMANCE_SANDBOX_DO.idFromString(this.ctx.props.sandboxId)).fetch(new Request(`http://sandbox${path}`, { method: "POST", headers: { "content-type": "application/json" }, body }));
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) return Response.json({ error: "fixture_size_limit" }, { status: 413 });
      return Response.json({ error: "invalid_fixture_body" }, { status: 400 });
    }
  }
}
