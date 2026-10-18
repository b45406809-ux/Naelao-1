"use client";

import * as React from "react";
import { compileWorkflowPlan, type WorkflowPlanStep } from "@naelao/sdk/workflow";
import { runMockWorkflowPlan } from "@naelao/sdk/testing";
import { Button } from "@naelao/ui";
import { saveWorkflowPlanDraft, type SessionCredentials } from "@/lib/api";

type DraftStep = { id: string; operation: string; args: string };
const newStep = (index: number): DraftStep => ({ id: `step-${index}`, operation: "", args: "{}" });

/** A bounded editor for a declarative plan. It writes a validated draft; scheduling and runtime
 * grants remain in the existing workflow installation path. */
export function WorkflowPlanComposer({ spaceId, projectId, session }: { spaceId: string; projectId: string; session: SessionCredentials }) {
  const [name, setName] = React.useState("new-workflow");
  const [steps, setSteps] = React.useState<DraftStep[]>([newStep(1)]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState<{ path: string; digest: string; bytes: number } | null>(null);
  const [offlineRun, setOfflineRun] = React.useState<ReturnType<typeof runMockWorkflowPlan> | null>(null);

  const update = (index: number, patch: Partial<DraftStep>) => {
    setSteps(previous => previous.map((step, i) => i === index ? { ...step, ...patch } : step));
    setSaved(null); setOfflineRun(null);
  };

  const build = () => {
    const planSteps: WorkflowPlanStep[] = steps.map(step => {
      let args: unknown;
      try { args = JSON.parse(step.args); } catch { throw new Error(`Step “${step.id || "?"}” has invalid JSON arguments.`); }
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error(`Step “${step.id || "?"}” arguments must be a JSON object.`);
      return { id: step.id.trim(), operation: step.operation.trim(), args: args as Record<string, unknown> };
    });
    const plan = { schemaVersion: "1.0" as const, steps: planSteps };
    const compiled = compileWorkflowPlan(plan, planSteps.map(step => step.operation));
    return { plan, compiled };
  };

  const save = async () => {
    setBusy(true); setError(null); setSaved(null); setOfflineRun(null);
    try {
      const compiled = build();
      const safeName = name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);
      if (!safeName) throw new Error("Enter a workflow name using letters, numbers, hyphens, or underscores.");
      const result = await saveWorkflowPlanDraft(spaceId, projectId, session, { path: `workflows/${safeName}.ts`, plan: compiled.plan });
      setSaved({ path: result.path, digest: result.digest, bytes: result.bytes });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Couldn't validate or save this workflow draft."); }
    finally { setBusy(false); }
  };

  const runOffline = () => {
    setError(null); setSaved(null); setOfflineRun(null);
    try {
      const { plan } = build();
      setOfflineRun(runMockWorkflowPlan({ plan, allowedCapabilities: plan.steps.map(step => step.operation) }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Couldn't run the offline workflow check."); }
  };

  const preview = (() => { try { return build(); } catch { return null; } })();

  return <section aria-labelledby="workflow-plan-title" style={{ margin: "24px 0", padding: 20, border: "1px solid var(--border, #ddd)", borderRadius: 12 }}>
    <h2 id="workflow-plan-title">Compose a workflow plan</h2>
    <p>Arrange bounded tool steps and save the generated workflow draft to this project. Only project owners and admins can save. Saving does not grant a capability, execute a step, or schedule it.</p>
    <p>To pass a prior result into a later step, use a JSON argument such as <code>{'{"$workflowRef":"step-id#/result/key"}'}</code>. References may point only to earlier steps; they use JSON Pointer paths and support no expressions.</p>
    <label htmlFor="workflow-plan-name">Workflow name</label>
    <input id="workflow-plan-name" className="form-input" value={name} maxLength={63} onChange={event => { setName(event.target.value); setSaved(null); }} style={{ display: "block", maxWidth: 480, margin: "6px 0 16px" }} />
    <ol style={{ display: "grid", gap: 12, paddingLeft: 24 }}>
      {steps.map((step, index) => <li key={index}>
        <fieldset style={{ display: "grid", gap: 8, padding: 12 }}>
          <legend>Step {index + 1}</legend>
          <label>Step ID<input className="form-input" value={step.id} maxLength={48} onChange={event => update(index, { id: event.target.value })} /></label>
          <label>Capability operation<input className="form-input" value={step.operation} maxLength={96} placeholder="for example, documents.summarize" onChange={event => update(index, { operation: event.target.value })} /></label>
          <label>Arguments (JSON object)<textarea className="form-input" rows={4} value={step.args} onChange={event => update(index, { args: event.target.value })} spellCheck={false} /></label>
          <Button type="button" disabled={steps.length <= 1} onClick={() => { setSteps(previous => previous.filter((_, i) => i !== index)); setSaved(null); setOfflineRun(null); }}>Remove step</Button>
        </fieldset>
      </li>)}
    </ol>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      <Button type="button" disabled={steps.length >= 64} onClick={() => { setSteps(previous => [...previous, newStep(previous.length + 1)]); setSaved(null); setOfflineRun(null); }}>Add step</Button>
      <Button type="button" disabled={!preview} onClick={runOffline}>Run offline mock</Button>
      <Button type="button" disabled={busy || !preview} onClick={save}>{busy ? "Validating and saving…" : "Validate and save draft"}</Button>
    </div>
    {preview && <p role="status">Plan preview: {preview.compiled.stepIds.length} step(s), {preview.compiled.capabilities.length} distinct operation(s), {preview.compiled.sourceBytes} generated bytes. Every operation still needs a host-issued grant at runtime.</p>}
    {error && <p role="alert">{error}</p>}
    {offlineRun && <div role="status"><h3>Offline mock passed</h3><p>No provider calls, Worker runs, or credits were used. This is a structural test with simulated tool results; cost is not measured.</p><pre style={{ overflowX: "auto", whiteSpace: "pre-wrap" }}>{JSON.stringify({ result: offlineRun.result, profile: offlineRun.profile }, null, 2)}</pre></div>}
    {saved && <p role="status">Validated draft saved at <code>{saved.path}</code> ({saved.bytes} bytes, digest {saved.digest.slice(0, 12)}…). It is not connected to workflow installation or scheduling yet.</p>}
  </section>;
}
