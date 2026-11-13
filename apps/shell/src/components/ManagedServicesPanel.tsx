"use client";

import * as React from "react";
import { Button, FormInput } from "@naelao/ui";
import { assistantMailApi, type ManagedServiceDashboard, type SessionCredentials } from "@/lib/api";
import { normalizeManagedServiceAttachment } from "@/lib/managed-service-attachments";

function title(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

type ProviderRecord = Record<string, unknown>;
type AgentMailUsageObservation = { connectionId:string;scope:"agentmail_inbox";region:"us"|"eu";usage:{storageBytes:number;messageCount:number;threadCount:number};
  pointAt:string;observedAt:string;sourceApi:string;provenance:"provider_api_observed";inserted:boolean;replayed:boolean;notice:string };
function providerRecord(value: unknown): ProviderRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ProviderRecord : null;
}
function providerMessages(value: unknown): ProviderRecord[] {
  const root = providerRecord(value);
  if (!root) return [];
  for (const key of ["messages", "items", "results"]) {
    const list = root[key];
    if (Array.isArray(list)) return list.map(providerRecord).filter((item): item is ProviderRecord => item !== null);
  }
  const data = providerRecord(root.data);
  if (data) return providerMessages(data);
  return [];
}
function providerText(record: ProviderRecord, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" || typeof value === "number") return String(value);
  }
  return "";
}
function providerMessage(record: ProviderRecord): ProviderRecord {
  for (const key of ["message", "data", "result"]) {
    const nested = providerRecord(record[key]);
    if (nested) return providerMessage(nested);
  }
  return record;
}
function providerAttachments(value: unknown): ProviderRecord[] {
  const message = providerMessage(providerRecord(value) ?? {});
  return Array.isArray(message.attachments)
    ? message.attachments.map(providerRecord).filter((item): item is ProviderRecord => item !== null)
    : [];
}

type CostProvenance = "operator_imported" | "provider_api_observed";
type CostBudgetGroup = { provider: string; serviceId: string; provenance: CostProvenance; currency: string; observedProviderCostMicros: number;
  limitProviderCostMicros: number | null; thresholdReached: boolean };
function providerCostBudgetGroups(dashboard: ManagedServiceDashboard): CostBudgetGroup[] {
  const groups = new Map<string, CostBudgetGroup>();
  const keyOf = (row: { provider:string;serviceId:string;provenance:CostProvenance;currency:string }) =>
    `${row.provider}:${row.serviceId}:${row.provenance}:${row.currency}`;
  for (const cost of dashboard.providerCosts30d) {
    const key = keyOf(cost);
    const current = groups.get(key) ?? { provider:cost.provider,serviceId:cost.serviceId,provenance:cost.provenance,
      currency:cost.currency,observedProviderCostMicros:0,limitProviderCostMicros:null,thresholdReached:false };
    current.observedProviderCostMicros += cost.providerCostMicros;
    groups.set(key,current);
  }
  // These receipts stay in the decision reservation ledger, but share the existing
  // provider-observed threshold and alert path without duplicating rows in a second table.
  for (const cost of dashboard.decisionModelCosts30d) {
    const row={provider:"openrouter",serviceId:"decision-model",provenance:"provider_api_observed" as const,currency:"USD"};
    const key=keyOf(row);
    const current=groups.get(key)??{...row,observedProviderCostMicros:0,limitProviderCostMicros:null,thresholdReached:false};
    current.observedProviderCostMicros+=cost.providerCostMicros;
    groups.set(key,current);
  }
  for (const budget of dashboard.providerCostBudgets30d) {
    const key = keyOf(budget);
    const current = groups.get(key) ?? { provider:budget.provider,serviceId:budget.serviceId,provenance:budget.provenance,
      currency:budget.currency,observedProviderCostMicros:0,limitProviderCostMicros:null,thresholdReached:false };
    current.limitProviderCostMicros = budget.limitProviderCostMicros;
    current.thresholdReached = budget.thresholdReached;
    groups.set(key,current);
  }
  return [...groups.values()].sort((a,b) => keyOf(a).localeCompare(keyOf(b)));
}
function providerCostBudgetKey(group: CostBudgetGroup) {
  return `${group.provider}:${group.serviceId}:${group.provenance}:${group.currency}`;
}
function costMicrosToInput(value: number): string {
  return (value / 1_000_000).toFixed(6).replace(/\.?0+$/, "");
}
function formatProviderCost(value: number, currency: string): string {
  const amount = value / 1_000_000;
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount); }
  catch { return `${amount.toFixed(6)} ${currency}`; }
}
function currencyLimitToMicros(value: string): number | null {
  const match = /^(\d{1,7})(?:\.(\d{1,6}))?$/.exec(value.trim());
  if (!match) return null;
  const micros = BigInt(match[1]!) * 1_000_000n + BigInt((match[2] ?? "").padEnd(6,"0"));
  return micros > 0n && micros <= 1_000_000_000_000n ? Number(micros) : null;
}

