"use client";
import * as React from "react";
import { useParams } from "next/navigation";
import { assistantMailApi, type SessionCredentials } from "@/lib/api";
import { spaceCompatibilityHref } from "@/lib/space-extension-dashboard";
import { phoneExtensionLineReadiness } from "./phone-extension-readiness";
interface Phone {
  provider?: "twilio" | "telnyx";
  provider_number_id?: string | null;
  id: string;
  phone_number: string | null;
  status: string;
  payer: string;
  capabilities: Record<string, boolean>;
  policy: {
    allowWebsiteVerification?: boolean;
    allowSpeechInput?: boolean;
    maxDailyActions: number;
    maxDailyInboundMessages: number;
    maxDailyInboundCalls: number;
    maxCallSeconds: number;
    greeting: string;
    voicemail: boolean;
    transferTo: string | null;
  };
  monthly_cost_minor: number | null;
}
type Row = {
  id: string;
  kind: string;
  recipient?: string;
  sender?: string;
  status: string;
  provider_sid?: string;
  cost_collection_status?: string | null;
  managed_charge_credits?: number | null;
  managed_price_version?: string | null;
  managed_reserved_credits?: number | null;
};
type PhoneHistoryPage = { data: Row[]; next_cursor: string | null };
type TelnyxInventoryNumber = { phone_number: string; country_code: string; number_type: string | null; features: string[]; locality: string | null; region: string | null; upfront_cost_minor: number; monthly_cost_minor: number; currency: string };
type PhoneHandlerCandidate = { installation_id: string; extension_id: string; name: string; version: string; handler_sha256: string };
type RecentExtensionCall = {
  installation_id: string | null;
  handler_sha256: string | null;
  state: string;
  turn_count: number;
  started_at: number;
  duration_seconds: number | null;
  caller_hint: string | null;
  cost_report: {
    status: "reported" | "unavailable" | "not_linked";
    provider_cost_micros: number | null;
    currency: string | null;
    leg_count: number | null;
  };
};
export function AssistantPhonePanel({
  spaceId,
  projectId,
  session,
}: { spaceId: string; projectId?: string; session: SessionCredentials }) {
  const route = useParams<{ slug: string }>();
  const [state, setState] = React.useState<{
      phone: Phone | null;
      enabled: boolean;
      telnyx_agentport_shared?: boolean;
      telnyx_agentport_link_status?: string | null;
      telnyx_agentport_operation?: { operation_name: string; status: string | null; error_code: string | null } | null;
      managed_available?: boolean;
      managed_reason?: string;
      managed_price_version?: string | null;
      managed_rates?: { rental_credits_per_month: number; sms_credits_per_segment: number; call_credits_per_minute: number } | null;
      telnyx_webhook_url?: string | null;
      telnyx_order?: { operation_id: string; status: string; phone_number: string; upfront_cost_minor: number; monthly_cost_minor: number; currency: string; provider_order_id: string | null } | null;
      telnyx_release?: { operation_id: string; status: string; phone_number: string; next_reconcile_at: string | null; error_code: string | null } | null;
      extension_lines?:Array<{id:string;provider:"twilio"|"telnyx";phone_number:string|null;provider_number_sid:string|null;installation_id:string|null;handler_sha256:string|null;handler_status:string|null;status:string}>;
      recent_telnyx_extension_calls?: RecentExtensionCall[];
      phone_handler_candidates?: PhoneHandlerCandidate[];
      legacy_numbers?:Array<{id:string;phone_number:string;provider_number_sid:string;status:string}>;
    } | null>(null),
    [error, setError] = React.useState(""),
    [busy, setBusy] = React.useState(false);
  const [account, setAccount] = React.useState(""),
    [secret, setSecret] = React.useState(""),
    [sid, setSid] = React.useState("");
  const [country, setCountry] = React.useState("US"),
    [number, setNumber] = React.useState(""),
    [quote, setQuote] = React.useState<{
      quote_id: string;
      monthly_cost_minor: number;
      expires_at: string;
    } | null>(null);
  const [to, setTo] = React.useState(""),
    [text, setText] = React.useState(""),
    [dtmf, setDtmf] = React.useState(""),
    [kind, setKind] = React.useState("sms");
  const [actions, setActions] = React.useState<Row[]>([]),
    [events, setEvents] = React.useState<Row[]>([]),
    [actionsCursor, setActionsCursor] = React.useState<string | null>(null),
    [eventsCursor, setEventsCursor] = React.useState<string | null>(null),
    [historyLoading, setHistoryLoading] = React.useState<"actions" | "events" | null>(null),
    [content, setContent] = React.useState(""),
    [transfer, setTransfer] = React.useState("");
  const [receipt, setReceipt] = React.useState("");
  const [telnyxKey, setTelnyxKey] = React.useState("");
  const [telnyxPublicKey, setTelnyxPublicKey] = React.useState("");
  const [telnyxNumberId, setTelnyxNumberId] = React.useState("");
  const [telnyxNumberType, setTelnyxNumberType] = React.useState("");
  const [telnyxSetup, setTelnyxSetup] = React.useState("");
  const [phoneCost, setPhoneCost] = React.useState("");
  const [telnyxNumbers, setTelnyxNumbers] = React.useState<TelnyxInventoryNumber[]>([]);
  const [telnyxQuote, setTelnyxQuote] = React.useState<{ quote_id: string; phone_number: string; upfront_cost_minor: number; monthly_cost_minor: number; currency: string; expires_at: string } | null>(null);
  const [handlerInstallation, setHandlerInstallation] = React.useState(""),
    [handlerDigest, setHandlerDigest] = React.useState("");
  const [extensionAssignments, setExtensionAssignments] = React.useState<Record<string, { installation: string; digest: string }>>({});
  const [simulationInputs, setSimulationInputs] = React.useState<Record<string, string>>({});
  const [simulationTypes, setSimulationTypes] = React.useState<Record<string, "call.received" | "call.digits" | "call.speech">>({});
  const [simulationResults, setSimulationResults] = React.useState<Record<string, string>>({});
  const [liveCall, setLiveCall] = React.useState<{
    code: string;
    expires_at: number;
    session_id: string;
    phone_number: string;
    max_charge_credits?: number;
    max_call_seconds?: number;
    price_version?: string | null;
  } | null>(null);
  const [liveSessionId, setLiveSessionId] = React.useState<
    string | undefined
  >();
  const generation = React.useRef(0);
  const historyLoadingRef = React.useRef<"actions" | "events" | null>(null);
  const call = React.useCallback(
    <T,>(action: string, args: Record<string, unknown> = {}, write = false) =>
      assistantMailApi<T>(
        spaceId,
        session,
        { ...(projectId ? { projectId } : {}), action, ...args },
        write
      ),
    [spaceId, projectId, session]
  );
  const refresh = React.useCallback(async () => {
    const g = ++generation.current;
    historyLoadingRef.current = null;
    setHistoryLoading(null);
    try {
      const result = await call<{
        phone: Phone | null;
        enabled: boolean;
        managed_available?: boolean;
        managed_reason?: string;
        managed_price_version?: string | null;
        managed_rates?: { rental_credits_per_month: number; sms_credits_per_segment: number; call_credits_per_minute: number } | null;
        telnyx_webhook_url?: string | null;
        telnyx_order?: { operation_id: string; status: string; phone_number: string; upfront_cost_minor: number; monthly_cost_minor: number; currency: string; provider_order_id: string | null } | null;
        telnyx_release?: { operation_id: string; status: string; phone_number: string; next_reconcile_at: string | null; error_code: string | null } | null;
        extension_lines?: Array<{
          id: string;
          provider: "twilio" | "telnyx";
          phone_number: string | null;
          provider_number_sid: string | null;
          installation_id: string | null;
          handler_sha256: string | null;
          handler_status: string | null;
          status: string;
        }>;
        recent_telnyx_extension_calls?: RecentExtensionCall[];
        phone_handler_candidates?: PhoneHandlerCandidate[];
        legacy_numbers?: Array<{ id: string; phone_number: string; provider_number_sid: string; status: string }>;
      }>(
        "phone-status"
      );
      if (g !== generation.current) return;
      setState(result);
      setExtensionAssignments(Object.fromEntries((result.extension_lines ?? []).map((line) => [line.id, { installation: line.installation_id ?? "", digest: line.handler_sha256 ?? "" }])));
      setTransfer(result.phone?.policy.transferTo ?? "");
      if (result.phone) {
        const [a, e] = await Promise.all([
          call<PhoneHistoryPage>("phone-actions"),
          call<PhoneHistoryPage>("phone-events"),
        ]);
        if (g !== generation.current) return;
        setActions(a.data);
        setEvents(e.data);
        setActionsCursor(a.next_cursor);
        setEventsCursor(e.next_cursor);
      } else {
        setActions([]);
        setEvents([]);
        setActionsCursor(null);
        setEventsCursor(null);
      }
    } catch (e) {
      if (g === generation.current)
        setError(e instanceof Error ? e.message : "Phone unavailable");
    }
  }, [call]);
  async function loadOlderHistory(kind: "actions" | "events") {
    const cursor = kind === "actions" ? actionsCursor : eventsCursor;
    if (!cursor || historyLoadingRef.current) return;
    const g = generation.current;
    historyLoadingRef.current = kind;
    setHistoryLoading(kind);
    setError("");
    try {
      const page = await call<PhoneHistoryPage>(kind === "actions" ? "phone-actions" : "phone-events", { before: cursor });
      if (g !== generation.current) return;
      if (kind === "actions") {
        setActions(current => [...current, ...page.data]);
        setActionsCursor(page.next_cursor);
      } else {
        setEvents(current => [...current, ...page.data]);
        setEventsCursor(page.next_cursor);
      }
    } catch (e) {
      if (g === generation.current) setError(e instanceof Error ? e.message : "Could not load older phone activity");
    } finally {
      if (g === generation.current) {
        historyLoadingRef.current = null;
        setHistoryLoading(null);
      }
    }
  }
  React.useEffect(() => {
    setState(null);
    setQuote(null);
    setSecret("");
    setReceipt("");
    setHandlerInstallation("");
    setHandlerDigest("");
    setLiveCall(null);
    setLiveSessionId(undefined);
    setAccount("");
    setTelnyxKey("");
    setTelnyxPublicKey("");
    setTelnyxNumberId("");
    setTelnyxSetup("");
    setPhoneCost("");
    setSid("");
    setTo("");
    setText("");
    setContent("");
    setActions([]);
    setEvents([]);
    setActionsCursor(null);
    setEventsCursor(null);
    historyLoadingRef.current = null;
    setHistoryLoading(null);
    setError("");
    void refresh();
    return () => {
      generation.current++;
    };
  }, [refresh]);
  async function act(action: string, args: Record<string, unknown> = {}) {
    const g = generation.current;
    setBusy(true);
    setError("");
    try {
      const result = await call<Record<string, unknown>>(action, args, true);
      if (g !== generation.current) return;
      if (action === "phone-quote")
        setQuote(
          result as unknown as {
            quote_id: string;
            monthly_cost_minor: number;
            expires_at: string;
          }
        );
      if (action === "phone-telnyx-search") setTelnyxNumbers((result.numbers as TelnyxInventoryNumber[] | undefined) ?? []);
      if (action === "phone-telnyx-quote") setTelnyxQuote(result as unknown as { quote_id: string; phone_number: string; upfront_cost_minor: number; monthly_cost_minor: number; currency: string; expires_at: string });
      if (action === "phone-telnyx-order") setTelnyxQuote(null);
      if (action === "phone-event")
        setContent(JSON.stringify(result.body, null, 2));
      if (action === "phone-handler-test") {
        const response = result.response as { actions?: Array<{ type?: string; text?: string }> } | undefined;
        const spoken = response?.actions?.map(item => item.type === "hangup" ? "Call would end." : item.text)
          .filter((item): item is string => typeof item === "string" && item.length > 0) ?? [];
        const bindingId = String(args.binding_id ?? "");
        const eventType = String(args.event_type ?? "call.speech");
        setSimulationResults(current => ({ ...current, [bindingId]: `${eventType}: ${spoken.join("\n") || "The handler returned no spoken text."}` }));
      }
      if (action === "phone-live") {
        setLiveCall(
          result as unknown as {
            code: string;
            expires_at: number;
            session_id: string;
            phone_number: string;
            max_charge_credits?: number;
            price_version?: string | null;
          }
        );
        setLiveSessionId(String(result.session_id));
      }
      if (action === "phone-live-end") setLiveCall(null);
      if (action === "phone-credentials") setSecret("");
      if (["phone-telnyx-configure", "phone-telnyx-status", "phone-telnyx-remove"].includes(action)) {
        setTelnyxKey("");
        setTelnyxSetup(result.configured ? `Telnyx account verified for ${String(result.phone_number)}. Messaging and eligible call control can be activated after webhook verification.` : "No Telnyx account configured.");
      }
      if (action === "phone-telnyx-activate") setTelnyxSetup(result.voice_cost_webhooks_enabled === true
        ? "Telnyx call cost webhooks are enabled. Signed call.cost events are recorded as provider API observations, not invoice reconciliation."
        : "Channels are active, but Telnyx call cost webhooks are disabled. Enable call_cost_in_webhooks in the associated Call Control Application, then check the setting.");
      if (action === "phone-telnyx-cost-status") setTelnyxSetup(result.call_cost_webhooks_enabled === true
        ? "Telnyx call cost webhooks are enabled."
        : "Telnyx call cost webhooks are still disabled.");
      if (["phone-telnyx-cost", "phone-twilio-cost"].includes(action)) {
        const carrier = action === "phone-telnyx-cost" ? "Telnyx" : "Twilio";
        setPhoneCost(result.status === "observed"
          ? `Provider API-reported message charge: ${String(result.amount)} ${String(result.currency)}. ${carrier} bills your account; this is not an invoice.`
          : "Provider API has not reported a final message charge yet.");
      }
      await refresh();
    } catch (e) {
      if (g === generation.current)
        setError(e instanceof Error ? e.message : "Phone action failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Assistant phone">
      <h4>Optional phone</h4>
      {state?.legacy_numbers?.map((line) => (
        <fieldset key={line.id} disabled={busy}>
          <legend>Phone number awaiting extension migration</legend>
          <p>{line.phone_number} · currently uses a retired callback</p>
          <p>Move it onto Naelao’s phone transport, then assign an installed phone extension. The old callback will not be restored if you later detach this number.</p>
          <button type="button" onClick={() => {
            if (window.confirm(`Move ${line.phone_number} to the extension phone handler? Calls will stay unavailable until you assign an extension.`))
              void act("phone-import", { number_sid: line.provider_number_sid, legacy_binding_id: line.id, confirm: true });
          }}>Move number to extension setup</button>
        </fieldset>
      ))}
      {state?.extension_lines?.map((line) => {
        const assignment = extensionAssignments[line.id] ?? { installation: "", digest: "" };
        const simulationType = simulationTypes[line.id] ?? (line.provider === "telnyx" ? "call.received" : "call.speech");
        const simulationInput = simulationInputs[line.id] ?? "";
        const readiness = phoneExtensionLineReadiness({ ...line, handler_candidates: state?.phone_handler_candidates ?? [] });
        const verifiedCandidate = state?.phone_handler_candidates?.find(candidate =>
          candidate.installation_id === line.installation_id && candidate.handler_sha256 === line.handler_sha256);
        return <fieldset key={line.id} disabled={busy}>
          <legend>Extension phone handler</legend>
          <p>{line.phone_number ?? "Phone number"} · {line.status} · {line.handler_status ?? "No handler assigned"}</p>
          <p role="status"><strong>Routing readiness:</strong> {readiness.label}</p>
          {readiness.state === "ready" && verifiedCandidate && <p><a href={spaceCompatibilityHref(route.slug, spaceId, "extensions", verifiedCandidate.installation_id)} target="_blank" rel="noopener noreferrer">Open this handler's settings and dashboard</a></p>}
          {(state?.phone_handler_candidates?.length ?? 0) > 0 && <label>Installed phone handler <select value={state?.phone_handler_candidates?.some(candidate => candidate.installation_id === assignment.installation) ? assignment.installation : ""} onChange={(event) => {
            const candidate = state?.phone_handler_candidates?.find(item => item.installation_id === event.target.value);
            setExtensionAssignments((current) => ({ ...current, [line.id]: candidate
              ? { installation: candidate.installation_id, digest: candidate.handler_sha256 }
              : { installation: "", digest: "" } }));
          }}>
            <option value="">Choose an active signed installation</option>
            {state?.phone_handler_candidates?.map(candidate => <option key={candidate.installation_id} value={candidate.installation_id}>{candidate.name} · v{candidate.version}</option>)}
          </select></label>}
          <details><summary>Installation reference</summary>
            <p>Only active, signed phone handlers with matching installed package bytes appear in the list. The host checks the release again before assignment.</p>
            <label>Installation ID <input value={assignment.installation} onChange={(e) => setExtensionAssignments((current) => ({ ...current, [line.id]: { ...assignment, installation: e.target.value } }))} /></label>
            <label>Handler SHA-256 <input value={assignment.digest} maxLength={64} onChange={(e) => setExtensionAssignments((current) => ({ ...current, [line.id]: { ...assignment, digest: e.target.value } }))} /></label>
          </details>
          <button type="button" onClick={() => {
            const candidate = state?.phone_handler_candidates?.find(item => item.installation_id === assignment.installation && item.handler_sha256 === assignment.digest);
            const description = candidate ? `${candidate.name} v${candidate.version}` : assignment.installation;
            if (window.confirm(`Assign ${description} as the handler for ${line.phone_number ?? "this phone line"}? The host will validate the signed release before activating it.`))
              void act("phone-handler", { binding_id: line.id, installation_id: assignment.installation, handler_sha256: assignment.digest, confirm: true });
          }}>Assign or update extension</button>{" "}
          <button type="button" onClick={() => { if (window.confirm("Detach this number and restore its prior carrier callbacks?")) void act("phone-detach", { binding_id: line.id, confirm: true }); }}>Detach number</button>
          {line.status === "active" && line.handler_status === "active" && <div>
            <label>Test event <select value={simulationType} onChange={event => setSimulationTypes(current => ({ ...current, [line.id]: event.target.value as "call.received" | "call.digits" | "call.speech" }))}>
              <option value="call.received">Start call greeting</option>
              <option value="call.digits">Keypad digits</option>
              {line.provider === "twilio" && <option value="call.speech">Synthetic caller speech</option>}
            </select></label>
            {simulationType === "call.digits" && <label>Keypad digits <input inputMode="numeric" pattern="[0-9]{1,8}" maxLength={8} value={simulationInput}
              onChange={event => setSimulationInputs(current => ({ ...current, [line.id]: event.target.value }))}
              placeholder="For example, 1" /></label>}
            {simulationType === "call.speech" && <label>Try caller speech <textarea value={simulationInput} maxLength={2_000}
              onChange={event => setSimulationInputs(current => ({ ...current, [line.id]: event.target.value }))}
              placeholder="Enter a synthetic caller message" /></label>}
            <button type="button" disabled={simulationType === "call.digits" ? !/^[0-9]{1,8}$/.test(simulationInput) : simulationType === "call.speech" && !simulationInput.trim()}
              onClick={() => void act("phone-handler-test", { binding_id: line.id, event_type: simulationType,
                ...(simulationType === "call.digits" ? { digits: simulationInput } : simulationType === "call.speech" ? { input: simulationInput } : {}) })}>
              Run local simulation
            </button>
            <p>This runs the active signed handler with a synthetic {line.provider === "telnyx" ? "call or DTMF" : "call, DTMF, or speech"} event. It does not contact the carrier or save a call or conversation session.</p>
            {simulationResults[line.id] && <pre aria-label="Simulated phone response" role="status" style={{ whiteSpace: "pre-wrap" }}>{simulationResults[line.id]}</pre>}
          </div>}
        </fieldset>;
      })}
      {((state?.extension_lines?.length ?? 0) > 0 || (state?.recent_telnyx_extension_calls?.length ?? 0) > 0) && <details style={{ marginTop: 12 }}>
        <summary>Recent customer extension calls · Telnyx</summary>
        <p>The latest 50 call records from the last 7 days. Caller IDs are masked. Costs appear only when a signed Telnyx report is linked. No linked report means the amount is unknown, not zero. These provider-reported amounts are not invoices or customer charges.</p>
        {state?.recent_telnyx_extension_calls?.length ? (() => {
          const groups = new Map<string, RecentExtensionCall[]>();
          for (const call of state.recent_telnyx_extension_calls) {
            const key = call.installation_id && call.handler_sha256 ? JSON.stringify([call.installation_id, call.handler_sha256]) : "legacy-unpinned";
            groups.set(key, [...(groups.get(key) ?? []), call]);
          }
          return [...groups.entries()].map(([key, calls]) => {
            const first = calls[0]!;
            const candidate = first.installation_id ? state.phone_handler_candidates?.find(item => item.installation_id === first.installation_id
              && item.handler_sha256 === first.handler_sha256) : undefined;
            const reportedByCurrency = new Map<string, bigint>();
            for (const call of calls) if (call.cost_report.status === "reported" && call.cost_report.currency
              && Number.isSafeInteger(call.cost_report.provider_cost_micros) && call.cost_report.provider_cost_micros !== null) {
              reportedByCurrency.set(call.cost_report.currency, (reportedByCurrency.get(call.cost_report.currency) ?? 0n) + BigInt(call.cost_report.provider_cost_micros));
            }
            const reportedTotal = (micros: bigint) => `${micros / 1_000_000n}.${(micros % 1_000_000n).toString().padStart(6, "0")}`;
            const reportedCalls = calls.filter(call => call.cost_report.status === "reported").length;
            const unavailableCalls = calls.filter(call => call.cost_report.status === "unavailable").length;
            const unlinkedCalls = calls.filter(call => call.cost_report.status === "not_linked").length;
            return <section key={key} style={{ margin: "12px 0", padding: 10, border: "1px solid var(--border, #ddd)", borderRadius: 8 }}>
              <h4 style={{ margin: "0 0 6px" }}>{candidate ? `${candidate.name} · v${candidate.version}` : first.installation_id ? `Installation ${first.installation_id}` : "Legacy calls · installation not recorded"}</h4>
              {first.handler_sha256 && <p>Handler SHA-256: <code>{first.handler_sha256}</code></p>}
              <p>{calls.length} calls · {reportedCalls} with provider reports · {unavailableCalls} unavailable · {unlinkedCalls} without a linked report. Telnyx reported totals: {[...reportedByCurrency].map(([currency, amount]) => `${currency} ${reportedTotal(amount)}`).join(" · ") || "unknown"}. These are provider observations, not invoices or customer charges.</p>
              <ol>{calls.map((call, index) => {
                const cost = call.cost_report;
                const costLabel = cost.status === "reported" && cost.provider_cost_micros !== null && cost.currency
                  ? `Telnyx reported ${cost.currency} ${(cost.provider_cost_micros / 1_000_000).toFixed(6)}${cost.leg_count ? ` across ${cost.leg_count} cost legs` : ""}`
                  : cost.status === "unavailable"
                    ? "Provider cost report unavailable"
                    : "No linked provider report · amount unknown, not zero";
                return <li key={`${call.started_at}:${index}`}>
                  {new Date(call.started_at * 1000).toLocaleString()} · {call.state} · {call.caller_hint ?? "Caller unavailable"} · {call.turn_count} turns · {call.duration_seconds === null ? "duration unavailable" : `${call.duration_seconds}s`} · {costLabel}
                </li>;
              })}</ol>
            </section>;
          });
        })() : <p>No recent Telnyx extension calls are recorded.</p>}
      </details>}
      <p>
        {state?.phone?.phone_number ?? "No number connected"}{" "}
        {state?.phone?.status ?? ""}
        {state?.phone ? ` · ${state.phone.provider ?? "twilio"}` : ""}
      </p>
      {state?.phone?.provider === "telnyx" && state.phone.capabilities.voice === true
        && state.phone.capabilities.call_cost_webhooks !== true && <p role="status">
          Telnyx per-call cost events are disabled or have not been verified for this Call Control Application. Enable call cost webhooks at Telnyx, then check the setting below. Until enabled, provider cost observations omit these calls; the dashboard does not reconcile invoices.
        </p>}
      <p>
        Space Assistant phone actions require the phone channel to be enabled. Customer extension lines are managed separately.
        {state?.phone?.payer === "managed" ? " Naelao bills rental and usage to the space plan using the configured carrier price schedule." : " Your carrier bills your account directly for rental, calls, SMS/MMS and other carrier charges."}
      </p>
      {state?.managed_rates && <p>Managed Telnyx rate schedule {state.managed_price_version ?? "unversioned"}: {state.managed_rates.rental_credits_per_month} credits/month, {state.managed_rates.sms_credits_per_segment} credits/SMS segment, {state.managed_rates.call_credits_per_minute} credits/call minute.{state.managed_available ? " Rates are saved when you confirm a managed line." : " Managed Telnyx rollout is unavailable."}</p>}
      {!state?.managed_available && state?.managed_reason && <p role="status">{state.managed_reason}</p>}
      {error && <p role="alert">{error}</p>}
      <button type="button" disabled={busy} onClick={() => void refresh()}>
        Refresh phone
      </button>
      <details style={{ marginTop: 12 }}>
        <summary>Telnyx setup</summary>
        <p>Connect or order a number through your Telnyx account. BYO inventory and usage are billed directly by Telnyx. Naelao managed inventory remains available only for numbers already assigned to the configured Naelao Telnyx account and approved plan rates.</p>
        <fieldset disabled={busy || !state?.enabled}>
          <legend>Verify Telnyx account</legend>
          <label>API key <input type="password" autoComplete="new-password" value={telnyxKey} onChange={event => setTelnyxKey(event.target.value)} /></label>
          <label>Webhook public key <input autoComplete="off" value={telnyxPublicKey} onChange={event => setTelnyxPublicKey(event.target.value)} /></label>
          <label>Existing number resource ID <input inputMode="numeric" autoComplete="off" value={telnyxNumberId} onChange={event => setTelnyxNumberId(event.target.value)} /></label>
          <button type="button" disabled={!telnyxKey || !telnyxPublicKey || !telnyxNumberId} onClick={() => void act("phone-telnyx-configure", { api_key: telnyxKey, public_key: telnyxPublicKey, number_id: telnyxNumberId })}>Verify and save</button>{" "}
          <button type="button" onClick={() => void act("phone-telnyx-status")}>Check setup status</button>
          {(!state?.phone || ["released", "detached"].includes(state.phone.status)) && <button type="button" onClick={() => { if (window.confirm("Prepare this number for your assistant? Calls and SMS will remain unavailable until its connection is activated.")) void act("phone-telnyx-stage", { confirm: true }); }}>Prepare assistant number</button>}
          {state?.managed_available && (!state.phone || ["released", "detached"].includes(state.phone.status)) && <div>
            <p>Naelao managed inventory is available. Enter a number resource ID already assigned to Naelao’s Telnyx messaging profile and call control application.</p>
            <button type="button" disabled={!telnyxNumberId || !state.managed_price_version || !state.managed_rates} onClick={() => {
              const rates = state.managed_rates!, version = state.managed_price_version!;
              if (window.confirm(`Bind managed Telnyx number ${telnyxNumberId} to rate schedule ${version}: ${rates.rental_credits_per_month} credits/month, ${rates.sms_credits_per_segment} credits/SMS segment, and ${rates.call_credits_per_minute} credits/call minute? Future rate changes will not alter this line.`))
                void act("phone-telnyx-managed-stage", { number_id: telnyxNumberId, confirm: true, confirmed_price_version: version,
                  confirmed_rental_credits_per_month: rates.rental_credits_per_month,
                  confirmed_sms_credits_per_segment: rates.sms_credits_per_segment,
                  confirmed_call_credits_per_minute: rates.call_credits_per_minute });
            }}>Prepare managed Telnyx number</button>
          </div>}
          {telnyxSetup && <p role="status">{telnyxSetup}</p>}
        </fieldset>
        {(!state?.phone || ["released", "detached"].includes(state.phone.status)) && <fieldset disabled={busy || !state?.enabled}>
          <legend>Search and order from your Telnyx account</legend>
          <label>Country code <input value={country} maxLength={2} onChange={event => { setCountry(event.target.value.toUpperCase()); setTelnyxNumbers([]); setTelnyxQuote(null); }} /></label>{" "}
          <label>Number type <select value={telnyxNumberType} onChange={event => setTelnyxNumberType(event.target.value)}><option value="">Any type</option><option value="local">Local</option><option value="toll_free">Toll free</option><option value="mobile">Mobile</option><option value="national">National</option><option value="shared_cost">Shared cost</option></select></label>{" "}
          <button type="button" onClick={() => void act("phone-telnyx-search", { country, ...(telnyxNumberType ? { number_type: telnyxNumberType } : {}) })}>Search voice and SMS numbers</button>
          {telnyxNumbers.map(item => <p key={item.phone_number}>
            {item.phone_number} · {item.locality ?? item.region ?? item.country_code} · {item.number_type ?? "number"} · ${(item.upfront_cost_minor / 100).toFixed(2)} upfront + ${(item.monthly_cost_minor / 100).toFixed(2)}/month · {item.currency}{" "}
            <button type="button" onClick={() => void act("phone-telnyx-quote", { country: item.country_code, phone_number: item.phone_number })}>Quote</button>
          </p>)}
          {telnyxQuote && <p>
            Telnyx quote for {telnyxQuote.phone_number}: ${(telnyxQuote.upfront_cost_minor / 100).toFixed(2)} upfront + ${(telnyxQuote.monthly_cost_minor / 100).toFixed(2)}/month, plus usage, taxes and regulatory fees. Expires {telnyxQuote.expires_at}.{" "}
            <button type="button" onClick={() => { if (window.confirm(`Order ${telnyxQuote.phone_number} from your Telnyx account for $${(telnyxQuote.upfront_cost_minor / 100).toFixed(2)} upfront and $${(telnyxQuote.monthly_cost_minor / 100).toFixed(2)} monthly, plus usage and taxes?`)) void act("phone-telnyx-order", { quote_id: telnyxQuote.quote_id, confirm: true, confirm_upfront_cost_minor: telnyxQuote.upfront_cost_minor, confirm_monthly_cost_minor: telnyxQuote.monthly_cost_minor }); }}>Confirm Telnyx purchase</button>
          </p>}
        </fieldset>}
        {state?.telnyx_order && ["uncertain", "pending"].includes(state.telnyx_order.status) && <p role="status">
          Telnyx order for {state.telnyx_order.phone_number} is {state.telnyx_order.status}; no new order will be submitted while its outcome is unresolved. {state.telnyx_order.status === "uncertain" ? "Reconcile its provider receipt before continuing." : "The provider is still processing it."}{" "}
          <button type="button" disabled={busy} onClick={() => void act("phone-telnyx-order-reconcile", { operation_id: state.telnyx_order!.operation_id })}>Check Telnyx order status</button>
        </p>}
        {state?.telnyx_release && ["submitting", "uncertain"].includes(state.telnyx_release.status) && <p role="status">
          Managed Telnyx release for {state.telnyx_release.phone_number} is {state.telnyx_release.status}. Naelao will inspect that number on the scheduled reconciliation path and will not repeat the release request. Check again after {state.telnyx_release.next_reconcile_at ? new Date(state.telnyx_release.next_reconcile_at).toLocaleString() : "the next check"}.
        </p>}
        {state?.phone?.provider === "telnyx" && state.phone.status === "configuring" && !["pending", "uncertain"].includes(state.telnyx_order?.status ?? "") && <button type="button" disabled={busy} onClick={() => { if (window.confirm("Cancel this unfinished number setup? Telnyx will continue to bill the number.")) void act("phone-telnyx-cancel", { confirm: true }); }}>Cancel number setup</button>}
        {state?.phone?.provider === "telnyx" && state.phone.status === "configuring" && state.phone.provider_number_id && <div>
          <p>Set the Telnyx messaging profile and call control application webhook URL to <code>{state.telnyx_webhook_url ?? "unavailable: public phone endpoint is not configured"}</code> with API version 2. Naelao verifies both before enabling the supported channels.</p>
          <button type="button" disabled={busy || !state.telnyx_webhook_url} onClick={() => void act("phone-telnyx-activate", { confirm: true })}>Verify and enable channels</button>
        </div>}
        {state?.phone?.provider === "telnyx" && ["active", "billing_hold", "indeterminate"].includes(state.phone.status) && <button type="button" disabled={busy} onClick={() => { const managed = state.phone?.payer === "managed"; if (window.confirm(managed ? "Release this Naelao managed number at Telnyx? The current month rental is not refundable. For a billing hold or uncertain release, first check the Telnyx number record." : "Detach this BYO number? Its carrier webhook and rental continue until you change them at Telnyx.")) void act("phone-telnyx-detach", { confirm: true, ...(state.phone?.status !== "active" ? { provider_checked: true } : {}) }); }}>{state.phone.payer === "managed" ? "Release managed Telnyx number" : "Detach Telnyx number"}</button>}
        {state?.phone?.provider === "telnyx" && state.phone.payer === "byo" && state.phone.status === "active" && (state.telnyx_agentport_shared
          ? <button type="button" disabled={busy} onClick={() => { if (window.confirm("Revoke this assistant’s AgentPort permission to use this Telnyx number for SMS? Existing approved phone actions still require your approval.")) void act("phone-agentport-unlink", { confirm: true }); }}>Revoke AgentPort SMS access</button>
          : state.telnyx_agentport_operation?.operation_name === "agentport_revoke" && ["revoking", "unknown"].includes(state.telnyx_agentport_link_status ?? "")
            ? <button type="button" disabled={busy} onClick={() => { if (window.confirm("The previous AgentPort revoke was not confirmed. Retry revoking this SMS account before detaching the number?")) void act("phone-agentport-unlink", { confirm: true }); }}>Retry AgentPort revoke</button>
            : <button type="button" disabled={busy} onClick={() => { if (window.confirm("Share this Telnyx number with the current assistant in AgentPort for SMS sending? Each message still requires your explicit approval, and the provider bills your Telnyx account.")) void act("phone-agentport-share", { confirm: true }); }}>{state.telnyx_agentport_operation?.operation_name === "agentport_sync" && ["pending", "uncertain"].includes(state.telnyx_agentport_operation.status ?? "") ? "Retry AgentPort SMS share" : "Share SMS with AgentPort"}</button>)}
        {state?.phone?.provider === "telnyx" && state.phone.payer === "byo" && state.phone.status === "active" && (state.telnyx_agentport_shared
          ? <button type="button" disabled={busy} onClick={() => { if (window.confirm("Revoke this assistant’s AgentPort permission to use this Telnyx number for SMS? Existing approved phone actions still require your approval.")) void act("phone-agentport-unlink", { confirm: true }); }}>Revoke AgentPort SMS access</button>
          : <button type="button" disabled={busy} onClick={() => { if (window.confirm("Share this Telnyx number with the current assistant in AgentPort for SMS sending? Each message still requires your explicit approval, and the provider bills your Telnyx account.")) void act("phone-agentport-share", { confirm: true }); }}>Share SMS with AgentPort</button>)}
        <button type="button" disabled={busy} onClick={() => { if (window.confirm("Remove the saved Telnyx account credentials? This does not release numbers at Telnyx.")) void act("phone-telnyx-remove", { confirm: true }); }}>Remove saved Telnyx credentials</button>
        {state?.phone?.provider === "telnyx" && state.phone.status === "active" && state.phone.capabilities.voice === true
          && <button type="button" disabled={busy} onClick={() => void act("phone-telnyx-cost-status")}>Check call cost webhook setting</button>}
      </details>
      {!state?.phone ||
      ["released", "detached"].includes(state.phone.status) ? (
        <fieldset disabled={busy || !state?.enabled}>
          <legend>Connect your Twilio number</legend>
          <label>
            Account SID{" "}
            <input
              value={account}
              onChange={(e) => setAccount(e.target.value)}
              autoComplete="off"
            />
          </label>
          <label>
            Auth token{" "}
            <input
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              autoComplete="new-password"
            />
          </label>
          <button
            type="button"
            onClick={() =>
              void act("phone-credentials", {
                account_sid: account,
                auth_token: secret,
              })
            }
          >
            Save scoped credentials
          </button>
          <label>
            Existing number SID{" "}
            <input
              value={sid}
              onChange={(e) => setSid(e.target.value)}
              placeholder="PN…"
            />
          </label>
          <button
            type="button"
            onClick={() => {
              if (
                window.confirm(
                  "Attach this number and replace its voice and message callbacks? Its carrier rental continues."
                )
              )
                void act("phone-import", { number_sid: sid, confirm: true });
            }}
          >
            Attach existing number
          </button>
          <label>
            Country{" "}
            <input
              value={country}
              maxLength={2}
              onChange={(e) => setCountry(e.target.value.toUpperCase())}
            />
          </label>
          <label>
            Available number{" "}
            <input
              value={number}
              onChange={(e) => {
                setNumber(e.target.value);
                setQuote(null);
              }}
              placeholder="+…"
            />
          </label>
          <button
            type="button"
            onClick={() =>
              void act("phone-quote", { country, phone_number: number })
            }
          >
            Get current rental quote
          </button>
          {quote && (
            <p>
              Rental ${(quote.monthly_cost_minor / 100).toFixed(2)} USD/month,
              plus usage and taxes. Quote expires {quote.expires_at}.{" "}
              <button
                type="button"
                onClick={() => {
                  if (
                    window.confirm(
                      "Buy this recurring number from your Twilio account at the quoted monthly rental, plus carrier usage and taxes?"
                    )
                  )
                    void act("phone-purchase", {
                      quote_id: quote.quote_id,
                      confirm: true,
                      confirm_monthly_cost_minor: quote.monthly_cost_minor,
                    });
                }}
              >
                Confirm paid purchase
              </button>
            </p>
          )}
        </fieldset>
      ) : (
        <>
          {["configuring", "indeterminate", "failed"].includes(
            state.phone.status
          ) && (
            <fieldset disabled={busy}>
              <legend>Reconcile number setup</legend>
              <p>
                Check your carrier account before doing anything else. If the
                number was created and these assistant callbacks are attached,
                enter its number SID to recover the binding. Do not purchase a
                second number.
              </p>
              <label>
                Carrier number SID{" "}
                <input
                  value={sid}
                  onChange={(e) => setSid(e.target.value)}
                  placeholder="PN…"
                />
              </label>
              <button
                type="button"
                onClick={() => {
                  if (
                    window.confirm(
                      "Have you checked that this existing carrier number belongs to this assistant setup?"
                    )
                  )
                    void act("phone-reconcile-number", {
                      provider_checked: true,
                      number_sid: sid,
                    });
                }}
              >
                Verify existing number
              </button>
            </fieldset>
          )}

          {state.phone.status === "active" && (
            <>
              <fieldset disabled={busy || !state.enabled}>
                <legend>Calls and messages</legend>
                <label>
                  Action{" "}
                  <select
                    value={kind}
                    onChange={(e) => setKind(e.target.value)}
                  >
                    <option value="sms">SMS</option>
                    {state?.phone?.provider !== "telnyx" && <option value="call">Call with spoken message</option>}
                  </select>
                </label>
                <label>
                  Recipient{" "}
                  <input
                    value={to}
                    onChange={(e) => setTo(e.target.value)}
                    placeholder="+…"
                  />
                </label>
                <label>
                  Message{" "}
                  <textarea
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                  />
                </label>
                {kind === "call" && (
                  <label>
                    DTMF digits before speaking{" "}
                    <input
                      value={dtmf}
                      onChange={(e) => setDtmf(e.target.value)}
                      placeholder="123w4#"
                    />
                  </label>
                )}
                <button
                  type="button"
                  onClick={() =>
                    void act("phone-draft", { kind, to, text, dtmf })
                  }
                >
                  Create approval draft
                </button>
              </fieldset>
              <fieldset disabled={busy}>
                <legend>Inbound calls</legend>
                <fieldset disabled={busy}>
                  <legend>Talk to your assistant by phone</legend>
                  <p>
                    Create a private call code, call this number, and enter the
                    code. Your assistant uses its normal tools and saves the
                    task. Approvals stay in Naelao. Carrier charges apply.
                  </p>
                  <button
                    type="button"
                    disabled={!state.enabled}
                    onClick={() => {
                      const managed = state.phone?.provider === "telnyx" && state.phone.payer === "managed";
                      const seconds = state.phone?.policy.maxCallSeconds ?? 300;
                      const version = state.managed_price_version;
                      const maxCharge = managed && state.managed_rates ? Math.ceil(seconds / 60) * state.managed_rates.call_credits_per_minute : null;
                      if (managed && (!version || maxCharge === null)) return;
                      if (!managed || window.confirm(`Create a one-time call code for up to ${seconds} seconds, reserving a maximum of ${maxCharge} credits under managed Telnyx rate schedule ${version}?`))
                        void act("phone-live", {
                          confirm: true,
                          ...(managed ? { confirmed_price_version: version, confirmed_max_charge_credits: maxCharge } : {}),
                          ...(liveSessionId ? { session_id: liveSessionId } : {}),
                        });
                    }}
                  >
                    Get one-time call code
                  </button>
                  {liveCall && (
                    <div role="status">
                      <p>
                        Call {liveCall.phone_number}. Enter{" "}
                        <strong>{liveCall.code}</strong>. The code expires at{" "}
                        {new Date(
                          liveCall.expires_at * 1000
                        ).toLocaleTimeString()}
                        . Keep it private.
                      </p>
                      {liveCall.max_charge_credits !== undefined && <p>Maximum reserved charge: {liveCall.max_charge_credits} credits under rate schedule {liveCall.price_version} for {liveCall.max_call_seconds} seconds. Final charge uses the connected call duration at that rate.</p>}
                      <button
                        type="button"
                        onClick={() =>
                          void act("phone-live-end", { confirm: true })
                        }
                      >
                        End and revoke phone access
                      </button>
                    </div>
                  )}
                </fieldset>
                <fieldset disabled={busy}>
                  <legend>Extension phone handler</legend>
                  <p>
                    Bind a signed channel extension installed in this Space or
                    project. The extension owns the caller experience and may
                    use opted-in bounded conversation state. The host owns the
                    call and SMS transport, callback URLs, provider checks, and
                    response limits. Speech capture and keypad input are passed
                    to the extension as untrusted caller input.
                  </p>
                  <p>Assigning this number routes calls and messages to the selected extension. The extension defines its behavior; Naelao provides the carrier callbacks, caller input, and bounded response transport. End active calls before changing the line.</p>
                  <label>
                    Installation ID{" "}
                    <input
                      value={handlerInstallation}
                      onChange={(e) => setHandlerInstallation(e.target.value)}
                    />
                  </label>
                  <label>
                    Handler SHA-256{" "}
                    <input
                      value={handlerDigest}
                      onChange={(e) => setHandlerDigest(e.target.value)}
                      maxLength={64}
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() =>
                      void act("phone-handler", {
                        installation_id: handlerInstallation,
                        handler_sha256: handlerDigest,
                        confirm: true,
                      })
                    }
                  >
                    Assign this number to the extension
                  </button>
                </fieldset>

                <fieldset disabled={busy || !state.enabled}>
                <p>
                  Call speech, keypad input, and SMS are delivered to the assigned
                  extension as untrusted input. Extension conversation state is
                  available only when its manifest enables scoped sessions.
                </p>
                <label>
                  <input
                    type="checkbox"
                    checked={state.phone.policy.allowSpeechInput === true}
                    onChange={(e) => {
                      if (e.target.checked && !window.confirm("Allow the phone provider to transcribe caller speech for this extension line?")) return;
                      void act("phone-policy", {
                        policy: { ...state.phone!.policy, allowSpeechInput: e.target.checked },
                      });
                    }}
                  />{" "}
                  Allow speech recognition on extension calls
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={
                      state.phone.policy.allowWebsiteVerification === true
                    }
                    onChange={(e) =>
                      void act("phone-policy", {
                        policy: {
                          ...state.phone!.policy,
                          allowWebsiteVerification: e.target.checked,
                        },
                      })
                    }
                  />{" "}
                  Allow this number’s owner to receive task-bound website
                  verification codes privately
                </label>
                <p>
                  Caller ID never authenticates an owner command. Recording and
                  transcription are off until enabled.
                </p>
                <label>
                  Human transfer destination{" "}
                  <input
                    value={transfer}
                    onChange={(e) => setTransfer(e.target.value)}
                    placeholder="Optional +…"
                  />
                </label>
                <button
                  type="button"
                  onClick={() =>
                    void act("phone-policy", {
                      policy: {
                        ...state.phone!.policy,
                        transferTo: transfer || null,
                      },
                    })
                  }
                >
                  Save transfer destination
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (
                      state.phone!.policy.voicemail ||
                      window.confirm(
                        "Enable provider recording and transcription of messages after callers choose voicemail?"
                      )
                    )
                      void act("phone-policy", {
                        policy: {
                          ...state.phone!.policy,
                          voicemail: !state.phone!.policy.voicemail,
                        },
                      });
                  }}
                >
                  {state.phone.policy.voicemail
                    ? "Disable voicemail"
                    : "Enable voicemail and transcription"}
                </button>
                </fieldset>
              </fieldset>
            </>
          )}
          <p>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (
                  window.confirm(
                    "Detach and restore prior callbacks? The number stays in your Twilio account and rental continues."
                  )
                )
                  void act("phone-detach", { confirm: true });
              }}
            >
              Detach (keep carrier number)
            </button>{" "}
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (
                  window.confirm(
                    "Permanently release this phone number? You may lose access to accounts using it for recovery."
                  )
                )
                  void act("phone-release", { confirm: true });
              }}
            >
              Release number
            </button>
          </p>
          {actions.some((a) =>
            ["sending", "indeterminate"].includes(a.status)
          ) && (
            <fieldset disabled={busy}>
              <legend>Reconcile a held action</legend>
              <label>
                Carrier call/message SID if submitted{" "}
                <input
                  value={receipt}
                  onChange={(e) => setReceipt(e.target.value)}
                  placeholder={state?.phone?.provider === "telnyx" ? "Telnyx message ID" : "CA… or SM…"}
                />
              </label>
              {actions
                .filter((a) => ["sending", "indeterminate"].includes(a.status))
                .map((a) => (
                  <p key={a.id}>
                    {a.kind} to {a.recipient}{" "}
                    <button
                      type="button"
                      onClick={() =>
                        void act(state?.phone?.provider === "telnyx" ? "phone-telnyx-reconcile" : "phone-reconcile", {
                          id: a.id,
                          confirm: true,
                          provider_checked: true,
                          outcome: "sent",
                          provider_sid: receipt,
                        })
                      }
                    >
                      Verify submitted receipt
                    </button>{" "}
                    {state?.phone?.provider !== "telnyx" && <button
                      type="button"
                      onClick={() => {
                        if (
                          window.confirm(
                            "Confirm that you checked the carrier account and this action was NOT submitted. A fresh approval will be required before any retry."
                          )
                        )
                          void act("phone-reconcile", {
                            id: a.id,
                            provider_checked: true,
                            outcome: "not_sent",
                          });
                      }}
                    >
                      Confirmed not submitted
                    </button>}
                  </p>
                ))}
            </fieldset>
          )}
          <ul>
            {phoneCost && <li role="status">{phoneCost}</li>}
            {actions.map((a) => (
              <li key={a.id}>
                {a.kind} to {a.recipient}: {a.status}{" "}
                {a.managed_price_version && a.managed_reserved_credits !== undefined && <span> · maximum charge: {a.managed_reserved_credits} credits under rate schedule {a.managed_price_version}</span>}{" "}
                {state?.phone?.provider === "telnyx" && a.cost_collection_status && <span> · carrier cost: {a.cost_collection_status}</span>}{" "}
                {a.managed_charge_credits !== null && a.managed_charge_credits !== undefined && <span> · plan charge: {a.managed_charge_credits} credits</span>}{" "}
                {state?.phone?.provider === "telnyx" && a.kind === "sms" && a.status === "sent" && <button type="button" disabled={busy} onClick={() => void act("phone-telnyx-cost", { id: a.id, confirm: true })}>Check carrier cost</button>}{" "}
                {(state?.phone?.provider ?? "twilio") === "twilio" && ["sms", "call"].includes(a.kind) && a.status === "sent" && <button type="button" disabled={busy} onClick={() => void act("phone-twilio-cost", { id: a.id, confirm: true })}>Check provider cost</button>}{" "}
                {a.status === "draft" && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      const managed = state?.phone?.provider === "telnyx" && state.phone.payer === "managed";
                      if (managed && (a.managed_reserved_credits === undefined || !a.managed_price_version)) return;
                      if (!managed || window.confirm(`Approve this SMS with a maximum charge of ${a.managed_reserved_credits} credits under managed Telnyx rate schedule ${a.managed_price_version}?`))
                        void act(state?.phone?.provider === "telnyx" ? "phone-telnyx-approve" : "phone-approve", {
                          id: a.id,
                          ...(state?.phone?.provider === "telnyx" ? { confirm: true } : {}),
                          ...(managed ? { confirmed_price_version: a.managed_price_version, confirmed_max_charge_credits: a.managed_reserved_credits } : {}),
                        });
                    }}
                  >
                    Approve
                  </button>
                )}{" "}
                {a.status === "approved" && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void act(state?.phone?.provider === "telnyx" ? "phone-telnyx-send" : "phone-send", { id: a.id, ...(state?.phone?.provider === "telnyx" ? { confirm: true } : {}) })}
                  >
                    Send approved action
                  </button>
                )}{" "}
                {["sending", "indeterminate"].includes(a.status) && (
                  <span>
                    {" "}
                    Check the carrier before retrying; this action is held for
                    reconciliation.
                  </span>
                )}
              </li>
            ))}
          </ul>
          {actionsCursor && <button type="button" disabled={busy || historyLoading !== null} onClick={() => void loadOlderHistory("actions")}>
            {historyLoading === "actions" ? "Loading older actions…" : "Load older actions"}
          </button>}
          <h5>Incoming calls, messages and receipts</h5>
          <ul>
            {events.map((e) => (
              <li key={e.id}>
                {e.kind} {e.sender}: {e.status}{" "}
                <button
                  type="button"
                  onClick={() => void act("phone-event", { id: e.id })}
                >
                  Read
                </button>
              </li>
            ))}
          </ul>
          {eventsCursor && <button type="button" disabled={busy || historyLoading !== null} onClick={() => void loadOlderHistory("events")}>
            {historyLoading === "events" ? "Loading older events…" : "Load older events"}
          </button>}
          {content && <pre style={{ whiteSpace: "pre-wrap" }}>{content}</pre>}
        </>
      )}
    </section>
  );
}
