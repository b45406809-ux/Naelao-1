"use client";
import * as React from "react";
import { assistantMailApi, type SessionCredentials } from "@/lib/api";
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
};
export function AssistantPhonePanel({
  spaceId,
  projectId,
  session,
}: { spaceId: string; projectId?: string; session: SessionCredentials }) {
  const [state, setState] = React.useState<{
      phone: Phone | null;
      enabled: boolean;
      telnyx_webhook_url?: string | null;
      extension_lines?:Array<{id:string;phone_number:string|null;provider_number_sid:string|null;installation_id:string|null;handler_sha256:string|null;handler_status:string|null;status:string}>;
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
    [content, setContent] = React.useState(""),
    [transfer, setTransfer] = React.useState("");
  const [receipt, setReceipt] = React.useState("");
  const [telnyxKey, setTelnyxKey] = React.useState("");
  const [telnyxPublicKey, setTelnyxPublicKey] = React.useState("");
  const [telnyxNumberId, setTelnyxNumberId] = React.useState("");
  const [telnyxSetup, setTelnyxSetup] = React.useState("");
  const [handlerInstallation, setHandlerInstallation] = React.useState(""),
    [handlerDigest, setHandlerDigest] = React.useState("");
  const [extensionAssignments, setExtensionAssignments] = React.useState<Record<string, { installation: string; digest: string }>>({});
  const [liveCall, setLiveCall] = React.useState<{
    code: string;
    expires_at: number;
    session_id: string;
    phone_number: string;
  } | null>(null);
  const [liveSessionId, setLiveSessionId] = React.useState<
    string | undefined
  >();
  const generation = React.useRef(0);
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
    try {
      const result = await call<{
        phone: Phone | null;
        enabled: boolean;
        telnyx_webhook_url?: string | null;
        extension_lines?: Array<{
          id: string;
          phone_number: string | null;
          provider_number_sid: string | null;
          installation_id: string | null;
          handler_sha256: string | null;
          handler_status: string | null;
          status: string;
        }>;
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
          call<{ data: Row[] }>("phone-actions"),
          call<{ data: Row[] }>("phone-events"),
        ]);
        if (g !== generation.current) return;
        setActions(a.data);
        setEvents(e.data);
      }
    } catch (e) {
      if (g === generation.current)
        setError(e instanceof Error ? e.message : "Phone unavailable");
    }
  }, [call]);
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
    setSid("");
    setTo("");
    setText("");
    setContent("");
    setActions([]);
    setEvents([]);
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
      if (action === "phone-event")
        setContent(JSON.stringify(result.body, null, 2));
      if (action === "phone-live") {
        setLiveCall(
          result as unknown as {
            code: string;
            expires_at: number;
            session_id: string;
            phone_number: string;
          }
        );
        setLiveSessionId(String(result.session_id));
      }
      if (action === "phone-live-end") setLiveCall(null);
      if (action === "phone-credentials") setSecret("");
      if (["phone-telnyx-configure", "phone-telnyx-status", "phone-telnyx-remove"].includes(action)) {
        setTelnyxKey("");
        setTelnyxSetup(result.configured ? `Telnyx account verified for ${String(result.phone_number)}. Calling and messaging activation is pending.` : "No Telnyx account configured.");
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
        <fieldset key={line.id} disabled={busy || !state.enabled}>
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
        return <fieldset key={line.id} disabled={busy || !state.enabled}>
          <legend>Extension phone handler</legend>
          <p>{line.phone_number ?? "Phone number"} · {line.status} · {line.handler_status ?? "No handler assigned"}</p>
          <label>Installation ID <input value={assignment.installation} onChange={(e) => setExtensionAssignments((current) => ({ ...current, [line.id]: { ...assignment, installation: e.target.value } }))} /></label>
          <label>Handler SHA-256 <input value={assignment.digest} maxLength={64} onChange={(e) => setExtensionAssignments((current) => ({ ...current, [line.id]: { ...assignment, digest: e.target.value } }))} /></label>
          <button type="button" onClick={() => void act("phone-handler", { binding_id: line.id, installation_id: assignment.installation, handler_sha256: assignment.digest, confirm: true })}>Assign or update extension</button>{" "}
          <button type="button" onClick={() => { if (window.confirm("Detach this number and restore its prior carrier callbacks?")) void act("phone-detach", { binding_id: line.id, confirm: true }); }}>Detach number</button>
        </fieldset>;
      })}
      <p>
        {state?.phone?.phone_number ?? "No number connected"}{" "}
        {state?.phone?.status ?? ""}
        {state?.phone ? ` · ${state.phone.provider ?? "twilio"}` : ""}
      </p>
      <p>
        Phone is optional for Space and Project assistants. Enable it in
        assistant channel settings first. Your carrier bills your account directly for
        rental, calls, SMS/MMS and other carrier charges. Managed Naelao numbers
        are not available yet.
      </p>
      {error && <p role="alert">{error}</p>}
      <button type="button" disabled={busy} onClick={() => void refresh()}>
        Refresh phone
      </button>
      <details style={{ marginTop: 12 }}>
        <summary>Telnyx account preparation</summary>
        <p>Verify an existing Telnyx number and store account credentials securely. Telnyx calling and messaging are awaiting integration; your active phone provider stays in place.</p>
        <fieldset disabled={busy || !state?.enabled}>
          <legend>Verify Telnyx account</legend>
          <label>API key <input type="password" autoComplete="new-password" value={telnyxKey} onChange={event => setTelnyxKey(event.target.value)} /></label>
          <label>Webhook public key <input autoComplete="off" value={telnyxPublicKey} onChange={event => setTelnyxPublicKey(event.target.value)} /></label>
          <label>Existing number resource ID <input inputMode="numeric" autoComplete="off" value={telnyxNumberId} onChange={event => setTelnyxNumberId(event.target.value)} /></label>
          <button type="button" disabled={!telnyxKey || !telnyxPublicKey || !telnyxNumberId} onClick={() => void act("phone-telnyx-configure", { api_key: telnyxKey, public_key: telnyxPublicKey, number_id: telnyxNumberId })}>Verify and save</button>{" "}
          <button type="button" onClick={() => void act("phone-telnyx-status")}>Check setup status</button>
          {(!state?.phone || ["released", "detached"].includes(state.phone.status)) && <button type="button" onClick={() => { if (window.confirm("Prepare this number for your assistant? Calls and SMS will remain unavailable until its connection is activated.")) void act("phone-telnyx-stage", { confirm: true }); }}>Prepare assistant number</button>}
          {telnyxSetup && <p role="status">{telnyxSetup}</p>}
        </fieldset>
        {state?.phone?.provider === "telnyx" && state.phone.status === "configuring" && <button type="button" disabled={busy} onClick={() => { if (window.confirm("Cancel this unfinished number setup? Telnyx will continue to bill the number.")) void act("phone-telnyx-cancel", { confirm: true }); }}>Cancel number setup</button>}
        {state?.phone?.provider === "telnyx" && state.phone.status === "configuring" && <div>
          <p>Set the number’s Telnyx messaging profile webhook URL to <code>{state.telnyx_webhook_url ?? "unavailable: public phone endpoint is not configured"}</code> and choose API version 2. Naelao verifies these settings before enabling SMS.</p>
          <button type="button" disabled={busy || !state.telnyx_webhook_url} onClick={() => void act("phone-telnyx-activate", { confirm: true })}>Verify and enable SMS</button>
        </div>}
        {state?.phone?.provider === "telnyx" && state.phone.status === "active" && <button type="button" disabled={busy} onClick={() => { if (window.confirm("Detach this Telnyx number? Its carrier webhook and rental continue until you change them at Telnyx.")) void act("phone-telnyx-detach", { confirm: true }); }}>Detach Telnyx number</button>}
        <button type="button" disabled={busy} onClick={() => { if (window.confirm("Remove the saved Telnyx account credentials? This does not release numbers at Telnyx.")) void act("phone-telnyx-remove", { confirm: true }); }}>Remove saved Telnyx credentials</button>
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
              <fieldset disabled={busy || !state.enabled}>
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
                    onClick={() =>
                      void act("phone-live", {
                        confirm: true,
                        ...(liveSessionId ? { session_id: liveSessionId } : {}),
                      })
                    }
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
            {actions.map((a) => (
              <li key={a.id}>
                {a.kind} to {a.recipient}: {a.status}{" "}
                {a.status === "draft" && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void act(state?.phone?.provider === "telnyx" ? "phone-telnyx-approve" : "phone-approve", { id: a.id, ...(state?.phone?.provider === "telnyx" ? { confirm: true } : {}) })}
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
          {content && <pre style={{ whiteSpace: "pre-wrap" }}>{content}</pre>}
        </>
      )}
    </section>
  );
}
