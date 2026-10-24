"use client";
import * as React from "react";
import { assistantMailApi, type SessionCredentials } from "@/lib/api";
interface Phone {
  id: string;
  phone_number: string | null;
  status: string;
  payer: string;
  capabilities: Record<string, boolean>;
  policy: {
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
      const result = await call<{ phone: Phone | null; enabled: boolean }>(
        "phone-status"
      );
      if (g !== generation.current) return;
      setState(result);
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
    setAccount("");
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
      if (action === "phone-credentials") setSecret("");
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
      <p>
        {state?.phone?.phone_number ?? "No number connected"}{" "}
        {state?.phone?.status ?? ""}
      </p>
      <p>
        Phone is optional for Space and Project assistants. Enable it in
        assistant channel settings first. Twilio bills your account directly for
        rental, calls, SMS/MMS and other carrier charges. Managed Naelao numbers
        are not available yet.
      </p>
      {error && <p role="alert">{error}</p>}
      <button type="button" disabled={busy} onClick={() => void refresh()}>
        Refresh phone
      </button>
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
                    <option value="call">Call with spoken message</option>
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
          <ul>
            {actions.map((a) => (
              <li key={a.id}>
                {a.kind} to {a.recipient}: {a.status}{" "}
                {a.status === "draft" && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void act("phone-approve", { id: a.id })}
                  >
                    Approve
                  </button>
                )}{" "}
                {a.status === "approved" && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void act("phone-send", { id: a.id })}
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
