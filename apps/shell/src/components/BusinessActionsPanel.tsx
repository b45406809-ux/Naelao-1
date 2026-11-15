"use client";

import * as React from "react";
import { Button } from "@naelao/ui";
import type { BusinessActionObjectSchema } from "@naelao/agent-sdk";
import { ApiError, callSpaceSharedExtensionBusinessAction, type SessionCredentials } from "@/lib/api";

type ActionField = BusinessActionObjectSchema["properties"][string];
export interface BusinessActionDefinition {
  id: string;
  name: string;
  description: string;
  permission: string;
  roles: Array<"owner" | "admin">;
  effects: "transactional_write" | "read_only";
  idempotency: "required" | "none";
  approval: "none";
  inputSchema: BusinessActionObjectSchema;
  outputSchema: BusinessActionObjectSchema;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isScalarActionProperty(value: unknown): boolean {
  if (!isRecord(value) || !Object.keys(value).every(name => ["type", "description", "minimum", "maximum", "minLength", "maxLength", "pattern"].includes(name))
    || !["string", "integer", "boolean"].includes(String(value.type))) return false;
  if (value.description !== undefined && (typeof value.description !== "string" || value.description.length > 512)) return false;
  if (value.pattern !== undefined && (typeof value.pattern !== "string" || value.pattern.length > 256)) return false;
  for (const bound of ["minimum", "maximum"] as const) if (value[bound] !== undefined && !Number.isSafeInteger(value[bound])) return false;
  for (const bound of ["minLength", "maxLength"] as const) if (value[bound] !== undefined
    && (!Number.isSafeInteger(value[bound]) || Number(value[bound]) < 0)) return false;
  if (value.minimum !== undefined && value.maximum !== undefined && Number(value.minimum) > Number(value.maximum)) return false;
  if (value.minLength !== undefined && value.maxLength !== undefined && Number(value.minLength) > Number(value.maxLength)) return false;
  if (value.type !== "integer" && (value.minimum !== undefined || value.maximum !== undefined)
    || value.type !== "string" && (value.minLength !== undefined || value.maxLength !== undefined)) return false;
  return true;
}

function isActionSchema(value: unknown, allowArray = true): value is BusinessActionObjectSchema {
  if (!isRecord(value) || value.type !== "object" || value.additionalProperties !== false
    || !Array.isArray(value.required) || value.required.length > 16 || !isRecord(value.properties)
    || Object.keys(value.properties).length < 1 || Object.keys(value.properties).length > 16) return false;
  const propertyNames = new Set(Object.keys(value.properties));
  if (new Set(value.required).size !== value.required.length
    || value.required.some((field: unknown) => typeof field !== "string" || !propertyNames.has(field))) return false;
  return Object.entries(value.properties).every(([key, field]) => {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) return false;
    if (isScalarActionProperty(field)) return true;
    return allowArray && isRecord(field) && field.type === "array"
      && Object.keys(field).every(name => ["type", "items", "minItems", "maxItems"].includes(name))
      && Number.isSafeInteger(field.maxItems) && Number(field.maxItems) > 0 && Number(field.maxItems) <= 100
      && (field.minItems === undefined || Number.isSafeInteger(field.minItems) && Number(field.minItems) >= 0
        && Number(field.minItems) <= Number(field.maxItems))
      && isActionSchema(field.items, false);
  });
}

export function parseBusinessActionList(value: unknown): BusinessActionDefinition[] {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.actions) || value.actions.length > 32)
    throw new Error("business_action_response_invalid");
  const actions = value.actions.map((candidate): BusinessActionDefinition => {
    if (!isRecord(candidate) || typeof candidate.id !== "string" || !/^[a-z][a-zA-Z0-9]{0,63}$/.test(candidate.id)
      || typeof candidate.name !== "string" || !candidate.name.trim() || candidate.name.length > 128
      || typeof candidate.description !== "string" || candidate.description.length > 512
      || typeof candidate.permission !== "string" || candidate.permission.length > 128
      || !Array.isArray(candidate.roles) || !candidate.roles.length || candidate.roles.length > 2
      || new Set(candidate.roles).size !== candidate.roles.length
      || candidate.roles.some(role => role !== "owner" && role !== "admin")
      || !["transactional_write", "read_only"].includes(String(candidate.effects))
      || !["required", "none"].includes(String(candidate.idempotency)) || candidate.approval !== "none"
      || candidate.effects === "read_only" && candidate.idempotency !== "none"
      || candidate.effects === "transactional_write" && candidate.idempotency !== "required"
      || !isActionSchema(candidate.inputSchema, false) || !isActionSchema(candidate.outputSchema)) {
      throw new Error("business_action_response_invalid");
    }
    return candidate as unknown as BusinessActionDefinition;
  });
  if (new Set(actions.map(action => action.id)).size !== actions.length) throw new Error("business_action_response_invalid");
  return actions;
}

