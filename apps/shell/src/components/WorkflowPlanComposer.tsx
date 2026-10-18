"use client";

import * as React from "react";
import { compileWorkflowPlan, createWorkflowExtensionRelease, type WorkflowPlanStep } from "@naelao/sdk/workflow";
import { runMockWorkflowPlan } from "@naelao/sdk/testing";
import { canonicalExtensionManifestForPublisher, extensionPublisherSigningPayload } from "@naelao/agent-sdk";
import { Button } from "@naelao/ui";
import { installProjectCanvasExtension, listExtensionPublisherKeys, saveWorkflowPlanDraft, type ExtensionPublisherKey, type SessionCredentials } from "@/lib/api";

type DraftStep = { id: string; operation: string; args: string; mockResponse: string };
const newStep = (index: number): DraftStep => ({ id: `step-${index}`, operation: "", args: "{}", mockResponse: JSON.stringify({ simulated: true, step: `step-${index}` }, null, 2) });

/** A bounded plan editor with offline mock and a signed internal workflow package path. */
export function WorkflowPlanComposer({ spaceId, projectId, session }: { spaceId: string; projectId: string; session: SessionCredentials }) {
  const [name, setName] = React.useState("new-workflow");
  const [steps, setSteps] = React.useState<DraftStep[]>([newStep(1)]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState<{ path: string; digest: string; bytes: number } | null>(null);
  const [offlineRun, setOfflineRun] = React.useState<ReturnType<typeof runMockWorkflowPlan> | null>(null);
  const [extensionId, setExtensionId] = React.useState("ext_workflow_plan");
  const [version, setVersion] = React.useState("1.0.0");
  const [instanceKey, setInstanceKey] = React.useState("workflow_bot");
  const [publisherKeys, setPublisherKeys] = React.useState<ExtensionPublisherKey[]>([]);
  const [publisherKeyId, setPublisherKeyId] = React.useState("");
  const [publisherSignature, setPublisherSignature] = React.useState("");
  const [installConfirmed, setInstallConfirmed] = React.useState(false);
  const [upgradeConfirmed, setUpgradeConfirmed] = React.useState(false);
  const [installResult, setInstallResult] = React.useState<string | null>(null);
  const [keyLoadError, setKeyLoadError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let live = true;
    setPublisherKeys([]); setPublisherKeyId(""); setPublisherSignature(""); setKeyLoadError(null);
    listExtensionPublisherKeys(spaceId, session).then(result => { if (live) setPublisherKeys(result.publishers); })
      .catch(cause => { if (live) setKeyLoadError(cause instanceof Error ? cause.message : "Couldn't load trusted publisher keys."); });
    return () => { live = false; };
  }, [spaceId, session]);

  const update = (index: number, patch: Partial<DraftStep>) => {
    setSteps(previous => previous.map((step, i) => i === index ? { ...step, ...patch } : step));
    setSaved(null); setOfflineRun(null); setPublisherSignature(""); setInstallConfirmed(false); setInstallResult(null);
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
      const responses: Record<string, unknown> = {};
      let totalFixtureBytes = 0;
      for (const step of steps) {
        if (!step.mockResponse.trim()) continue;
        const bytes = new TextEncoder().encode(step.mockResponse).byteLength;
        if (bytes > 16_384) throw new Error(`Step “${step.id || "?"}” mock output exceeds 16 KB.`);
        totalFixtureBytes += bytes;
        if (totalFixtureBytes > 65_536) throw new Error("Combined offline mock outputs exceed 64 KB.");
        try { responses[step.id] = JSON.parse(step.mockResponse); }
        catch { throw new Error(`Step “${step.id || "?"}” has invalid mock output JSON.`); }
      }
      setOfflineRun(runMockWorkflowPlan({ plan, allowedCapabilities: plan.steps.map(step => step.operation), responses }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Couldn't run the offline workflow check."); }
  };

  const preview = (() => { try { return build(); } catch { return null; } })();
  const releaseDraft = (() => {
    try {
      if (!/^[a-z][a-z0-9_-]{1,63}$/.test(extensionId) || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)
        || !/^[a-z][a-z0-9_-]{1,31}$/.test(instanceKey)) throw new Error("Use a valid extension ID, semantic version, and instance key.");
      const { plan } = build();
      const release = createWorkflowExtensionRelease({ extensionId, version, plan, allowedCapabilities: plan.steps.map(step => step.operation) });
      const artifacts = { [release.artifactPath]: release.source };
      const manifestJson = canonicalExtensionManifestForPublisher(release.manifest);
      return { ...release, manifestJson, artifacts, signingPayload: extensionPublisherSigningPayload(manifestJson, artifacts) };
    } catch (cause) { return { error: cause instanceof Error ? cause.message : "Couldn't prepare an internal workflow release." }; }
  })();

  const installWorkflow = async () => {
    if (!releaseDraft || "error" in releaseDraft) return;
    setBusy(true); setError(null); setInstallResult(null);
    try {
      if (!publisherKeyId || !publisherSignature.trim()) throw new Error("Choose a trusted active publisher key and provide its release signature.");
      const result = await installProjectCanvasExtension(spaceId, projectId, session, releaseDraft.manifest, releaseDraft.artifacts, upgradeConfirmed, instanceKey,
        { key_id: publisherKeyId, signature: publisherSignature.trim() });
      if (!result.installed) throw new Error(result.message ?? result.error_code ?? "Workflow extension installation failed.");
      setInstallResult(`Installed ${extensionId} v${version} as instance ${result.installationId ?? instanceKey}. This is an internal project workflow; it does not expose a customer channel.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Couldn't install the signed workflow extension."); }
    finally { setBusy(false); }
  };

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
          <label>Offline mock output (JSON)<textarea className="form-input" rows={3} value={step.mockResponse} onChange={event => update(index, { mockResponse: event.target.value })} spellCheck={false} /><span>This static result is used only by “Run offline mock”. It is never sent to a provider.</span></label>
          <Button type="button" disabled={steps.length <= 1} onClick={() => { setSteps(previous => previous.filter((_, i) => i !== index)); setSaved(null); setOfflineRun(null); setPublisherSignature(""); setInstallConfirmed(false); setInstallResult(null); }}>Remove step</Button>
        </fieldset>
      </li>)}
    </ol>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      <Button type="button" disabled={steps.length >= 64} onClick={() => { setSteps(previous => { let index = 1; while (previous.some(step => step.id === `step-${index}`)) index++; return [...previous, newStep(index)]; }); setSaved(null); setOfflineRun(null); setPublisherSignature(""); setInstallConfirmed(false); setInstallResult(null); }}>Add step</Button>
      <Button type="button" disabled={!preview} onClick={runOffline}>Run offline mock</Button>
      <Button type="button" disabled={busy || !preview} onClick={save}>{busy ? "Validating and saving…" : "Validate and save draft"}</Button>
    </div>
    {preview && <p role="status">Plan preview: {preview.compiled.stepIds.length} step(s), {preview.compiled.capabilities.length} distinct operation(s), {preview.compiled.sourceBytes} generated bytes. Every operation still needs a host-issued grant at runtime.</p>}
    {error && <p role="alert">{error}</p>}
    {offlineRun && <div role="status"><h3>Offline mock passed</h3><p>No provider calls, Worker runs, or credits were used. This is a structural test with simulated tool results; cost is not measured.</p><pre style={{ overflowX: "auto", whiteSpace: "pre-wrap" }}>{JSON.stringify({ result: offlineRun.result, profile: offlineRun.profile }, null, 2)}</pre></div>}
    {saved && <p role="status">Validated draft saved at <code>{saved.path}</code> ({saved.bytes} bytes, digest {saved.digest.slice(0, 12)}…). It is not connected to workflow installation or scheduling yet.</p>}
    <details style={{ marginTop: 18, padding: 14, border: "1px solid var(--border, #ddd)", borderRadius: 10 }}>
      <summary style={{ cursor: "pointer", fontWeight: 650 }}>Package this as an internal project workflow</summary>
      <p>This creates a signed extension bundle containing this workflow only. It uses the project-member workflow role and the existing planner/worker runtime. It adds no external channel and cannot grant new tool access.</p>
      <label>Extension ID<input className="form-input" value={extensionId} maxLength={64} onChange={event => { setExtensionId(event.target.value); setPublisherSignature(""); setInstallConfirmed(false); setUpgradeConfirmed(false); setInstallResult(null); }} /></label>
      <label>Version<input className="form-input" value={version} maxLength={64} onChange={event => { setVersion(event.target.value); setPublisherSignature(""); setInstallConfirmed(false); setUpgradeConfirmed(false); setInstallResult(null); }} /></label>
      <label>Installation instance key<input className="form-input" value={instanceKey} maxLength={32} onChange={event => { setInstanceKey(event.target.value); setInstallConfirmed(false); setInstallResult(null); }} /></label>
      {releaseDraft && "error" in releaseDraft ? <p role="alert">{releaseDraft.error}</p> : releaseDraft && <>
        <p>Review the declaration: workflow <code>workflow</code>, entry <code>./workflow.ts</code>, operations {preview?.compiled.capabilities.map(item => <code key={item}> {item}</code>)}. Runtime authorization remains enforced by the host.</p>
        <p>If no active key is listed, register one in the project Extensions panel. Signing happens outside Naelao; no private key is entered or stored here.</p>
        <label>Trusted publisher key<select className="form-input" value={publisherKeyId} onChange={event => { setPublisherKeyId(event.target.value); setPublisherSignature(""); setInstallConfirmed(false); setInstallResult(null); }}><option value="">Choose active key</option>{publisherKeys.filter(key => key.status === "active").map(key => <option key={key.key_id} value={key.key_id}>{key.publisher_id} · {key.key_id.slice(0, 12)}…</option>)}</select></label>
        {keyLoadError && <p role="alert">{keyLoadError}</p>}
        <label>Release signature (base64url)<input className="form-input" value={publisherSignature} onChange={event => { setPublisherSignature(event.target.value); setInstallConfirmed(false); setInstallResult(null); }} placeholder="Sign the payload below with the trusted publisher's private key" /></label>
        <details><summary>Canonical publisher signing payload</summary><p>Sign this JSON with the publisher key using <code>signExtensionPublisherRelease</code> from <code>@naelao/agent-sdk</code>. The private key stays outside Naelao.</p><pre style={{ maxHeight: 260, overflow: "auto", whiteSpace: "pre-wrap" }}>{JSON.stringify({ manifestJson: releaseDraft.manifestJson, artifacts: releaseDraft.artifacts, signingPayload: releaseDraft.signingPayload }, null, 2)}</pre></details>
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" checked={installConfirmed} onChange={event => setInstallConfirmed(event.target.checked)} />I reviewed the internal workflow manifest, operations, and generated artifact.</label>
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" checked={upgradeConfirmed} onChange={event => setUpgradeConfirmed(event.target.checked)} />Approve a forward version upgrade for this extension ID</label>
        <Button type="button" disabled={busy || !installConfirmed || !publisherKeyId || !publisherSignature.trim()} onClick={installWorkflow}>{busy ? "Installing…" : "Install signed internal workflow"}</Button>
      </>}
    </details>
    {installResult && <p role="status">{installResult}</p>}
  </section>;
}
