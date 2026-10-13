"use client";

import * as React from "react";
import { Button, Card, CardDesc, CardTitle, Toast, useToast } from "@naelao/ui";
import { useActiveSpace } from "@/lib/active-space-context";
import { useProductAuth } from "@/lib/auth-provider";
import {
  createCrossSpaceGrant, createFoundryRequest, createFoundryTemplate, forwardFoundryRequest, installFoundryTemplate, invokeSharedWorker,
  listCrossSpaceGrants, listFoundryRequests, listFoundryTemplates, reviewFoundryRequest, testFoundryTemplate, updateFoundryTemplate,
  revokeCrossSpaceGrant, transitionFoundryTemplate,
  type CrossSpaceGrant, type FoundryFeatureRequest, type FoundryTemplate,
} from "@/lib/api";

const inputStyle: React.CSSProperties = { width: "100%", padding: "8px 10px", fontSize: 13, borderRadius: 8, border: "1px solid var(--border)", background: "var(--surface1, var(--bg))", color: "var(--text1)" };
const areaStyle: React.CSSProperties = { ...inputStyle, resize: "vertical" };

export default function FoundryPage() {
  const { activeSpaceId, activeSpaceName } = useActiveSpace();
  const { session } = useProductAuth();
  const { toast, show } = useToast();
  const credentials = session ? { sessionToken: session.session_token, endUserId: session.end_user_id } : null;
  const [templates, setTemplates] = React.useState<FoundryTemplate[]>([]);
  const [requests, setRequests] = React.useState<FoundryFeatureRequest[]>([]);
  const [grants, setGrants] = React.useState<CrossSpaceGrant[]>([]);
  const [requestsVisible, setRequestsVisible] = React.useState(false);
  const [grantsVisible, setGrantsVisible] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [requestTitle, setRequestTitle] = React.useState("");
  const [requestProblem, setRequestProblem] = React.useState("");
  const [requestWorkflow, setRequestWorkflow] = React.useState("");
  const [requestTargetSpace, setRequestTargetSpace] = React.useState("");
  const [requestCapability, setRequestCapability] = React.useState("");
  const [templateName, setTemplateName] = React.useState("");
  const [templateDescription, setTemplateDescription] = React.useState("");
  const [editingTemplateId, setEditingTemplateId] = React.useState<string | null>(null);
  const [expertise, setExpertise] = React.useState("");
  const [audience, setAudience] = React.useState("");
  const [outcome, setOutcome] = React.useState("");
  const [workflow, setWorkflow] = React.useState("");
  const [safetyLimits, setSafetyLimits] = React.useState("");
  const [instructions, setInstructions] = React.useState("");
  const [sourceReferences, setSourceReferences] = React.useState("");
  const [grantSpace, setGrantSpace] = React.useState("");
  const [grantResource, setGrantResource] = React.useState("");
  const [grantToken, setGrantToken] = React.useState("");
  const [installSourceSpace, setInstallSourceSpace] = React.useState("");
  const [installTemplateId, setInstallTemplateId] = React.useState("");
  const [installCapability, setInstallCapability] = React.useState("");
  const [invokeSourceSpace, setInvokeSourceSpace] = React.useState("");
  const [invokeAgentId, setInvokeAgentId] = React.useState("");
  const [invokeCapability, setInvokeCapability] = React.useState("");
  const [invokeGoal, setInvokeGoal] = React.useState("");
  const [invokeResult, setInvokeResult] = React.useState("");

  const refresh = React.useCallback(async () => {
    if (!credentials) return;
    const loaded = await Promise.allSettled([
      listFoundryTemplates(activeSpaceId, credentials),
      listFoundryRequests(activeSpaceId, credentials),
      listCrossSpaceGrants(activeSpaceId, credentials),
    ]);
    if (loaded[0]?.status === "fulfilled") setTemplates(loaded[0].value);
    if (loaded[1]?.status === "fulfilled") { setRequests(loaded[1].value); setRequestsVisible(true); }
    if (loaded[2]?.status === "fulfilled") { setGrants(loaded[2].value); setGrantsVisible(true); }
  }, [activeSpaceId, session]);

  React.useEffect(() => { void refresh(); }, [refresh]);

  async function run(action: () => Promise<unknown>, success: string, refreshAfter = true) {
    if (busy) return;
    setBusy(true);
    try { await action(); show(success); if (refreshAfter) await refresh(); }
    catch (error) { show(error instanceof Error ? error.message : "The Foundry action failed"); }
    finally { setBusy(false); }
  }

  async function submitRequest(event: React.FormEvent) {
    event.preventDefault(); if (!credentials) return;
    await run(() => createFoundryRequest(activeSpaceId, credentials, { title: requestTitle, problem: requestProblem, workflow: requestWorkflow }), "Request sent to this Space's review inbox");
    setRequestTitle(""); setRequestProblem(""); setRequestWorkflow("");
  }

  async function submitForwardedRequest(event: React.FormEvent) {
    event.preventDefault(); if (!credentials) return;
    await run(() => forwardFoundryRequest(requestTargetSpace, credentials, { from_space_id: activeSpaceId, capability_token: requestCapability, title: requestTitle, problem: requestProblem, workflow: requestWorkflow }), "Request sent to the authorized Foundry inbox");
    setRequestTitle(""); setRequestProblem(""); setRequestWorkflow(""); setRequestCapability("");
  }

  async function saveTemplate(event: React.FormEvent) {
    event.preventDefault(); if (!credentials) return;
    const input = { name: templateName, description: templateDescription, definition: {
      expertise, audience, outcome, workflow, safetyLimits, instructions,
      sourceReferences: sourceReferences.split("\n").map((item) => item.trim()).filter(Boolean),
      toolAllowlist: ["knowledge-base"],
    } };
    await run(() => editingTemplateId ? updateFoundryTemplate(activeSpaceId, editingTemplateId, credentials, input) : createFoundryTemplate(activeSpaceId, credentials, input), editingTemplateId ? "Template revision saved" : "Template saved as a private draft for review");
    setTemplateName(""); setTemplateDescription(""); setEditingTemplateId(null);
  }

  function editTemplate(template: FoundryTemplate) {
    setEditingTemplateId(template.id); setTemplateName(template.name); setTemplateDescription(template.description);
    setExpertise(template.definition.expertise); setAudience(template.definition.audience); setOutcome(template.definition.outcome);
    setWorkflow(template.definition.workflow); setSafetyLimits(template.definition.safetyLimits); setInstructions(template.definition.instructions);
    setSourceReferences(template.definition.sourceReferences.join("\n"));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function makeGrant(event: React.FormEvent) {
    event.preventDefault(); if (!credentials) return;
    try {
      const permissions = grantResource.trim() === "feature-inbox:submit" || grantResource.trim().startsWith("worker:") ? ["invoke"] as const : ["read"] as const;
      const result = await createCrossSpaceGrant(activeSpaceId, credentials, { grantee_space_id: grantSpace, resource_id: grantResource, permissions: [...permissions], expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() });
      setGrantToken(result.capability_token);
      setGrants(await listCrossSpaceGrants(activeSpaceId, credentials));
      show("Read-only grant created. Copy its token to the destination Space's owner.");
    } catch (error) { show(error instanceof Error ? error.message : "Grant creation failed"); }
  }

  async function installTemplate(event: React.FormEvent) {
    event.preventDefault(); if (!credentials) return;
    await run(() => installFoundryTemplate(activeSpaceId, credentials, { source_space_id: installSourceSpace, template_id: installTemplateId, capability_token: installCapability }), "Worker installed with this Space's own knowledge and channel identity", false);
    setInstallCapability("");
  }

  async function callSharedWorker(event: React.FormEvent) {
    event.preventDefault(); if (!credentials || busy) return;
    setBusy(true); setInvokeResult("");
    try {
      const result = await invokeSharedWorker(activeSpaceId, credentials, { source_space_id: invokeSourceSpace, agent_id: invokeAgentId, capability_token: invokeCapability, goal: invokeGoal });
      setInvokeResult(JSON.stringify(result, null, 2)); show("Shared worker returned a result");
    } catch (error) { show(error instanceof Error ? error.message : "Shared worker invocation failed"); }
    finally { setBusy(false); }
  }

  return <div className="page-view">
    <div className="page-header"><div className="page-title">Foundry</div><div className="page-subtitle">Reusable domain workers and owner-reviewed product requests for {activeSpaceName || "this Space"}.</div></div>
    <div className="grid-2">
      <Card>
        <CardTitle>Send a feature request</CardTitle><CardDesc>Describe a real workflow gap. Requests are proposals only; an owner decides what to accept and build. Leave the destination blank to use this Space&apos;s inbox.</CardDesc>
        <form onSubmit={(event) => void submitRequest(event)} className="foundry-form">
          <input required maxLength={160} value={requestTitle} onChange={(event) => setRequestTitle(event.target.value)} placeholder="Short title" style={inputStyle} />
          <textarea required maxLength={3000} rows={3} value={requestProblem} onChange={(event) => setRequestProblem(event.target.value)} placeholder="What is blocked or missing? Do not include client or patient personal data." style={areaStyle} />
          <textarea required maxLength={3000} rows={3} value={requestWorkflow} onChange={(event) => setRequestWorkflow(event.target.value)} placeholder="What steps should the workflow support?" style={areaStyle} />
          <Button disabled={busy || !requestTitle.trim() || !requestProblem.trim() || !requestWorkflow.trim()}>Send request</Button>
        </form>
        <details className="foundry-details"><summary>Send to a separate Foundry Space</summary><form onSubmit={(event) => void submitForwardedRequest(event)} className="foundry-form">
          <input required value={requestTargetSpace} onChange={(event) => setRequestTargetSpace(event.target.value)} placeholder="Foundry Space ID" style={inputStyle} />
          <textarea required rows={3} value={requestCapability} onChange={(event) => setRequestCapability(event.target.value)} placeholder="Feature inbox capability token" style={areaStyle} />
          <Button variant="secondary" disabled={busy || !requestTitle.trim() || !requestProblem.trim() || !requestWorkflow.trim()}>Send to Foundry Space</Button>
        </form></details>
      </Card>
      <Card>
        <CardTitle>Create a domain template</CardTitle><CardDesc>Package expertise, source references, a bounded workflow, and safety limits. Templates stay private until an owner reviews and publishes them.</CardDesc>
        <form onSubmit={(event) => void saveTemplate(event)} className="foundry-form">
          <input required maxLength={120} value={templateName} onChange={(event) => setTemplateName(event.target.value)} placeholder="Template name" style={inputStyle} />
          <input required maxLength={500} value={templateDescription} onChange={(event) => setTemplateDescription(event.target.value)} placeholder="What it helps someone do" style={inputStyle} />
          <textarea required maxLength={2000} rows={2} value={expertise} onChange={(event) => setExpertise(event.target.value)} placeholder="Domain expertise" style={areaStyle} />
          <input required maxLength={500} value={audience} onChange={(event) => setAudience(event.target.value)} placeholder="Intended audience" style={inputStyle} />
          <input required maxLength={1000} value={outcome} onChange={(event) => setOutcome(event.target.value)} placeholder="Expected outcome" style={inputStyle} />
          <textarea required maxLength={3000} rows={2} value={workflow} onChange={(event) => setWorkflow(event.target.value)} placeholder="Workflow" style={areaStyle} />
          <textarea required maxLength={2000} rows={2} value={safetyLimits} onChange={(event) => setSafetyLimits(event.target.value)} placeholder="Safety limits and escalation rules" style={areaStyle} />
          <textarea required maxLength={6000} rows={3} value={instructions} onChange={(event) => setInstructions(event.target.value)} placeholder="Worker instructions" style={areaStyle} />
          <textarea maxLength={3000} rows={2} value={sourceReferences} onChange={(event) => setSourceReferences(event.target.value)} placeholder="Approved source IDs or references, one per line. Source contents stay in this Space." style={areaStyle} />
          <div className="foundry-actions">{editingTemplateId ? <Button variant="secondary" disabled={busy} onClick={() => { setEditingTemplateId(null); setTemplateName(""); setTemplateDescription(""); }}>Cancel revision</Button> : null}<Button disabled={busy || !templateName.trim() || !instructions.trim()}>{editingTemplateId ? "Save revision" : "Save private draft"}</Button></div>
        </form>
      </Card>
    </div>

    <section className="foundry-section"><h2>Templates</h2>{templates.length === 0 ? <p className="muted">No templates yet, or you do not have owner access to list them.</p> : <div className="grid-3">{templates.map((template) => <Card key={template.id}>
      <CardTitle>{template.name}</CardTitle><CardDesc>{template.description}</CardDesc><p className="foundry-meta">{template.status} · version {template.version}</p>
      {template.status === "draft" || template.status === "rejected" ? <Button variant="secondary" disabled={busy} onClick={() => editTemplate(template)}>Revise template</Button> : null}
      {template.status === "draft" || template.status === "rejected" ? <Button variant="secondary" disabled={busy} onClick={() => void run(() => testFoundryTemplate(activeSpaceId, template.id, credentials!), "Configuration checks finished")}>Run configuration checks</Button> : null}
      {template.validated_version === template.version ? <p className="foundry-meta">Deterministic package checks passed for this version. This does not simulate model behavior.</p> : null}
      {(template.status === "draft" || template.status === "rejected") && template.validated_version === template.version ? <Button variant="secondary" disabled={busy} onClick={() => void run(() => transitionFoundryTemplate(activeSpaceId, template.id, credentials!, { action: "submit" }), "Template submitted for owner review")}>Submit for review</Button> : null}
      {template.status === "in_review" ? <div className="foundry-actions"><Button disabled={busy} onClick={() => void run(() => transitionFoundryTemplate(activeSpaceId, template.id, credentials!, { action: "review", decision: "publish", review_note: "Reviewed before publication" }), "Template published")}>Publish</Button><Button variant="secondary" disabled={busy} onClick={() => void run(() => transitionFoundryTemplate(activeSpaceId, template.id, credentials!, { action: "review", decision: "reject", review_note: "Revise the template and resubmit" }), "Template returned for revision")}>Return</Button></div> : null}
      </Card>)}</div>}</section>

    <section className="foundry-section"><h2>Request inbox</h2>{!requestsVisible ? <p className="muted">The inbox is visible to Space owners and admins.</p> : requests.length === 0 ? <p className="muted">No requests are waiting for review.</p> : <div className="grid-2">{requests.map((request) => <Card key={request.id}>
      <CardTitle>{request.title}</CardTitle><CardDesc>{request.problem}</CardDesc><p>{request.workflow}</p><p className="foundry-meta">{request.status} · submitted by {request.requested_by}</p>
      {request.status === "open" ? <div className="foundry-actions"><Button disabled={busy} onClick={() => void run(() => reviewFoundryRequest(activeSpaceId, request.id, credentials!, { status: "accepted", review_note: "Accepted for planning" }), "Request accepted")}>Accept</Button><Button variant="secondary" disabled={busy} onClick={() => void run(() => reviewFoundryRequest(activeSpaceId, request.id, credentials!, { status: "declined", review_note: "Not accepted" }), "Request declined")}>Decline</Button></div> : null}
      </Card>)}</div>}</section>

    <div className="grid-2 foundry-section">
      <Card><CardTitle>Share a template or request inbox</CardTitle><CardDesc>Grant one destination Space access to one published template, or submit requests to this Space&apos;s owner inbox. Grants expire after seven days and can be revoked at any time.</CardDesc>
        <form onSubmit={(event) => void makeGrant(event)} className="foundry-form"><input required value={grantSpace} onChange={(event) => setGrantSpace(event.target.value)} placeholder="Destination Space ID" style={inputStyle} /><input required value={grantResource} onChange={(event) => setGrantResource(event.target.value)} placeholder="worker-template:ID, worker:AGENT_ID, or feature-inbox:submit" style={inputStyle} /><Button disabled={busy}>Create scoped grant</Button></form>
        {grantToken ? <textarea readOnly rows={3} value={grantToken} aria-label="Capability token" style={areaStyle} onFocus={(event) => event.currentTarget.select()} /> : null}
        {grantsVisible ? grants.map((grant) => <div key={grant.id} className="foundry-grant"><span>{grant.resource_id} → {grant.grantee_space_id} · expires {new Date(grant.expires_at).toLocaleDateString()}</span><Button variant="secondary" disabled={busy} onClick={() => void run(() => revokeCrossSpaceGrant(activeSpaceId, grant.id, credentials!), "Grant revoked")}>Revoke</Button></div>) : null}
      </Card>
      <Card><CardTitle>Install from another Space</CardTitle><CardDesc>The owner of the source Space must first publish the template and issue you a capability token.</CardDesc>
        <form onSubmit={(event) => void installTemplate(event)} className="foundry-form"><input required value={installSourceSpace} onChange={(event) => setInstallSourceSpace(event.target.value)} placeholder="Source Space ID" style={inputStyle} /><input required value={installTemplateId} onChange={(event) => setInstallTemplateId(event.target.value)} placeholder="Published template ID" style={inputStyle} /><textarea required rows={3} value={installCapability} onChange={(event) => setInstallCapability(event.target.value)} placeholder="Capability token" style={areaStyle} /><Button disabled={busy}>Install worker into this Space</Button></form>
      </Card>
      <Card><CardTitle>Call a shared worker</CardTitle><CardDesc>Only an owner-authorized worker can run. Your personal Space data and WhatsApp identity are not passed into the source Space; the prompt you submit is.</CardDesc>
        <form onSubmit={(event) => void callSharedWorker(event)} className="foundry-form"><input required value={invokeSourceSpace} onChange={(event) => setInvokeSourceSpace(event.target.value)} placeholder="Source Space ID" style={inputStyle} /><input required value={invokeAgentId} onChange={(event) => setInvokeAgentId(event.target.value)} placeholder="Shared worker ID" style={inputStyle} /><textarea required rows={3} value={invokeCapability} onChange={(event) => setInvokeCapability(event.target.value)} placeholder="Worker invoke capability token" style={areaStyle} /><textarea required maxLength={10000} rows={4} value={invokeGoal} onChange={(event) => setInvokeGoal(event.target.value)} placeholder="What should the shared worker do? Only include information you intend to send to that Space." style={areaStyle} /><Button disabled={busy}>Ask shared worker</Button></form>
        {invokeResult ? <pre className="foundry-output">{invokeResult}</pre> : null}
      </Card>
    </div>
    <Toast toast={toast} />
    <style jsx>{`.foundry-form{display:flex;flex-direction:column;gap:9px;margin-top:12px}.foundry-section{margin-top:24px}.foundry-section h2{font-size:17px}.foundry-actions,.foundry-grant{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px}.foundry-details{margin-top:14px;color:var(--text2);font-size:13px}.foundry-meta,.muted{color:var(--text3);font-size:12px}.foundry-output{white-space:pre-wrap;overflow:auto;max-height:360px;font-size:12px;padding:10px;background:var(--surface1);border-radius:8px}`}</style>
  </div>;
}