function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

export function buildBusinessActionPayload(schema: BusinessActionObjectSchema, values: Record<string, string | boolean>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(schema.properties)) {
    const value = values[key];
    if (field.type === "array") throw new Error(`${key}_unsupported_input_schema`);
    if (field.type === "boolean") {
      if (value !== undefined) result[key] = value === true;
      continue;
    }
    if (typeof value !== "string" || value === "") continue;
    if (field.type === "integer") {
      const numeric = Number(value);
      if (!Number.isSafeInteger(numeric) || field.minimum !== undefined && numeric < field.minimum
        || field.maximum !== undefined && numeric > field.maximum) throw new Error(`${key}_invalid`);
      result[key] = numeric;
      continue;
    }
    if (field.minLength !== undefined && value.length < field.minLength || field.maxLength !== undefined && value.length > field.maxLength)
      throw new Error(`${key}_invalid`);
    result[key] = value;
  }
  if (schema.required.some(key => result[key] === undefined)) throw new Error("business_action_required_fields_missing");
  return result;
}

export function isUncertainBusinessActionFailure(error: unknown): boolean {
  return error instanceof ApiError ? error.status === 0 || error.status >= 500 : true;
}

function initialValues(schema: BusinessActionObjectSchema): Record<string, string | boolean> {
  return Object.fromEntries(Object.entries(schema.properties).map(([key, field]) => [key,
    /^idempotency_?key$/i.test(key) ? "" : field.type === "boolean" ? false : ""]));
}

