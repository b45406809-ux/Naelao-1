"use client";

import * as React from "react";
import type { SessionCredentials, CustomerVoiceNumber } from "@/lib/api";
import { disableCustomerVoiceNumber, importCustomerVoiceNumber, listCustomerVoiceNumbers, releaseCustomerVoiceNumber, saveCustomerVoiceCredentials } from "@/lib/api";
import { SettingsSection } from "@/components/SettingsSection";

function usd(minor: number) { return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(minor / 100); }

export function CustomerTelephonySettings({ spaceId, session, canEdit }: { spaceId: string; session: SessionCredentials; canEdit: boolean }) {
  const [numbers, setNumbers] = React.useState<CustomerVoiceNumber[]>([]);
  const [accountSid, setAccountSid] = React.useState("");
  const [authToken, setAuthToken] = React.useState("");
  const [numberSid, setNumberSid] = React.useState("");
  const [agentId, setAgentId] = React.useState("");
  const [ownerPrompt, setOwnerPrompt] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState("");
  const [error, setError] = React.useState("");

  const refresh = React.useCallback(async () => {
    const result = await listCustomerVoiceNumbers(spaceId, session);
    setNumbers(result.numbers);
  }, [spaceId, session]);
  React.useEffect(() => { if (canEdit) void refresh().catch((e) => setError(e instanceof Error ? e.message : "Could not load phone numbers")); }, [canEdit, refresh]);

  async function act(fn: () => Promise<unknown>, done: string) {
    setBusy(true); setError(""); setNotice("");
    try { await fn(); await refresh(); setNotice(done); }
    catch (e) { setError(e instanceof Error ? e.message : "Telephony request failed"); }
    finally { setBusy(false); }
  }

  return <SettingsSection title="Customer phone numbers" desc="Connect an existing Twilio voice number to a customer agent. Twilio credentials stay in the encrypted credential vault. Number rental and call charges are billed by Twilio; the quotes shown are provider quotes, not Naelao charges.">
    {!canEdit && <p style={{ fontSize: 12.5, color: "var(--text3)" }}>Only this Space’s owner or an admin can manage customer phone numbers.</p>}
    {canEdit && <>
      <div style={{ display: "grid", gap: 8, marginBottom: 14 }}>
        <strong style={{ fontSize: 12.5 }}>Connect Twilio</strong>
        <input aria-label="Twilio Account SID" placeholder="Account SID (AC…)" value={accountSid} onChange={(e) => setAccountSid(e.target.value)} autoComplete="off" />
        <input aria-label="Twilio Auth Token" placeholder="Auth Token" type="password" value={authToken} onChange={(e) => setAuthToken(e.target.value)} autoComplete="new-password" />
        <button type="button" disabled={busy || !accountSid || !authToken} onClick={() => void act(async () => { await saveCustomerVoiceCredentials(spaceId, session, accountSid, authToken); setAuthToken(""); }, "Twilio credentials verified and saved")}>Verify and save credentials</button>
      </div>
      <div style={{ display: "grid", gap: 8, marginBottom: 18 }}>
        <strong style={{ fontSize: 12.5 }}>Import a number already in your Twilio account</strong>
        <input aria-label="Twilio phone number SID" placeholder="Phone Number SID (PN…)" value={numberSid} onChange={(e) => setNumberSid(e.target.value)} autoComplete="off" />
        <input aria-label="Customer agent ID" placeholder="Customer agent ID" value={agentId} onChange={(e) => setAgentId(e.target.value)} />
        <textarea aria-label="Customer voice instructions" placeholder="Instructions for this customer voice agent (optional)" maxLength={8000} value={ownerPrompt} onChange={(e) => setOwnerPrompt(e.target.value)} rows={3} />
        <button type="button" disabled={busy || !numberSid || !agentId} onClick={() => void act(async () => { await importCustomerVoiceNumber(spaceId, session, { phone_number_sid: numberSid, agent_id: agentId, owner_prompt: ownerPrompt }); setNumberSid(""); }, "Number imported and callbacks configured")}>Import and configure callbacks</button>
        <small style={{ color: "var(--text3)" }}>Import verifies ownership, voice capability, and USD recurring/minute quotes before updating Twilio callbacks. It does not buy a number.</small>
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        <strong style={{ fontSize: 12.5 }}>Configured numbers</strong>
        {numbers.length === 0 ? <p style={{ fontSize: 12, color: "var(--text3)" }}>No customer numbers are configured.</p> : numbers.map((number) => <div key={number.id} style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 8, borderTop: "1px solid var(--border)", paddingTop: 8 }}>
          <span style={{ fontSize: 12.5 }}>{number.phone_number} · {number.status} · {usd(number.monthly_cost_minor)}/month + {usd(number.inbound_price_per_minute_minor)}/minute</span>
          <span style={{ display: "flex", gap: 6 }}>
            {number.status === "active" && <button type="button" disabled={busy} onClick={() => void act(() => disableCustomerVoiceNumber(spaceId, session, number.id), "Number disabled; prior Twilio callbacks restored")}>Disable</button>}
            {(number.status === "active" || number.status === "disabled") && <button type="button" disabled={busy} onClick={() => { if (window.confirm(`Release ${number.phone_number} from Twilio? This permanently releases the provider number.`)) void act(() => releaseCustomerVoiceNumber(spaceId, session, number.id), "Number released from Twilio"); }}>Release number</button>}
          </span>
        </div>)}
      </div>
    </>}
    {error && <p role="alert" style={{ color: "var(--danger, #b42318)", fontSize: 12 }}>{error}</p>}
    {notice && <p role="status" style={{ color: "var(--success, #067647)", fontSize: 12 }}>{notice}</p>}
  </SettingsSection>;
}
