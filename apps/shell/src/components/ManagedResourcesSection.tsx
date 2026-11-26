"use client";

import * as React from "react";
import { assistantMailApi, type SessionCredentials } from "@/lib/api";
import {
  describeComponent, parseManagedResources, parseResourceOptions, parseResourceQuote, resourceLifecycleActions, resourceModeLabel, resourceTitle,
  type ResourceLifecycleAction,
  type ManagedResource, type ResourceOptionsView, type ResourceQuoteView,
} from "@/lib/managed-resources";

/** Resource types the add flow offers; the server decides which offerings of a type are eligible. */
const RESOURCE_TYPES = [{ value: "inbox", label: "Email inbox" }];

/** MS-43: type, then Managed or Bring your own, then Automatic or a provider, then the quote with every component, then approve. */
function AddResourceFlow({ spaceId, session, onAdded }: { spaceId: string; session: SessionCredentials; onAdded: () => void }) {
  const [open, setOpen] = React.useState(false);
  const [resourceType, setResourceType] = React.useState(RESOURCE_TYPES[0]!.value);
  const [mode, setMode] = React.useState<"managed" | "byok">("managed");
  const [choice, setChoice] = React.useState("automatic");
  const [options, setOptions] = React.useState<ResourceOptionsView | null>(null);
  const [quote, setQuote] = React.useState<ResourceQuoteView | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const fail = (error: unknown) => setMessage(error instanceof Error ? error.message : "That did not work. Try again.");

  React.useEffect(() => {
    if (!open) return;
    let current = true;
    setOptions(null); setQuote(null); setMessage(null); setChoice("automatic");
    assistantMailApi<unknown>(spaceId, session, { action: "resource-options", resource_type: resourceType, access_mode: mode })
      .then((result) => { if (current) setOptions(parseResourceOptions(result)); })
      .catch((error) => { if (current) fail(error); });
    return () => { current = false; };
  }, [open, resourceType, mode, spaceId, session]);

  const selected = options?.options.find((option) => option.offeringId === (choice === "automatic" ? options.selectedOfferingId : choice));
  const requestQuote = async () => {
    setBusy(true); setMessage(null);
    try {
      const result = await assistantMailApi<unknown>(spaceId, session, {
        action: "resource-quote", resource_type: resourceType, access_mode: mode,
        ...(choice === "automatic" ? {} : { offering_id: choice }),
        ...(selected ? { region: selected.region } : {}),
      }, true);
      const parsed = parseResourceQuote(result);
      if (!parsed) setMessage("No quote was returned."); else setQuote(parsed);
    } catch (error) { fail(error); } finally { setBusy(false); }
  };
  const approve = async () => {
    if (!quote) return;
    setBusy(true); setMessage(null);
    try {
      await assistantMailApi<unknown>(spaceId, session, { action: "resource-provision", quote_id: quote.quoteId, offering_id: quote.offeringId, region: quote.region }, true);
      setQuote(null); setOpen(false); onAdded();
    } catch (error) { fail(error); } finally { setBusy(false); }
  };

  if (!open) return <button type="button" onClick={() => setOpen(true)}>Add a resource</button>;
  return (
    <div className="settings-block" data-testid="add-resource">
      <div className="settings-row-label">Add a resource</div>
      <label className="settings-row-sub">1. Type{" "}
        <select value={resourceType} onChange={(event) => setResourceType(event.target.value)}>
          {RESOURCE_TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
        </select>
      </label>
      <label className="settings-row-sub">2. Account{" "}
        <select value={mode} onChange={(event) => setMode(event.target.value === "byok" ? "byok" : "managed")}>
          <option value="managed">{resourceModeLabel("managed")}</option>
          <option value="byok">{resourceModeLabel("byok")}</option>
        </select>
      </label>
      {options && (
        <label className="settings-row-sub">3. Provider{" "}
          <select value={choice} onChange={(event) => { setChoice(event.target.value); setQuote(null); }}>
            <option value="automatic">Automatic</option>
            {options.options.map((option) => <option key={option.offeringId} value={option.offeringId}>{option.displayName}</option>)}
          </select>
        </label>
      )}
      {options && <p className="settings-row-sub" data-testid="add-resource-reason">
        {choice === "automatic" ? options.reason : selected ? `You chose ${selected.displayName}.` : ""}</p>}
      {mode === "byok" && <p className="settings-row-sub">Bring-your-own accounts are connected with your own credentials, so there is no quote here.</p>}
      {mode === "managed" && !quote && (
        <button type="button" disabled={busy || !selected} onClick={() => void requestQuote()}>See the quote</button>
      )}
      {quote && (
        <div className="settings-row-sub" data-testid="add-resource-quote">
          <strong>Quote</strong>
          <ul>{quote.components.map((component, index) => <li key={index}>{describeComponent(component)}</li>)}</ul>
          <div>Due now: {quote.credits} credits. Minimum per month: {quote.minMonthlyCredits} credits.</div>
          <div>Valid until {new Date(quote.expiresAt).toLocaleTimeString()}.</div>
          <button type="button" disabled={busy} onClick={() => void approve()}>Approve and add</button>
        </div>
      )}
      {message && <p role="alert" className="settings-row-sub">{message}</p>}
      <button type="button" onClick={() => setOpen(false)}>Cancel</button>
    </div>
  );
}

const LIFECYCLE_LABEL: Record<ResourceLifecycleAction, string> = { suspend: "Suspend", resume: "Resume", reactivate: "Reactivate" };
const LIFECYCLE_NOTE: Record<ResourceLifecycleAction, string> = {
  suspend: "Pauses sending. The monthly charge continues until you cancel.",
  resume: "Lifts your pause and restores sending.",
  reactivate: "Charges the overdue period, then restores sending.",
};

/** MS-42: provider-agnostic Resources list. Renders nothing while the server flag is off (404) or on any error. MS-47 adds owner suspend, resume and reactivate; export and release remain. */
export function ManagedResourcesSection({ spaceId, session }: { spaceId: string; session: SessionCredentials }) {
  const [resources, setResources] = React.useState<ManagedResource[] | null>(null);
  const [reload, setReload] = React.useState(0);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  React.useEffect(() => {
    let current = true;
    assistantMailApi<unknown>(spaceId, session, { action: "managed-resources" })
      .then((result) => { if (current) setResources(parseManagedResources(result)); })
      .catch(() => { if (current) setResources(null); });
    return () => { current = false; };
  }, [spaceId, session, reload]);
  if (resources === null) return null;
  const date = (value: string) => new Date(value).toLocaleDateString();
  const lifecycle = async (resource: ManagedResource, action: ResourceLifecycleAction) => {
    setNotice(null); setBusyId(resource.id);
    try {
      await assistantMailApi<unknown>(spaceId, session, { action: `resource-${action}`, resource_id: resource.id }, true);
      setReload((value) => value + 1);
    } catch (error) { setNotice(error instanceof Error ? error.message : "That did not work. Try again."); } finally { setBusyId(null); }
  };
  return (
    <div className="settings-block" data-testid="managed-resources">
      <div className="settings-row-label">Resources</div>
      <p className="settings-row-sub">Everything this Space uses from a provider, whether Naelao manages it or you brought your own account.</p>
      {resources.length === 0 ? <p className="settings-row-sub">No resources yet.</p> : (
        <ul style={{ display: "grid", gap: 8, listStyle: "none", padding: 0 }}>
          {resources.map((resource) => (
            <li key={resource.id} className="settings-row-sub">
              <strong>{resourceTitle(resource)}</strong> — {resourceModeLabel(resource.mode)}, {resource.status.replaceAll("_", " ")}
              {resource.region ? `, ${resource.region.toUpperCase()}` : ""}
              <div>Agents: {resource.assignedAgents.length ? resource.assignedAgents.join(", ") : "none assigned"}</div>
              <div>Usage this period: {resource.usage.operations} operations, {resource.usage.settledCredits} credits settled
                {resource.usage.heldCredits ? `, ${resource.usage.heldCredits} held` : ""}</div>
              {resource.price && <div>Price: {resource.price.credits} credits per month</div>}
              {resource.renewal && <div>{resource.renewal.cancelAtPeriodEnd ? "Ends" : "Renews"} {date(resource.renewal.currentPeriodEnd)}
                {resource.renewal.state !== "active" ? ` (${resource.renewal.state})` : ""}</div>}
              {resourceLifecycleActions(resource).map((action) => (
                <div key={action}>
                  <button type="button" disabled={busyId === resource.id} onClick={() => void lifecycle(resource, action)}>{LIFECYCLE_LABEL[action]}</button>{" "}
                  <span>{LIFECYCLE_NOTE[action]}</span>
                </div>
              ))}
            </li>
          ))}
        </ul>
      )}
      {notice && <p role="alert" className="settings-row-sub">{notice}</p>}
      <AddResourceFlow spaceId={spaceId} session={session} onAdded={() => setReload((value) => value + 1)} />
    </div>
  );
}