export function BusinessActionForm({ spaceId, appId, action, session }: { spaceId: string; appId: string; action: BusinessActionDefinition; session: SessionCredentials }) {
  const [values, setValues] = React.useState(() => initialValues(action.inputSchema));
  const [review, setReview] = React.useState<Record<string, unknown> | null>(null);
  const [uncertain, setUncertain] = React.useState<Record<string, unknown> | null>(null);
  const [result, setResult] = React.useState<unknown>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [sending, setSending] = React.useState(false);
  React.useEffect(() => {
    setValues(current => {
      const next = { ...current };
      for (const key of Object.keys(action.inputSchema.properties)) if (/^idempotency_?key$/i.test(key) && !next[key]) next[key] = newIdempotencyKey();
      return next;
    });
  }, [action.id, action.inputSchema.properties]);

  function change(key: string, value: string | boolean) {
    setValues(current => {
      const next = { ...current, [key]: value };
      for (const field of Object.keys(action.inputSchema.properties)) if (/^idempotency_?key$/i.test(field)) next[field] = newIdempotencyKey();
      return next;
    });
    setReview(null); setResult(null); setError(null);
  }

  function prepare(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(null); setResult(null);
    try { setReview(buildBusinessActionPayload(action.inputSchema, values)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "business_action_input_invalid"); }
  }

  async function invoke(input: Record<string, unknown>) {
    setSending(true); setError(null);
    try {
      const response = await callSpaceSharedExtensionBusinessAction(spaceId, appId, session, { actionId: action.id, input });
      setResult(response); setReview(null); setUncertain(null);
      if (action.effects === "transactional_write") setValues(initialValues(action.inputSchema));
    } catch (cause) {
      if (action.effects === "transactional_write" && isUncertainBusinessActionFailure(cause)) setUncertain(input);
      else { setReview(null); setError(cause instanceof ApiError ? `${cause.errorCode ?? "business_action_rejected"} (${cause.status})` : "business_action_rejected"); }
    } finally { setSending(false); }
  }

  return <article style={{ borderTop: "1px solid var(--border, #ddd)", paddingTop: 12, marginTop: 12 }}>
    <h3 style={{ margin: "0 0 6px" }}>{action.name}</h3>
    <p style={{ color: "var(--text3)", fontSize: 13 }}>{action.description}</p>
    <p style={{ color: "var(--text3)", fontSize: 12 }}>Permission: <code>{action.permission}</code> · owner/admin · {action.effects === "read_only" ? "read only; no data changes" : "transactional change; idempotency required"}. Authority is checked again when the action runs.</p>
    <form onSubmit={prepare}>
      {Object.entries(action.inputSchema.properties).map(([key, field]) => {
        if (field.type === "array") return <p key={key} role="alert">The host form does not support array input for {key}.</p>;
        return <label key={key} style={{ display: "block", margin: "10px 0" }}>
          {key}{field.description ? ` — ${field.description}` : ""}{action.inputSchema.required.includes(key) ? " *" : ""}
          {/^idempotency_?key$/i.test(key) ? <input className="input" type="text" value={String(values[key] ?? "")} readOnly aria-label={key} />
            : field.type === "boolean" ? <input type="checkbox" checked={values[key] === true} disabled={Boolean(uncertain) || sending}
              aria-label={key} onChange={event => change(key, event.target.checked)} />
              : <input className="input" aria-label={key} type={field.type === "integer" ? "number" : "text"}
                required={action.inputSchema.required.includes(key)} min={field.type === "integer" ? field.minimum : undefined}
                max={field.type === "integer" ? field.maximum : undefined} minLength={field.type === "string" ? field.minLength : undefined}
                maxLength={field.type === "string" ? field.maxLength : undefined} step={field.type === "integer" ? 1 : undefined}
                value={String(values[key] ?? "")} disabled={Boolean(uncertain) || sending}
                onChange={event => change(key, event.target.value)} />}
        </label>;
      })}
      <Button type="submit" variant="secondary" disabled={sending || Boolean(uncertain)}>Review {action.name}</Button>
    </form>
    {review && <section aria-label={`${action.name} review`} style={{ marginTop: 12, padding: 12, border: "1px solid var(--border, #ddd)", borderRadius: 8 }}>
      <strong>{action.effects === "read_only" ? "Review exact business read" : "Review exact business change"}</strong>
      <p>{action.effects === "read_only"
        ? "This reads bounded data through the signed host operation and does not change Gadget records. The current installation, role and permission are rechecked before the read."
        : "This invokes the signed host operation. The current installation, role and permission are rechecked before commit."}</p>
      <pre style={{ overflowX: "auto" }}>{JSON.stringify(review, null, 2)}</pre>
      <Button disabled={sending} onClick={() => void invoke(review)}>{action.effects === "read_only" ? "Run authorized read" : "Confirm and run"}</Button>{" "}
      <Button variant="secondary" disabled={sending} onClick={() => setReview(null)}>Cancel</Button>
    </section>}
    {uncertain && <section role="status" style={{ marginTop: 12, padding: 12, border: "1px solid var(--warning, #a70)", borderRadius: 8 }}>
      <strong>Outcome not confirmed</strong>
      <p>The request may have committed before its response was lost. Retry sends the same reviewed values and idempotency key; the host returns the saved result or rejects a conflicting request.</p>
      <pre style={{ overflowX: "auto" }}>{JSON.stringify(uncertain, null, 2)}</pre>
      <Button disabled={sending} onClick={() => void invoke(uncertain)}>Retry the same request</Button>
    </section>}
    {error && <p role="alert">Action rejected: {error}</p>}
    {result !== null && <p role="status">{action.effects === "read_only" ? "Read completed" : "Action completed"}: <code>{JSON.stringify(result)}</code></p>}
  </article>;
}

export function BusinessActionsPanel({ spaceId, appIds, session }: { spaceId: string; appIds: string[]; session: SessionCredentials }) {
  const appKey = [...new Set(appIds.filter(id => /^[a-z][a-z0-9_-]{1,63}$/.test(id)))].sort().join(",");
  const [actions, setActions] = React.useState<Array<{ appId: string; action: BusinessActionDefinition }>>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    let current = true;
    const ids = appKey ? appKey.split(",") : [];
    setLoading(true); setError(null); setActions([]);
    void Promise.all(ids.map(async appId => {
      const response = await callSpaceSharedExtensionBusinessAction(spaceId, appId, session, {});
      return parseBusinessActionList(response).map(action => ({ appId, action }));
    })).then(groups => { if (current) setActions(groups.flat()); })
      .catch(cause => { if (current) setError(cause instanceof Error ? cause.message : "Could not load signed business actions."); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [appKey, session, spaceId]);

  return <section aria-label="Business actions" style={{ border: "1px solid var(--border, #ddd)", borderRadius: 10, padding: 16, marginBottom: 16 }}>
    <h2 style={{ marginTop: 0 }}>Business actions</h2>
    <p style={{ color: "var(--text3)", fontSize: 13 }}>These host operations use the same signed business rules as the assistant. Only actions authorized for your current role are listed.</p>
    {loading ? <p role="status">Loading authorized actions…</p> : error ? <p role="alert">{error}</p> : actions.length === 0
      ? <p role="status">No business actions are available for this account in this installation.</p>
      : actions.map(({ appId, action }) => <BusinessActionForm key={`${appId}:${action.id}`} spaceId={spaceId} appId={appId} action={action} session={session} />)}
  </section>;
}