export function ManagedServicesPanel({ spaceId, session }: { spaceId: string; session: SessionCredentials }) {
  const [dashboard, setDashboard] = React.useState<ManagedServiceDashboard | null>(null);
  const [error, setError] = React.useState("");
  const [loading, setLoading] = React.useState(true);
  const [notice, setNotice] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [refreshVersion, setRefreshVersion] = React.useState(0);
  const [displayName, setDisplayName] = React.useState("Naelao Assistant");
  const [managedAgentMailQuote,setManagedAgentMailQuote]=React.useState<{quoteId:string;credits:number;priceVersion:string;maxCreditsPerOperation:number;
    renewalCredits:number|null;renewalPriceVersion:string|null;renewalMaxCreditsPerOperation:number|null;maxCreditsPerPeriod:number;
    autoRenewAvailable:boolean;expiresAt:string}|null>(null);
  const [inboxId, setInboxId] = React.useState("");
  const [agentMailApiRegion, setAgentMailApiRegion] = React.useState<"us"|"eu">("us");
  const [apiKey, setApiKey] = React.useState("");
  const [higgsfieldKey, setHiggsfieldKey] = React.useState("");
  const [higgsfieldPrompt, setHiggsfieldPrompt] = React.useState("");
  const [higgsfieldEstimate, setHiggsfieldEstimate] = React.useState<{ id: string; amountUsd: string; expiresAt: string } | null>(null);
  const [higgsfieldRequest, setHiggsfieldRequest] = React.useState<{ id: string; status: string; estimatedUsd: string; videoUrl?: string; expiresAt?: string | null } | null>(null);
  const [higgsfieldRequests, setHiggsfieldRequests] = React.useState<Array<{ id: string; status: string; estimatedUsd: string; videoUrl?: string; expiresAt?: string | null }>>([]);
  const [higgsfieldIdempotencyKey, setHiggsfieldIdempotencyKey] = React.useState("");
  const [higgsfieldBusy, setHiggsfieldBusy] = React.useState(false);
  const [assistantRoutes, setAssistantRoutes] = React.useState<Record<string, string>>({});
  const [assistantWake, setAssistantWake] = React.useState<Record<string, boolean>>({});
  const [agentMailConnectionId, setAgentMailConnectionId] = React.useState("");
  const [agentMailQuery, setAgentMailQuery] = React.useState("");
  const [agentMailPageToken, setAgentMailPageToken] = React.useState("");
  const [agentMailMessages, setAgentMailMessages] = React.useState<ProviderRecord[]>([]);
  const [agentMailSelected, setAgentMailSelected] = React.useState<unknown>(null);
  const [agentMailAttachment, setAgentMailAttachment] = React.useState<unknown>(null);
  const [agentMailError, setAgentMailError] = React.useState("");
  const [agentMailBusy, setAgentMailBusy] = React.useState(false);
  const [agentMailUsageByConnection, setAgentMailUsageByConnection] = React.useState<Record<string,AgentMailUsageObservation>>({});
  const [agentMailUsageBusy, setAgentMailUsageBusy] = React.useState<string|null>(null);
  const [agentMailUsageError, setAgentMailUsageError] = React.useState("");
  const [managedModelId, setManagedModelId] = React.useState("");
  const [managedModelPrompt, setManagedModelPrompt] = React.useState("");
  const [managedModelQuote, setManagedModelQuote] = React.useState<{quoteId:string;credits:number;creditUnit:string;priceVersion:string;maxOutputTokens:number;expiresAt:string}|null>(null);
  const [managedModelResult, setManagedModelResult] = React.useState<{ operationId:string;status:string;output?:string;errorCode?:string;credits:number;priceVersion:string } | null>(null);
  const [managedModelBusy, setManagedModelBusy] = React.useState(false);
  const [managedModelError, setManagedModelError] = React.useState("");
  const [managedModelIdempotencyKey, setManagedModelIdempotencyKey] = React.useState("");
  const [costBudgetInputs, setCostBudgetInputs] = React.useState<Record<string,string>>({});

  React.useEffect(() => {
    let current = true;
    setLoading(true);
    setError("");
    assistantMailApi<ManagedServiceDashboard>(spaceId, session, { action: "managed-service-dashboard" })
      .then((result) => { if (current) setDashboard(result); })
      .catch((failure) => { if (current) setError(failure instanceof Error ? failure.message : "Managed services are unavailable"); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [spaceId, session, refreshVersion]);

  async function runAction(action: string, args: Record<string, unknown>, success: string) {
    setBusy(true);
    setNotice("");
    setError("");
    try {
      const scopedAccount = dashboard?.accounts.find((account) => account.id === args.account_id || account.id === args.connection_id
        || account.ownerLinkId === args.owner_link_id);
      await assistantMailApi(spaceId, session, { action, ...(scopedAccount?.projectId ? { projectId: scopedAccount.projectId } : {}), ...args }, true);
      setNotice(success);
      setRefreshVersion((version) => version + 1);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Managed service action failed");
    } finally {
      setBusy(false);
    }
  }

  function connectCustomerInbox() {
    const inbox = inboxId.trim(), key = apiKey;
    void runAction("agentmail-connect", { inbox_id: inbox, api_key: key, region:agentMailApiRegion }, "Your AgentMail inbox is connected.")
      .then(() => setApiKey(""));
  }

  function disconnectAgentPortOwnerLink(account: ManagedServiceDashboard["accounts"][number]) {
    if (!account.ownerLinkId || !window.confirm("Disconnect this AgentPort owner link? This revokes all AgentMail accounts attached to this link across the organization and erases their saved provider credentials from Naelao. Reconnect the accounts to restore access.")) return;
    void runAction("agentport-owner-unlink", { owner_link_id: account.ownerLinkId, connection_id: account.id },
      "The AgentPort owner link was revoked. Saved AgentMail credentials were removed; reconnect an inbox to restore access.");
  }

  const agentMail = dashboard?.capabilities.find((capability) => capability.provider === "agentmail" && capability.serviceId === "agentmail");
  const activeAgentMailAccounts = dashboard?.accounts.filter((account) => account.provider === "agentmail" && account.status === "active") ?? [];
  const activeAgentMailAccount = activeAgentMailAccounts.find((account) => account.id === agentMailConnectionId) ?? activeAgentMailAccounts[0] ?? null;
  const provisionEntitlement = agentMail?.entitlements.find((entitlement) => entitlement.operation === "provision" && entitlement.eligibleForConfiguredRegion);
  const renewalEntitlement = agentMail?.entitlements.find((entitlement) => entitlement.operation === "renew" && entitlement.eligibleForConfiguredRegion);
  const managedMailboxAvailable = agentMail?.state === "verified" && agentMail.accountModes.includes("naelao_managed")
    && !!agentMail.configuredRegion && !!provisionEntitlement?.creditsPerOperation && agentMail.providerConfiguration.ready;

  async function quoteManagedAgentMail() {
    if(!displayName.trim())return;
    setBusy(true);setManagedAgentMailQuote(null);setNotice("");setError("");
    try{
      const quote=await assistantMailApi<{quoteId:string;credits:number;priceVersion:string;maxCreditsPerOperation:number;renewalCredits:number|null;
        renewalPriceVersion:string|null;renewalMaxCreditsPerOperation:number|null;maxCreditsPerPeriod:number;autoRenewAvailable:boolean;expiresAt:string}>(spaceId,session,
        {action:"agentmail-quote",display_name:displayName.trim()},true);
      setManagedAgentMailQuote(quote);
    }catch(failure){setError(failure instanceof Error?failure.message:"Managed mailbox quote failed");}
    finally{setBusy(false);}
  }

  async function confirmManagedAgentMailProvision() {
    if(!managedAgentMailQuote||Date.parse(managedAgentMailQuote.expiresAt)<=Date.now())return;
    const recurring=managedAgentMailQuote.autoRenewAvailable
      ? ` Monthly renewal is ${managedAgentMailQuote.renewalCredits!.toLocaleString()} Naelao credits (${managedAgentMailQuote.renewalPriceVersion}); maximum renewal reservation is ${managedAgentMailQuote.renewalMaxCreditsPerOperation!.toLocaleString()}, under a 30 day mandate cap of ${managedAgentMailQuote.maxCreditsPerPeriod.toLocaleString()} credits.`
      : " No exact monthly renewal price is active, so this mailbox will not auto-renew and will enter retirement review at the paid-period boundary.";
    if(!window.confirm(`Provision a managed AgentMail mailbox for exactly ${managedAgentMailQuote.credits.toLocaleString()} Naelao credits (${managedAgentMailQuote.priceVersion})? Maximum reservation is ${managedAgentMailQuote.maxCreditsPerOperation.toLocaleString()} credits.${recurring}`))return;
    await runAction("agentmail-provision",{display_name:displayName.trim(),quote_id:managedAgentMailQuote.quoteId},
      "Managed mailbox provisioning was accepted; check account status for completion.");
    setManagedAgentMailQuote(null);
  }
  const higgsfield = dashboard?.capabilities.find((capability) => capability.provider === "higgsfield" && capability.serviceId === "kling-video-v4-text-to-video");
  const higgsfieldAvailable = dashboard?.higgsfieldByoEnabled === true && higgsfield?.state === "verified"
    && higgsfield.accountModes.includes("user_connected") && higgsfield.regions.includes("global")
    && ["estimate", "generate", "status", "cancel", "delete"].every((operation) => higgsfield.operations.includes(operation));
  const higgsfieldAccount = dashboard?.accounts.find((account) => account.provider === "higgsfield" && account.status === "active");
  const higgsfieldAccountId = higgsfieldAccount?.id ?? null;

  React.useEffect(() => {
    setManagedModelId((current) => dashboard?.managedModels.some((model) => model.modelId === current)
      ? current : dashboard?.managedModels[0]?.modelId ?? "");
  }, [dashboard]);

  React.useEffect(() => {
    if (!dashboard) return;
    setCostBudgetInputs(Object.fromEntries(dashboard.providerCostBudgets30d.map(budget => [
      `${budget.provider}:${budget.serviceId}:${budget.provenance}:${budget.currency}`,
      costMicrosToInput(budget.limitProviderCostMicros),
    ])));
  }, [dashboard]);

  async function saveProviderCostBudget(group: CostBudgetGroup, clear = false) {
    const key = providerCostBudgetKey(group);
    const limit = clear ? null : currencyLimitToMicros(costBudgetInputs[key] ?? "");
    if (!clear && limit === null) {
      setError(`Enter a positive ${group.currency} threshold of up to 1,000,000.`);
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await assistantMailApi(spaceId, session, { action:"managed-service-cost-budget", provider:group.provider,
        service_id:group.serviceId, provenance:group.provenance, currency:group.currency, limit_provider_cost_micros:limit }, true);
      setNotice(clear ? "Cost threshold removed." : "Rolling 30-day cost threshold saved.");
      setRefreshVersion(version => version + 1);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save provider cost threshold");
    } finally {
      setBusy(false);
    }
  }

  async function acknowledgeProviderCostAlert(alertId:string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await assistantMailApi(spaceId,session,{action:"managed-service-cost-alert-ack",alert_id:alertId},true);
      setNotice("Provider cost alert acknowledged.");
      setRefreshVersion(version=>version+1);
    } catch(failure) {
      setError(failure instanceof Error?failure.message:"Could not acknowledge provider cost alert");
    } finally {
      setBusy(false);
    }
  }

  async function quoteManagedModel() {
    const model = dashboard?.managedModels.find((candidate) => candidate.modelId === managedModelId);
    if (!model || !managedModelPrompt.trim()) return;
    setManagedModelBusy(true); setManagedModelError(""); setManagedModelResult(null); setManagedModelQuote(null);
    try {
      const quote = await assistantMailApi<{quoteId:string;credits:number;creditUnit:string;priceVersion:string;maxOutputTokens:number;expiresAt:string}>(spaceId, session,
        { action:"managed-model-quote", model_id:model.modelId, prompt:managedModelPrompt }, true);
      setManagedModelQuote(quote);
      setManagedModelIdempotencyKey("");
    } catch (failure) {
      setManagedModelError(failure instanceof Error ? failure.message : "Managed model quote failed");
    } finally { setManagedModelBusy(false); }
  }

  async function runManagedModel() {
    const model = dashboard?.managedModels.find((candidate) => candidate.modelId === managedModelId);
    if (!model || !managedModelPrompt.trim() || !managedModelQuote) return;
    if (!window.confirm(`Send this prompt to Cloudflare Workers AI? The organization will be charged exactly ${managedModelQuote.credits.toLocaleString()} Naelao credits (${managedModelQuote.priceVersion}); output is capped at ${managedModelQuote.maxOutputTokens.toLocaleString()} tokens. The provider charge is billed separately to Naelao's Cloudflare account.`)) return;
    const idempotencyKey = managedModelIdempotencyKey || crypto.randomUUID().replaceAll("-", "");
    setManagedModelIdempotencyKey(idempotencyKey);
    setManagedModelBusy(true); setManagedModelError(""); setManagedModelResult(null);
    try {
      const result = await assistantMailApi<{ operationId:string;status:string;output?:string;errorCode?:string;credits:number;priceVersion:string }>(spaceId, session,
        { action:"managed-model-run", model_id:model.modelId, prompt:managedModelPrompt, quote_id:managedModelQuote.quoteId,
          idempotency_key:idempotencyKey, confirmed:true }, true);
      setManagedModelResult(result);
      if (result.status === "complete") { setManagedModelIdempotencyKey(""); setManagedModelQuote(null); }
    } catch (failure) {
      setManagedModelError(failure instanceof Error ? failure.message : "Managed model request failed");
    } finally { setManagedModelBusy(false); }
  }

  React.useEffect(() => {
    setAgentMailConnectionId((current) => activeAgentMailAccounts.some((account) => account.id === current)
      ? current : activeAgentMailAccounts[0]?.id ?? "");
  }, [dashboard?.accounts]);

  async function callManagedAgentMail(operation: string, args: Record<string, unknown>) {
    if (!activeAgentMailAccount) throw new Error("agentmail_account_not_connected");
    const response = await assistantMailApi<{ result?: unknown }>(spaceId, session, {
      action: "agentmail-operation",
      ...(activeAgentMailAccount.projectId ? { projectId: activeAgentMailAccount.projectId } : {}),
      connection_id: activeAgentMailAccount.id,
      operation,
      args,
    }, true);
    return response.result;
  }

  async function loadAgentMailMessages(pageToken = "") {
    if (!activeAgentMailAccount) return;
    setAgentMailBusy(true);
    setAgentMailError("");
    setAgentMailSelected(null);
    setAgentMailAttachment(null);
    try {
      const operation = agentMailQuery.trim() ? "agentmail.search" : "agentmail.inbox";
      const result = await callManagedAgentMail(operation, {
        limit: 20,
        ...(agentMailQuery.trim() ? { query: agentMailQuery.trim() } : {}),
        ...(pageToken ? { page_token: pageToken } : {}),
      });
      setAgentMailMessages(providerMessages(result));
      const response = providerRecord(result);
      setAgentMailPageToken(providerText(response ?? {}, "next_page_token", "nextPageToken", "next_cursor"));
    } catch (failure) {
      setAgentMailMessages([]);
      setAgentMailError(failure instanceof Error ? failure.message : "AgentMail inbox is unavailable");
    } finally {
      setAgentMailBusy(false);
    }
  }

  async function readAgentMailMessage(messageId: string) {
    setAgentMailBusy(true);
    setAgentMailError("");
    setAgentMailAttachment(null);
    try { setAgentMailSelected((await callManagedAgentMail("agentmail.read", { messageId })) ?? null); }
    catch (failure) { setAgentMailError(failure instanceof Error ? failure.message : "AgentMail message is unavailable"); }
    finally { setAgentMailBusy(false); }
  }

  async function readAgentMailAttachment(messageId: string, attachmentId: string) {
    setAgentMailBusy(true);
    setAgentMailError("");
    setAgentMailAttachment(null);
    try { setAgentMailAttachment(await callManagedAgentMail("agentmail.attachment", { messageId, attachmentId })); }
    catch (failure) { setAgentMailError(failure instanceof Error ? failure.message : "AgentMail attachment is unavailable"); }
    finally { setAgentMailBusy(false); }
  }

  async function readAgentMailUsage(account:ManagedServiceDashboard["accounts"][number]) {
    setAgentMailUsageBusy(account.id);
    setAgentMailUsageError("");
    try {
      const result=await assistantMailApi<AgentMailUsageObservation>(spaceId,session,{
        action:"agentmail-usage",...(account.projectId?{projectId:account.projectId}:{}),connection_id:account.id,
      },true);
      setAgentMailUsageByConnection(current=>({...current,[account.id]:result}));
    } catch(failure) {
      setAgentMailUsageError(failure instanceof Error?failure.message:"AgentMail provider usage is unavailable");
    } finally { setAgentMailUsageBusy(null); }
  }

  React.useEffect(() => {
    let current = true;
    if (!higgsfieldAccountId) { setHiggsfieldRequests([]); setHiggsfieldRequest(null); return () => { current = false; }; }
    assistantMailApi<{ requests: typeof higgsfieldRequests }>(spaceId, session,
      { action: "higgsfield-requests", ...(higgsfieldAccount?.projectId ? { projectId: higgsfieldAccount.projectId } : {}), account_id: higgsfieldAccountId }, true)
      .then((result) => { if (current) { setHiggsfieldRequests(result.requests); setHiggsfieldRequest(result.requests[0] ?? null); } })
      .catch(() => { if (current) setError("Higgsfield request history is unavailable"); });
    return () => { current = false; };
  }, [spaceId, session, higgsfieldAccountId, higgsfieldAccount?.projectId]);

  async function higgsfieldAction(action: string, args: Record<string, unknown>) {
    setHiggsfieldBusy(true);
    setError("");
    try {
      const scopedAccount = dashboard?.accounts.find((account) => account.id === args.account_id);
      return await assistantMailApi<Record<string, any>>(spaceId, session,
        { action, ...(scopedAccount?.projectId ? { projectId: scopedAccount.projectId } : {}), ...args }, true);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Higgsfield action failed");
      return null;
    } finally { setHiggsfieldBusy(false); }
  }

  async function connectHiggsfield() {
    const result = await higgsfieldAction("higgsfield-connect", { api_key: higgsfieldKey });
    if (!result) return;
    setHiggsfieldKey("");
    setNotice("Your customer billed Higgsfield account is connected.");
    setRefreshVersion((version) => version + 1);
  }

  async function shareHiggsfieldAgentPort() {
    if (!higgsfieldAccount || !window.confirm("Share only the estimate and video generation actions with this assistant through AgentPort? The API key stays in your UserPort connection, and provider charges remain on your Higgsfield account.")) return;
    const result = await higgsfieldAction("higgsfield-agentport-share", { account_id: higgsfieldAccount.id });
    if (!result?.shared) return;
    setNotice("Higgsfield estimate and generation actions are shared with this assistant through AgentPort.");
    setRefreshVersion((version) => version + 1);
  }

  async function revokeHiggsfieldAgentPort() {
    if (!higgsfieldAccount || !window.confirm("Revoke this assistant's AgentPort access to your Higgsfield account?")) return;
    const result = await higgsfieldAction("higgsfield-agentport-revoke", { account_id: higgsfieldAccount.id });
    if (!result?.revoked) return;
    setNotice("Higgsfield AgentPort access has been revoked.");
    setRefreshVersion((version) => version + 1);
  }

  async function estimateHiggsfield() {
    if (!higgsfieldAccount) return;
    const result = await higgsfieldAction("higgsfield-estimate", { account_id: higgsfieldAccount.id, request: { prompt: higgsfieldPrompt } });
    if (!result?.estimate) return;
    setHiggsfieldEstimate(result.estimate);
    setNotice("Higgsfield returned an account specific estimate. Review it before generation.");
  }

  async function submitHiggsfield() {
    if (!higgsfieldAccount || !higgsfieldEstimate) return;
    const idem = higgsfieldIdempotencyKey || crypto.randomUUID().replaceAll("-", "");
    setHiggsfieldIdempotencyKey(idem);
    const result = await higgsfieldAction("higgsfield-submit", { account_id: higgsfieldAccount.id,
      estimate_id: higgsfieldEstimate.id, confirmed_usd: higgsfieldEstimate.amountUsd, idempotency_key: idem,
      request: { prompt: higgsfieldPrompt } });
    if (!result) return;
    if (result.requiresConfirmation && result.estimate) {
      setHiggsfieldEstimate(result.estimate);
      setNotice("The provider estimate changed. Review the new amount before confirming.");
      return;
    }
    if (result.request) setHiggsfieldRequest(result.request);
    if (result.submitted) {
      setHiggsfieldEstimate(null);
      setHiggsfieldPrompt("");
      setHiggsfieldIdempotencyKey("");
      const history = await higgsfieldAction("higgsfield-requests", { account_id: higgsfieldAccount.id });
      if (history?.requests) setHiggsfieldRequests(history.requests);
      setNotice("Generation was accepted by Higgsfield. Refresh its status to see the result.");
    } else if (result.request?.status === "unknown") {
      setHiggsfieldEstimate(null);
      setNotice("Higgsfield has not confirmed the request outcome. The same provider idempotency key is preserved. Get a fresh estimate, review it, then retry this request safely.");
    }
  }

  async function refreshHiggsfield() {
    if (!higgsfieldAccount || !higgsfieldRequest) return;
    const result = await higgsfieldAction("higgsfield-status", { account_id: higgsfieldAccount.id, request_id: higgsfieldRequest.id });
    if (result?.request) setHiggsfieldRequest(result.request);
    const history = await higgsfieldAction("higgsfield-requests", { account_id: higgsfieldAccount.id });
    if (history?.requests) setHiggsfieldRequests(history.requests);
  }

  return (
    <section className="settings-section" aria-labelledby="managed-services-heading">
      <h3 id="managed-services-heading">Managed services</h3>
      <p>Provider eligibility, connected account ownership, operation status, and shared credit usage for this Space.</p>
      {loading ? <p>Loading managed service status…</p> : error ? (
        <>
          <p role="status">{error.includes("owner_authorization_required") ? "An owner or admin can view managed service controls." : error}</p>
          <div className="settings-block">
            <div className="settings-row-label">Connect your own AgentMail inbox</div>
            <p className="settings-row-sub">This links only the inbox and API key you provide. The key is submitted to Naelao for encrypted provider access and is not shared with other Space members.</p>
            <div style={{ display: "grid", gap: 8, maxWidth: 560 }}>
              <label htmlFor="agentmail-api-region">AgentMail API region</label>
              <select id="agentmail-api-region" value={agentMailApiRegion} onChange={(event)=>setAgentMailApiRegion(event.target.value==="eu"?"eu":"us")}>
                <option value="us">United States</option><option value="eu">European Union</option>
              </select>
              <p className="settings-row-sub">Choose the region of this AgentMail inbox. Naelao verifies it at connection time and uses the same regional API for later inbox requests.</p>
              <FormInput aria-label="AgentMail inbox ID" placeholder="AgentMail inbox ID" value={inboxId} onChange={(event) => setInboxId(event.target.value)} />
              <FormInput aria-label="AgentMail API key" type="password" placeholder="AgentMail API key" value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
              <div><Button size="sm" disabled={busy || !inboxId.trim() || apiKey.length < 16} onClick={connectCustomerInbox}>{busy ? "Connecting…" : "Connect customer-owned inbox"}</Button></div>
            </div>
          </div>
        </>
      ) : dashboard ? (
        <>
          {notice && <p role="status">{notice}</p>}
          <p>Current plan: <strong>{title(dashboard.planTier)}</strong>. Credit totals use the last 30 days.</p>
          <div className="settings-block">
            <div className="settings-row-label">Choose an AgentMail connection</div>
            <p className="settings-row-sub">Your own inbox stays attached to your AgentMail account. A managed mailbox is a separate assistant address billed against this organization&apos;s credits.</p>
            <div style={{ display: "grid", gap: 8, maxWidth: 560 }}>
              <h4>Use your own inbox</h4>
              <label htmlFor="agentmail-api-region">AgentMail API region</label>
              <select id="agentmail-api-region" value={agentMailApiRegion} onChange={(event)=>setAgentMailApiRegion(event.target.value==="eu"?"eu":"us")}>
                <option value="us">United States</option><option value="eu">European Union</option>
              </select>
              <p className="settings-row-sub">Choose the region of this AgentMail inbox. Naelao verifies it at connection time and uses the same regional API for later inbox requests.</p>
              <FormInput aria-label="AgentMail inbox ID" placeholder="AgentMail inbox ID" value={inboxId} onChange={(event) => setInboxId(event.target.value)} />
              <FormInput aria-label="AgentMail API key" type="password" placeholder="AgentMail API key" value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
              <div><Button size="sm" disabled={busy || !inboxId.trim() || apiKey.length < 16} onClick={connectCustomerInbox}>{busy ? "Connecting…" : "Connect customer-owned inbox"}</Button></div>

              <h4>Provision a managed inbox</h4>
              {managedMailboxAvailable && provisionEntitlement ? (
                <>
                  <p className="settings-row-sub">Operator-verified for {agentMail!.configuredRegion}. Provisioning requires a separate exact quote and confirmation. The maximum reservation is {provisionEntitlement.maxCreditsPerOperation.toLocaleString()} credits.</p>
                  <FormInput aria-label="Managed mailbox display name" maxLength={120} value={displayName} onChange={(event) => {setDisplayName(event.target.value);setManagedAgentMailQuote(null);}} />
                  {!managedAgentMailQuote ? <Button size="sm" disabled={busy || !displayName.trim()} onClick={() => void quoteManagedAgentMail()}>{busy ? "Getting quote…" : "Get managed mailbox quote"}</Button> : (
                    <div style={{display:"grid",gap:8}}>
                      <p className="settings-row-sub">Quote: {managedAgentMailQuote.credits.toLocaleString()} Naelao credits ({managedAgentMailQuote.priceVersion}).
                        {managedAgentMailQuote.autoRenewAvailable ? ` Monthly renewal: ${managedAgentMailQuote.renewalCredits!.toLocaleString()} credits (${managedAgentMailQuote.renewalPriceVersion}), with a ${managedAgentMailQuote.renewalMaxCreditsPerOperation!.toLocaleString()} credit maximum reservation.` : " No exact renewal price is active; automatic renewal is unavailable."}
                        {renewalEntitlement?.creditsPerOperation && managedAgentMailQuote.renewalCredits!==renewalEntitlement.creditsPerOperation ? " Renewal terms changed since the dashboard loaded; request a fresh quote." : ""}
                        {Date.parse(managedAgentMailQuote.expiresAt)<=Date.now()?" Expired; request a fresh quote.":` Expires ${new Date(managedAgentMailQuote.expiresAt).toLocaleTimeString()}.`}</p>
                      <div style={{display:"flex",gap:8}}>
                        <Button size="sm" disabled={busy||Date.parse(managedAgentMailQuote.expiresAt)<=Date.now()} onClick={() => void confirmManagedAgentMailProvision()}>{busy ? "Provisioning…" : "Confirm and provision"}</Button>
                        <Button size="sm" variant="secondary" disabled={busy} onClick={() => setManagedAgentMailQuote(null)}>Cancel quote</Button>
                      </div>
                    </div>
                  )}
                </>
              ) : <p className="settings-row-sub">Managed AgentMail provisioning is unavailable for this Space until the provider, region, organization plan, price and credit cap pass the operator gates.</p>}
            </div>
          </div>
          <div className="settings-block">
            <div className="settings-row-label">Managed model inference</div>
            <p className="settings-row-sub">Only operator approved models appear here. Each request uses the organization's shared credit quota and sends the prompt to Naelao's Cloudflare account; Cloudflare bills Naelao separately. The global provider route does not promise data residency. Prompts are not retained by this feature; encrypted results expire after seven days.</p>
            {dashboard.managedModels.length === 0 ? (
              <p className="settings-row-sub">Unavailable until an operator verifies an exact Cloudflare model, region and fixed credit price for this plan.</p>
            ) : (
              <div style={{ display:"grid",gap:8,maxWidth:720 }}>
                <label htmlFor="managed-model-choice">Model</label>
                <select id="managed-model-choice" value={managedModelId} onChange={(event) => { setManagedModelId(event.target.value); setManagedModelIdempotencyKey(""); setManagedModelQuote(null); setManagedModelResult(null); }}>
                  {dashboard.managedModels.map((model) => <option key={`${model.modelId}:${model.region}`} value={model.modelId}>
                    {model.modelId} · {model.region} · {model.creditsPerOperation.toLocaleString()} credits
                  </option>)}
                </select>
                <label htmlFor="managed-model-prompt">Prompt</label>
                <textarea id="managed-model-prompt" maxLength={8000} rows={5} value={managedModelPrompt}
                  onChange={(event) => { setManagedModelPrompt(event.target.value); setManagedModelIdempotencyKey(""); setManagedModelQuote(null); setManagedModelResult(null); }} />
                <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                  <Button size="sm" disabled={managedModelBusy || !managedModelPrompt.trim() || !managedModelId}
                    onClick={() => void quoteManagedModel()}>{managedModelBusy ? "Checking quote…" : "Get operation quote"}</Button>
                  <Button size="sm" disabled={managedModelBusy || !managedModelQuote || Date.parse(managedModelQuote.expiresAt) <= Date.now()}
                    onClick={() => void runManagedModel()}>{managedModelBusy ? "Running…" : "Confirm and run"}</Button>
                </div>
                {managedModelQuote && <p className="settings-row-sub">Quote: {managedModelQuote.credits.toLocaleString()} Naelao credits · {managedModelQuote.priceVersion} · up to {managedModelQuote.maxOutputTokens.toLocaleString()} tokens · expires {new Date(managedModelQuote.expiresAt).toLocaleTimeString()}.</p>}
                {managedModelError && <p role="status">{managedModelError} {managedModelIdempotencyKey ? "Retrying with the same request key will not run it twice." : ""}</p>}
                {managedModelResult && <div className="settings-row-sub">
                  Request {title(managedModelResult.status)} · {managedModelResult.credits.toLocaleString()} credits · {managedModelResult.priceVersion}
                  {managedModelResult.errorCode ? ` · ${managedModelResult.errorCode}` : ""}
                  {managedModelResult.output !== undefined && <pre style={{ maxHeight:320,overflow:"auto",whiteSpace:"pre-wrap",overflowWrap:"anywhere" }}>{managedModelResult.output}</pre>}
                </div>}
              </div>
            )}
          </div>
          <div className="settings-block">
            <div className="settings-row-label">Higgsfield · Kling 4.0 Text to Video</div>
            <p className="settings-row-sub">This uses your Higgsfield API balance. Naelao does not charge managed service credits for these customer owned requests. Completed media remains available only for the provider retention period unless you download it yourself.</p>
            {!higgsfieldAvailable ? (
              <p className="settings-row-sub">Unavailable while the integration gate is closed. Current Higgsfield API terms require end user terms, age and likeness consent controls, and written permission for standalone resale or service bureau use. Operator and product approval is still pending.</p>
            ) : !higgsfieldAccount ? (
              <div style={{ display: "grid", gap: 8, maxWidth: 560 }}>
                <p className="settings-row-sub">Connect an API key and secret from your Higgsfield developer account. Credentials are encrypted and available only to your owner scoped provider requests.</p>
                <FormInput aria-label="Higgsfield API key and secret" type="password" autoComplete="off" placeholder="KEY_ID:KEY_SECRET" value={higgsfieldKey} onChange={(event) => setHiggsfieldKey(event.target.value)} />
                <div><Button size="sm" disabled={higgsfieldBusy || higgsfieldKey.length < 16} onClick={() => void connectHiggsfield()}>{higgsfieldBusy ? "Connecting…" : "Connect customer owned account"}</Button></div>
              </div>
            ) : (
              <div style={{ display: "grid", gap: 8, maxWidth: 640 }}>
                <p className="settings-row-sub">Connected customer owned account · provider payer: you · model: Kling 4.0 Text to Video.</p>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {higgsfieldAccount.agentPortLinkStatus === "active"
                    ? <Button size="sm" variant="secondary" disabled={higgsfieldBusy} onClick={() => void revokeHiggsfieldAgentPort()}>Revoke AgentPort access</Button>
                    : <Button size="sm" variant="secondary" disabled={higgsfieldBusy || ["pending", "revoking"].includes(higgsfieldAccount.agentPortLinkStatus ?? "")}
                        onClick={() => void shareHiggsfieldAgentPort()}>{higgsfieldAccount.agentPortLinkStatus === "unknown" ? "Retry AgentPort link sync" : "Share estimate and generation with assistant"}</Button>}
                </div>
                <label htmlFor="higgsfield-prompt">Video prompt</label>
                <textarea id="higgsfield-prompt" maxLength={10000} value={higgsfieldPrompt} onChange={(event) => { setHiggsfieldPrompt(event.target.value); setHiggsfieldEstimate(null); }} rows={5} />
                {!higgsfieldEstimate ? <div><Button size="sm" disabled={higgsfieldBusy || !higgsfieldPrompt.trim()} onClick={() => void estimateHiggsfield()}>{higgsfieldBusy ? "Estimating…" : "Get provider estimate"}</Button></div> : (
                  <div>
                    <p>Higgsfield estimate: <strong>${higgsfieldEstimate.amountUsd} USD</strong> through {new Date(higgsfieldEstimate.expiresAt).toLocaleTimeString()}.</p>
                    <Button size="sm" disabled={higgsfieldBusy} onClick={() => void submitHiggsfield()}>{higgsfieldBusy ? "Submitting…" : `Generate for $${higgsfieldEstimate.amountUsd}`}</Button>
                  </div>
                )}
                {higgsfieldRequest && <div className="settings-row-sub">
                  Request status: <strong>{title(higgsfieldRequest.status)}</strong> · estimated charge ${higgsfieldRequest.estimatedUsd} USD
                  {higgsfieldRequest.expiresAt ? ` · provider media expires ${new Date(higgsfieldRequest.expiresAt).toLocaleString()}` : ""}
                  {higgsfieldRequest.videoUrl && <div><a href={higgsfieldRequest.videoUrl} target="_blank" rel="noreferrer">Open provider hosted video</a></div>}
                  <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                    <Button size="sm" disabled={higgsfieldBusy} onClick={() => void refreshHiggsfield()}>Refresh status</Button>
                    {higgsfieldRequest.status === "queued" && <Button size="sm" disabled={higgsfieldBusy} onClick={() => void higgsfieldAction("higgsfield-cancel", { account_id: higgsfieldAccount.id, request_id: higgsfieldRequest.id }).then((result) => { if (result?.request) { setHiggsfieldRequest(result.request); setHiggsfieldRequests((items) => items.map((item) => item.id === result.request.id ? result.request : item)); } })}>Cancel queued request</Button>}
                    {["completed", "failed", "nsfw", "canceled"].includes(higgsfieldRequest.status) && <Button size="sm" disabled={higgsfieldBusy} onClick={() => void higgsfieldAction("higgsfield-delete", { account_id: higgsfieldAccount.id, request_id: higgsfieldRequest.id }).then((result) => { if (result?.request) { setHiggsfieldRequest(result.request); setHiggsfieldRequests((items) => items.map((item) => item.id === result.request.id ? result.request : item)); } })}>Delete provider request data</Button>}
                  </div>
                </div>}
                {higgsfieldRequests.length > 1 && <div>
                  <div className="settings-row-label">Recent generations</div>
                  <ul>{higgsfieldRequests.map((request) => <li key={request.id}>
                    <button type="button" onClick={() => setHiggsfieldRequest(request)}>{title(request.status)} · ${request.estimatedUsd} USD · {request.id.slice(0, 12)}</button>
                  </li>)}</ul>
                </div>}
                <div><Button size="sm" disabled={higgsfieldBusy} onClick={() => void higgsfieldAction("higgsfield-disconnect", { account_id: higgsfieldAccount.id }).then((result) => { if (result?.revoked) { setHiggsfieldRequest(null); setHiggsfieldEstimate(null); setRefreshVersion((version) => version + 1); } })}>Disconnect and erase saved credentials</Button></div>
              </div>
            )}
          </div>
          {dashboard.capabilities.length === 0 ? <p>No provider capabilities are registered.</p> : (
            <div style={{ display: "grid", gap: 10 }}>
              {dashboard.capabilities.map((capability) => (
                <div key={`${capability.provider}:${capability.serviceId}`} className="settings-block">
                  <div className="settings-row" style={{ flexWrap: "wrap", gap: 8 }}>
                    <div>
                      <div className="settings-row-label">{title(capability.provider)} · {capability.serviceId}</div>
                      <div className="settings-row-sub">
                        {title(capability.state)} · {capability.isolationModel} · {capability.regions.length ? capability.regions.join(", ") : "no verified region"}
                      </div>
                    </div>
                    <div className="settings-row-sub">{capability.providerConfiguration.ready ? "Provider configured" : "Provider setup incomplete"}</div>
                  </div>
                  {capability.entitlements.length > 0 ? (
                    <ul>
                      {capability.entitlements.map((entitlement) => (
                        <li key={`${entitlement.operation}:${entitlement.region}`}>
                          {title(entitlement.operation)} in {entitlement.region}: {entitlement.creditsPerOperation
                            ? `${entitlement.creditsPerOperation.toLocaleString()} fixed credits (maximum ${entitlement.maxCreditsPerOperation.toLocaleString()})`
                            : `up to ${entitlement.maxCreditsPerOperation.toLocaleString()} credits per operation`}
                          {entitlement.maxOperationsPerPeriod ? `, ${entitlement.maxOperationsPerPeriod} per period` : ""}
                          {entitlement.eligibleForConfiguredRegion ? " · current region" : " · region not selected for this worker"}
                        </li>
                      ))}
                    </ul>
                  ) : <p className="settings-row-sub">No active plan entitlement is configured. This provider cannot be provisioned from this Space.</p>}
                </div>
              ))}
            </div>
          )}

          <h4>Connected service accounts</h4>
          {dashboard.accounts.length === 0 ? <p>No managed service accounts are linked to this Space.</p> : (
            <div className="settings-block">
              {dashboard.accounts.map((account) => (
                <div className="settings-row" key={account.id} style={{ flexWrap: "wrap", gap: 8 }}>
                  <div>
                    <div className="settings-row-label">{title(account.provider)} · {account.serviceId}</div>
                    <div className="settings-row-sub">{title(account.connectionMode)} · owned by {title(account.ownerType)} · provider payer: {title(account.providerPayerType)} · credits payer: {account.creditPayerType ? title(account.creditPayerType) : "none"}</div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span>{title(account.status)}{account.region ? ` · ${account.region}` : ""}</span>
                    {account.provider === "agentmail" && account.connectionMode === "naelao_managed" && account.status === "active" && (
                      <Button size="sm" disabled={busy} onClick={() => void runAction("agentmail-stop-renewal", { connection_id: account.id }, "Managed AgentMail renewal was stopped for its paid period boundary.")}>Stop renewal</Button>
                    )}
                    {account.provider === "agentmail" && account.status === "active" && (
                      <Button size="sm" disabled={busy} onClick={() => void runAction("agentmail-agentport-sync", {
                        connection_id: account.id, request_id: crypto.randomUUID().replaceAll("-", ""),
                      }, "AgentPort account, grants, channel and event subscription are synchronized.")}>Sync AgentPort link</Button>
                    )}
                    {account.provider === "agentmail" && account.status === "active" && (
                      <Button size="sm" variant="secondary" disabled={agentMailUsageBusy!==null}
                        onClick={() => void readAgentMailUsage(account)}>{agentMailUsageBusy===account.id?"Reading usage…":"Read provider usage"}</Button>
                    )}
                    {account.provider === "agentmail" && account.connectionMode === "user_connected" && account.status === "active" && account.ownerLinkId && (
                      <Button size="sm" disabled={busy} onClick={() => disconnectAgentPortOwnerLink(account)}>Disconnect AgentPort owner link</Button>
                    )}
                  </div>
                  {account.provider === "agentmail" && account.status === "active" && (
                    <div style={{ display: "grid", gap: 6, width: "100%", maxWidth: 560 }}>
                      <label htmlFor={`agentport-assistant-${account.id}`}>AgentPort event assistant</label>
                      <p className="settings-row-sub">Choose a provisioned assistant in this Space and save the route before events wake it. Events do not select a default assistant. Channel access stays available through AgentPort when event wakeups are paused.</p>
                      <FormInput id={`agentport-assistant-${account.id}`} aria-label="AgentPort event assistant ID" value={assistantRoutes[account.id] ?? account.assistantId ?? ""}
                        onChange={(event) => setAssistantRoutes((current) => ({ ...current, [account.id]: event.target.value }))} />
                      <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <input type="checkbox" checked={assistantWake[account.id] ?? account.wakeEnabled}
                          onChange={(event) => setAssistantWake((current) => ({ ...current, [account.id]: event.target.checked }))} />
                        Wake this assistant when AgentPort events arrive
                      </label>
                      <div><Button size="sm" disabled={busy || !(assistantRoutes[account.id] ?? account.assistantId ?? "").trim()}
                        onClick={() => void runAction("agentport-event-route-set", { connection_id: account.id,
                          assistant_id: (assistantRoutes[account.id] ?? account.assistantId ?? "").trim(),
                          wake_enabled: assistantWake[account.id] ?? account.wakeEnabled },
                          (assistantWake[account.id] ?? account.wakeEnabled) ? "AgentPort events now wake the selected assistant." : "AgentPort event wakeups are paused for this connection.")}>Save event routing</Button></div>
                    </div>
                  )}
                  {account.provider === "agentmail" && agentMailUsageByConnection[account.id] && (
                    <div className="settings-row-sub" role="status" style={{ width:"100%" }}>
                      AgentMail cumulative inbox usage as of {new Date(agentMailUsageByConnection[account.id]!.pointAt).toLocaleString()}: {agentMailUsageByConnection[account.id]!.usage.storageBytes.toLocaleString()} storage bytes, {agentMailUsageByConnection[account.id]!.usage.messageCount.toLocaleString()} messages, {agentMailUsageByConnection[account.id]!.usage.threadCount.toLocaleString()} threads. These provider quantities are not monetary costs or Naelao credit charges.
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {activeAgentMailAccounts.length > 0 && (
            <div className="settings-block">
              <div className="settings-row-label">AgentMail inbox and search</div>
              <p className="settings-row-sub">Read message content and provider attachments from the selected active inbox. Messages are shown as plain text; selecting an inbox uses its existing AgentPort read grant.</p>
              <div style={{ display: "grid", gap: 8, maxWidth: 720 }}>
                <label htmlFor="managed-agentmail-account">Inbox connection</label>
                {agentMailUsageError && <p role="status">{agentMailUsageError}</p>}
                <select id="managed-agentmail-account" value={activeAgentMailAccount?.id ?? ""}
                  onChange={(event) => {
                    setAgentMailConnectionId(event.target.value);
                    setAgentMailMessages([]); setAgentMailSelected(null); setAgentMailAttachment(null); setAgentMailPageToken(""); setAgentMailError("");
                  }}>
                  {activeAgentMailAccounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {title(account.connectionMode)} · {account.projectId ? `project ${account.projectId}` : "Space inbox"} · {account.id.slice(-8)}
                    </option>
                  ))}
                </select>
                <form style={{ display: "flex", gap: 8 }} onSubmit={(event) => { event.preventDefault(); void loadAgentMailMessages(); }}>
                  <FormInput aria-label="Search AgentMail inbox" placeholder="Search messages (leave empty to list inbox)"
                    value={agentMailQuery} onChange={(event) => setAgentMailQuery(event.target.value)} />
                  <Button size="sm" disabled={agentMailBusy} type="submit">{agentMailBusy ? "Loading…" : agentMailQuery.trim() ? "Search" : "Load inbox"}</Button>
                </form>
                {agentMailError && <p role="status">{agentMailError}</p>}
                {agentMailMessages.length > 0 && (
                  <div style={{ display: "grid", gap: 4 }}>
                    {agentMailMessages.map((message, index) => {
                      const messageId = providerText(message, "message_id", "messageId", "id");
                      const subject = providerText(message, "subject", "preview", "snippet") || "(no subject)";
                      const sender = providerText(message, "from", "sender", "from_address");
                      const createdAt = providerText(message, "created_at", "timestamp", "received_at");
                      return <button key={`${messageId || "message"}-${index}`} type="button" disabled={agentMailBusy || !messageId}
                        onClick={() => void readAgentMailMessage(messageId)} style={{ textAlign: "left", padding: 8 }}>
                        <strong>{subject}</strong>{sender ? ` · ${sender}` : ""}{createdAt ? ` · ${createdAt}` : ""}
                      </button>;
                    })}
                  </div>
                )}
                {agentMailMessages.length === 0 && !agentMailBusy && !agentMailError && agentMailPageToken === "" && (
                  <p className="settings-row-sub">Load the inbox or search this connection to view recent messages.</p>
                )}
                {agentMailPageToken && <div><Button size="sm" disabled={agentMailBusy} onClick={() => void loadAgentMailMessages(agentMailPageToken)}>Next page</Button></div>}
                {agentMailSelected !== null && (
                  <div>
                    <div className="settings-row-label">Selected message</div>
                    <pre style={{ maxHeight: 320, overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                      {JSON.stringify(providerMessage(providerRecord(agentMailSelected) ?? {}), null, 2).slice(0, 12000)}
                    </pre>
                    {providerAttachments(agentMailSelected).map((attachment, index) => {
                      const message = providerMessage(providerRecord(agentMailSelected) ?? {});
                      const messageId = providerText(message, "message_id", "messageId", "id");
                      const attachmentId = providerText(attachment, "attachment_id", "attachmentId", "id");
                      return <div key={`${attachmentId || "attachment"}-${index}`} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span>{providerText(attachment, "filename", "name") || `Attachment ${index + 1}`}</span>
                        <Button size="sm" disabled={agentMailBusy || !messageId || !attachmentId}
                          onClick={() => void readAgentMailAttachment(messageId, attachmentId)}>Retrieve attachment</Button>
                      </div>;
                    })}
                    {agentMailAttachment !== null && (() => {
                      const attachment = normalizeManagedServiceAttachment(agentMailAttachment);
                      if (!attachment) return <p className="settings-row-sub">Attachment metadata is unavailable. Retrieve it again.</p>;
                      return <div className="settings-block" style={{ marginTop: 10 }}>
                        <div className="settings-row-label">{attachment.filename}</div>
                        <p className="settings-row-sub">
                          {attachment.contentType ?? "Unknown content type"} · {attachment.sizeBytes === null ? "Unknown size" : `${(attachment.sizeBytes / 1024).toFixed(1)} KiB`}
                          {attachment.expiresAt ? ` · Link expires ${new Date(attachment.expiresAt).toLocaleString()}` : ""}
                        </p>
                        {attachment.tooLarge
                          ? <p className="settings-row-sub">This attachment exceeds the 20 MiB download limit.</p>
                          : attachment.expired
                            ? <p className="settings-row-sub">The signed link has expired. Retrieve the attachment again for a fresh link.</p>
                            : attachment.downloadUrl
                              ? <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                                  <a href={attachment.downloadUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Open attachment</a>
                                  {attachment.textUrl && <a href={attachment.textUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Open extracted text</a>}
                                </div>
                              : <p className="settings-row-sub">A valid signed download link was not returned. Retrieve the attachment again.</p>}
                      </div>;
                    })()}
                  </div>
                )}
              </div>
            </div>
          )}

          <h4>Credit usage</h4>
          {dashboard.usage30d.length === 0 ? <p>No managed service credits were reserved in the last 30 days.</p> : (
            <ul>{dashboard.usage30d.map((usage) => (
              <li key={`${usage.provider}:${usage.serviceId}`}>
                {title(usage.provider)}: {usage.settledCredits.toLocaleString()} settled credits, {usage.heldCredits.toLocaleString()} held, {usage.operations} operations
              </li>
            ))}</ul>
          )}

          <h4>Provider cost receipts</h4>
          {dashboard.providerCosts30d.length === 0 ? (
            <p>No provider cost observations or operator-imported receipts are recorded for the last 30 days. Provider costs are separate from these customer credit charges.</p>
          ) : (
            <ul>{dashboard.providerCosts30d.map((cost) => (
              <li key={`${cost.provider}:${cost.serviceId}:${cost.usageKind}:${cost.currency}:${cost.provenance}`}>
                {title(cost.provider)} {title(cost.usageKind)}: {new Intl.NumberFormat(undefined, { style: "currency", currency: cost.currency }).format(cost.providerCostMicros / 1_000_000)}
                {cost.provenance === "operator_imported"
                  ? ` from ${cost.receiptCount} operator-imported receipt${cost.receiptCount === 1 ? "" : "s"}`
                  : ` from ${cost.receiptCount} provider API observation${cost.receiptCount === 1 ? "" : "s"}`}
              </li>
            ))}</ul>
          )}
          {dashboard.providerCosts30d.some((cost) => cost.provenance === "provider_api_observed") &&
            <p>Provider API observations are not invoice reconciliation. Actual provider statements may include charges outside these measured operations.</p>}

          <h4>Decision model provider costs</h4>
          {dashboard.decisionModelCosts30d.length === 0 ? (
            <p>No settled OpenRouter decision-cost receipts are recorded for the last 30 days.</p>
          ) : (
            <ul>{dashboard.decisionModelCosts30d.map((cost) => (
              <li key={`${cost.modelId}:${cost.evidenceSource}`}>
                OpenRouter {cost.modelId}: {new Intl.NumberFormat(undefined, { style: "currency", currency: cost.currency }).format(cost.providerCostMicros / 1_000_000)}
                {` from ${cost.receiptCount} settled decision receipt${cost.receiptCount === 1 ? "" : "s"} (${cost.evidenceSource.replaceAll("_", " ")})`}
              </li>
            ))}</ul>
          )}
          {dashboard.decisionModelCosts30d.length > 0 &&
            <p>These costs come from settled per-generation provider receipts. They are separate from Naelao credits and do not reconcile the provider invoice.</p>}

          <h4>Rolling 30-day cost thresholds</h4>
          <p>Threshold crossings are stored as owner dashboard alerts using the selected evidence source and currency. They do not stop provider operations or reconcile invoices.</p>
          <h4>Unacknowledged provider cost alerts</h4>
          {dashboard.providerCostAlerts.length===0 ? <p>No unacknowledged threshold crossings.</p> : (
            <ul style={{ display:"grid",gap:8,paddingLeft:20 }}>
              {dashboard.providerCostAlerts.map(alert=><li key={alert.id}>
                {title(alert.provider)} · {alert.serviceId} · {alert.provenance.replaceAll("_"," ")}: recorded cost
                {" "}{formatProviderCost(alert.observedProviderCostMicros,alert.currency)} reached the
                {" "}{formatProviderCost(alert.limitProviderCostMicros,alert.currency)} rolling 30-day threshold.
                <div style={{ color:"var(--text3)",fontSize:11 }}>
                  {new Date(alert.createdAt).toLocaleString()} · {alert.windowStart} – {alert.windowEnd}
                  {alert.pushDeliveryStatus === "delivered" ? " · Browser push sent" :
                    alert.pushDeliveryStatus === "no_subscription" ? " · No browser push subscription" :
                    alert.pushDeliveryStatus === "suppressed" ? " · Browser push suppressed" :
                    alert.pushDeliveryStatus === "ambiguous" ? " · Browser push outcome unknown; check notification status" :
                    alert.pushDeliveryStatus ? " · Browser push pending" : " · Browser push not queued"}
                </div>
                <Button size="sm" variant="secondary" disabled={busy} onClick={()=>void acknowledgeProviderCostAlert(alert.id)}>Acknowledge</Button>
              </li>)}
            </ul>
          )}
          {providerCostBudgetGroups(dashboard).length === 0 ? <p>Cost thresholds become available when provider cost evidence is recorded.</p> : (
            <div style={{ display:"grid",gap:10 }}>
              {providerCostBudgetGroups(dashboard).map(group => {
                const key=providerCostBudgetKey(group);
                return <div key={key} style={{ border:"1px solid var(--border)",borderRadius:8,padding:10 }}>
                  <strong>{title(group.provider)} · {group.serviceId} · {group.provenance.replaceAll("_"," ")}</strong>
                  <div style={{ color:"var(--text3)",fontSize:12,margin:"4px 0 8px" }}>
                    Recorded in the last 30 days: {formatProviderCost(group.observedProviderCostMicros,group.currency)}
                    {group.thresholdReached && <strong role="status" style={{ color:"var(--danger, #b42318)",marginLeft:8 }}>Dashboard threshold reached</strong>}
                  </div>
                  <div style={{ display:"flex",gap:8,alignItems:"center",flexWrap:"wrap" }}>
                    <label style={{ fontSize:12 }}>Alert threshold ({group.currency})
                      <input type="number" min="0.000001" max="1000000" step="0.000001" value={costBudgetInputs[key] ?? ""}
                        onChange={event=>setCostBudgetInputs(current=>({...current,[key]:event.target.value}))} disabled={busy} />
                    </label>
                    <Button size="sm" disabled={busy || currencyLimitToMicros(costBudgetInputs[key] ?? "")===null}
                      onClick={()=>void saveProviderCostBudget(group)}>Save threshold</Button>
                    {group.limitProviderCostMicros!==null && <Button size="sm" variant="secondary" disabled={busy}
                      onClick={()=>void saveProviderCostBudget(group,true)}>Remove</Button>}
                  </div>
                </div>;
              })}
            </div>
          )}

          {dashboard.operations.some((operation) => operation.status === "uncertain") && (
            <p role="status">Some provider operations have an unknown outcome. Their credit holds remain reserved while reconciliation continues.</p>
          )}
        </>
      ) : null}
    </section>
  );
}
