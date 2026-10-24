"use client";


// First-run business setup — the end user's own path into the template bootstrap that, until now,
// only the builder dashboard could reach. Finishing it is what makes a business actually start:
// the template's project presets get stamped, its setup scripts run, and the assistant introduces
// itself on the channel chosen here with a real first plan.
//
// One question per screen, deliberately. The audience is someone who has never configured
// software; a single form with six fields (two of which are OAuth redirects) reads as work, where
// one question with one obvious action reads as progress. Every answer is saved to the server as
// the user advances — not batched to the end — because connecting an app is a real browser
// navigation away from this page, and anything held only in React state would be gone on return.

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import { Button, Badge, FormInput, FormTextarea, useToast, Toast } from "@naelao/ui";
import { AssistantChannelsPanel } from "@/components/AssistantChannelsPanel";
import { useProduct } from "@/lib/product-context";
import { useProductAuth } from "@/lib/auth-provider";
import { useActiveSpace } from "@/lib/active-space-context";
import {
  getOnboarding,
  listMyBusinesses,
  saveOnboarding,
  completeOnboarding,
  startOAuthConnect,
  startProviderConnect,
  connectPlatform,
  ApiError,
  type OnboardingState,
  type OnboardingPrompt,
} from "@/lib/api";

/** Channels that work the moment they're picked, vs. ones that need their own connection first.
 *  Saying so up front beats letting someone choose Slack and then wonder why nothing arrives. */
const CHANNEL_LABELS: Record<string, { label: string; note: string }> = {
  email: { label: "Email", note: "Works right away" },
  slack: { label: "Slack", note: "Needs connecting after setup" },
  discord: { label: "Discord", note: "Needs connecting after setup" },
  whatsapp: { label: "WhatsApp", note: "Needs connecting after setup" },
};

export default function BusinessOnboardingPage() {
  const params = useParams<{ slug: string; businessId: string }>();
  const router = useRouter();
  const product = useProduct();
  const { session } = useProductAuth();
  const { setActiveSpace } = useActiveSpace();
  const { toast, show } = useToast();

  const [state, setState] = React.useState<OnboardingState | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [stepIndex, setStepIndex] = React.useState(0);
  const [answers, setAnswers] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);
  const [manualKey, setManualKey] = React.useState("");
  const [showManualKey, setShowManualKey] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [finished, setFinished] = React.useState<{ projects: string[]; firstContact: boolean } | null>(null);
  const [provisioning, setProvisioning] = React.useState(false);

  const creds = session ? { sessionToken: session.session_token, endUserId: session.end_user_id } : null;

  // Being walked through setting up one business while the sidebar names a different one is
  // disorienting — arriving here makes this business the active one, matching what the switcher
  // would do if you'd picked it yourself.
  React.useEffect(() => {
    if (!creds) return;
    void listMyBusinesses(product.space_id, creds)
      .then((all) => {
        const mine = all.find((b) => b.id === params.businessId);
        if (mine) setActiveSpace(mine.id, mine.name);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.businessId, session, product.space_id]);

  const refresh = React.useCallback(async () => {
    if (!creds) return null;
    const next = await getOnboarding(params.businessId, creds);
    setState(next);
    setAnswers((prev) => {
      const seeded: Record<string, string> = { ...prev };
      for (const p of next.prompts) {
        if (typeof p.answer === "string" && seeded[p.id] === undefined) seeded[p.id] = p.answer;
      }
      return seeded;
    });
    return next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.businessId, session]);

  // On load, resume at the first unanswered question rather than restarting from the top — a user
  // coming back from an OAuth redirect (or a closed tab) should never have to re-answer.
  //
  // A business is created before provisioning finishes, so arriving here straight from the create
  // dialog can legitimately find an empty onboarding record. Polling while the space isn't active
  // yet is the honest read of that; showing "nothing to configure" would be a lie that skips the
  // user past their own setup.
  React.useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function load() {
      try {
        const next = await refresh();
        if (cancelled || !next) return;
        if (next.space_status !== "active" && next.prompts.length === 0) {
          setProvisioning(true);
          timer = setTimeout(load, 2500);
          return;
        }
        setProvisioning(false);
        if (next.status === "complete") {
          setFinished({ projects: next.projects_created, firstContact: false });
          return;
        }
        const steps = buildSteps(next);
        const firstUnsatisfied = steps.findIndex((s) => !s.prompt.satisfied);
        setStepIndex(firstUnsatisfied === -1 ? steps.length : firstUnsatisfied);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Couldn't load setup");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [refresh]);

  // Land back here after a connector's OAuth redirect: clear the marker so a reload doesn't
  // re-toast, and re-read state so the just-connected step shows as satisfied.
  React.useEffect(() => {
    const url = new URLSearchParams(window.location.search);
    let touched = false;
    for (const key of Array.from(url.keys())) {
      if (key.endsWith("_connected")) {
        show("Connected.");
        url.delete(key);
        touched = true;
      } else if (key.endsWith("_oauth_error")) {
        setError(`Connection failed: ${url.get(key)}`);
        url.delete(key);
        touched = true;
      }
    }
    if (!touched) return;
    window.history.replaceState({}, "", `${window.location.pathname}${url.toString() ? `?${url}` : ""}`);
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const steps = React.useMemo(() => (state ? buildSteps(state) : []), [state]);
  const step = steps[stepIndex];
  const templateName = state?.templates[0]?.name ?? "your business";

  function setAnswer(id: string, value: string) {
    setAnswers((prev) => ({ ...prev, [id]: value }));
    setError(null);
  }

  /** Persist and move on. Saving here (rather than at the end) is what makes the OAuth redirect
   *  and a closed tab both survivable. */
  async function advance() {
    if (!creds || !step) return;
    setBusy(true);
    setError(null);
    try {
      const value = answers[step.prompt.id];
      if (value !== undefined && step.prompt.type !== "connection" && step.prompt.type !== "credential") {
        await saveOnboarding(params.businessId, creds, { [step.prompt.id]: value });
      }
      setStepIndex((i) => i + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save that");
    } finally {
      setBusy(false);
    }
  }

  async function handleConnect(connector: string) {
    if (!creds) return;
    setBusy(true);
    setError(null);
    try {
      // Save anything typed so far before the browser leaves this page entirely.
      if (Object.keys(answers).length > 0) await saveOnboarding(params.businessId, creds, answers);
      if (step?.prompt.connect_method === "composio") {
        const { connect_url } = await startProviderConnect(params.businessId, creds, connector, window.location.href);
        window.location.href = connect_url;
      } else {
        const { authorize_url } = await startOAuthConnect(params.businessId, creds, connector, window.location.href);
        window.location.href = authorize_url;
      }
    } catch (err) {
      // If provider configuration changed after the wizard loaded, present the manual path when
      // the connector allows one rather than exposing a deployment configuration error.
      if (err instanceof ApiError && (err.errorCode === "oauth_not_configured" || err.errorCode === "provider_not_configured")) {
        setShowManualKey(true);
        setError("One-click connect isn't available — paste an API key instead.");
      } else {
        setError(err instanceof Error ? err.message : "Couldn't start the connection");
      }
      setBusy(false);
    }
  }

  async function handleManualKey(connector: string) {
    if (!creds || !manualKey.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await connectPlatform(params.businessId, creds, connector, manualKey.trim());
      setManualKey("");
      setShowManualKey(false);
      const next = await refresh();
      // Only advance if it really registered — a key that failed to vault must not look like success.
      if (next?.prompts.find((p) => p.id === step?.prompt.id)?.satisfied) setStepIndex((i) => i + 1);
      else setError("That key didn't connect. Double-check it and try again.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't connect with that key");
    } finally {
      setBusy(false);
    }
  }

  async function handleFinish() {
    if (!creds) return;
    setBusy(true);
    setError(null);
    try {
      const result = await completeOnboarding(params.businessId, creds, answers);
      setFinished({ projects: result.projects_created ?? [], firstContact: result.first_contact_sent });
    } catch (err) {
      if (err instanceof ApiError && err.errorCode === "onboarding_incomplete") {
        // The server is the authority on what's still missing — jump back to the first gap rather
        // than showing a dead end.
        const next = await refresh();
        const rebuilt = next ? buildSteps(next) : [];
        const gap = rebuilt.findIndex((s) => !s.prompt.satisfied);
        if (gap !== -1) setStepIndex(gap);
        setError("A couple of things still need answering.");
      } else {
        setError(err instanceof Error ? err.message : "Couldn't finish setup");
      }
    } finally {
      setBusy(false);
    }
  }

  if (!session) return null;

  if (loading || provisioning) {
    return (
      <div className="page-view" style={{ maxWidth: 620 }}>
        {creds && <AssistantChannelsPanel spaceId={params.businessId} session={creds} onboarding />}
        <div className="page-title">{provisioning ? "Building your business…" : "Loading setup…"}</div>
        {provisioning && (
          <p style={{ fontSize: 13.5, color: "var(--text2)", marginTop: 10, lineHeight: 1.55 }}>
            We&rsquo;re creating your workspaces and installing your agents. This usually takes a few
            seconds — the setup questions will appear here as soon as it&rsquo;s ready.
          </p>
        )}
      </div>
    );
  }

  if (finished) {
    const channel = answers["owner_channel"] ?? "your chosen channel";
    return (
      <div className="page-view" style={{ maxWidth: 620 }}>
        {creds && <AssistantChannelsPanel spaceId={params.businessId} session={creds} onboarding />}
        <div className="page-title">You&rsquo;re set up 🎉</div>
        <p style={{ fontSize: 14, color: "var(--text2)", marginTop: 8 }}>
          {templateName} is configured and your assistant has taken over from here.
        </p>
        {finished.projects.length > 0 && (
          <p style={{ fontSize: 13, color: "var(--text3)", marginTop: 12 }}>
            Workspaces ready: {finished.projects.join(", ")}.
          </p>
        )}
        {finished.firstContact && (
          <p style={{ fontSize: 13, color: "var(--text2)", marginTop: 12 }}>
            It&rsquo;s reading your account now and will message you on <strong>{channel}</strong> with what it
            found and what it proposes doing first. Anything that needs your say-so will come to you
            as a request, not a surprise.
          </p>
        )}
        <div style={{ display: "flex", gap: 8, marginTop: 24 }}>
          <Button onClick={() => router.push(`/p/${params.slug}`)}>Open my business</Button>
          <Button variant="secondary" onClick={() => router.push(`/p/${params.slug}/spaces/${params.businessId}`)}>
            Business settings
          </Button>
        </div>
        <Toast toast={toast} />
      </div>
    );
  }

  // Past the last question — the review/confirm screen.
  if (!step) {
    return (
      <div className="page-view" style={{ maxWidth: 620 }}>
        {creds && <AssistantChannelsPanel spaceId={params.businessId} session={creds} onboarding />}
        <div className="page-title">Ready to go</div>
        <p style={{ fontSize: 14, color: "var(--text2)", marginTop: 8 }}>
          That&rsquo;s everything. Finishing setup hands {templateName} to your assistant: it will read
          your connected account, set up your workspaces, and get in touch with a first plan.
        </p>
        <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 10 }}>
          {steps.map((s, i) => (
            <button
              key={s.prompt.id}
              type="button"
              onClick={() => setStepIndex(i)}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 12,
                padding: "10px 12px",
                borderRadius: 8,
                border: "1px solid var(--border)",
                background: "transparent",
                cursor: "pointer",
                textAlign: "left",
                fontSize: 13,
                color: "var(--text1)",
              }}
            >
              <span>{s.prompt.question}</span>
              <span style={{ color: "var(--text3)", fontSize: 12, whiteSpace: "nowrap" }}>
                {summarize(s.prompt, answers)}
              </span>
            </button>
          ))}
        </div>
        {error && (
          <p role="alert" style={{ fontSize: 12.5, color: "#dc2626", marginTop: 16 }}>
            {error}
          </p>
        )}
        <div style={{ display: "flex", gap: 8, marginTop: 24 }}>
          <Button variant="secondary" onClick={() => setStepIndex(steps.length - 1)} disabled={busy}>
            Back
          </Button>
          <Button onClick={handleFinish} disabled={busy}>
            {busy ? "Setting up…" : "Finish setup"}
          </Button>
        </div>
        <Toast toast={toast} />
      </div>
    );
  }

  const prompt = step.prompt;
  const canContinue = prompt.satisfied || !prompt.required || Boolean(answers[prompt.id]?.trim());

  return (
    <div className="page-view" style={{ maxWidth: 620 }}>
        {creds && <AssistantChannelsPanel spaceId={params.businessId} session={creds} onboarding />}
      <div style={{ fontSize: 12, color: "var(--text3)", letterSpacing: 0.3, textTransform: "uppercase" }}>
        Set up {templateName} · {stepIndex + 1} of {steps.length}
      </div>
      <div
        aria-hidden
        style={{ height: 3, borderRadius: 2, background: "var(--border)", margin: "10px 0 24px", overflow: "hidden" }}
      >
        <div style={{ height: "100%", width: `${(stepIndex / steps.length) * 100}%`, background: "var(--accent, #5b52f0)" }} />
      </div>

      <h1 style={{ fontSize: 21, fontWeight: 650, margin: 0 }}>{prompt.question}</h1>
      {prompt.help && (
        <p style={{ fontSize: 13.5, color: "var(--text2)", marginTop: 10, lineHeight: 1.55 }}>{prompt.help}</p>
      )}

      <div style={{ marginTop: 22 }}>
        {prompt.type === "connection" && prompt.connector && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {prompt.satisfied ? (
              <Badge color="green">Connected</Badge>
            ) : (
              <>
                {prompt.connection_available !== false ? (
                  <div>
                    <Button onClick={() => handleConnect(prompt.connector!)} disabled={busy}>
                      {busy ? "Opening…" : `Connect ${titleCase(prompt.connector)}`}
                    </Button>
                  </div>
                ) : (
                  <p style={{ fontSize: 12.5, color: "var(--text3)", margin: 0 }}>
                    Hosted connect is not configured here. You can use a connector key if this app supports one.
                  </p>
                )}
                {step.fallback && (
                  <div>
                    <button
                      type="button"
                      onClick={() => setShowManualKey((v) => !v)}
                      style={{ background: "none", border: "none", padding: 0, color: "var(--accent)", fontSize: 12.5, cursor: "pointer" }}
                    >
                      {step.fallback.question}
                    </button>
                    {(showManualKey || (prompt.connection_available === false && prompt.connect_method !== "composio")) && (
                      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                        <FormInput
                          placeholder="API key"
                          value={manualKey}
                          onChange={(e) => setManualKey(e.target.value)}
                          type="password"
                        />
                        <Button variant="secondary" onClick={() => handleManualKey(prompt.connector!)} disabled={busy || !manualKey.trim()}>
                          Use key
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {prompt.type === "channel" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {(prompt.options ?? []).map((opt) => (
              <OptionRow
                key={opt}
                selected={answers[prompt.id] === opt}
                onSelect={() => setAnswer(prompt.id, opt)}
                label={CHANNEL_LABELS[opt]?.label ?? titleCase(opt)}
                {...(CHANNEL_LABELS[opt]?.note ? { note: CHANNEL_LABELS[opt]!.note } : {})}
              />
            ))}
          </div>
        )}

        {prompt.type === "choice" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {(prompt.options ?? []).map((opt) => (
              <OptionRow key={opt} selected={answers[prompt.id] === opt} onSelect={() => setAnswer(prompt.id, opt)} label={opt} />
            ))}
          </div>
        )}

        {prompt.type === "text" && (
          <FormTextarea rows={3} value={answers[prompt.id] ?? ""} onChange={(e) => setAnswer(prompt.id, e.target.value)} />
        )}

        {prompt.type === "boolean" && (
          <div style={{ display: "flex", gap: 8 }}>
            {["Yes", "No"].map((opt) => (
              <OptionRow key={opt} selected={answers[prompt.id] === opt} onSelect={() => setAnswer(prompt.id, opt)} label={opt} />
            ))}
          </div>
        )}
      </div>

      {error && (
        <p role="alert" style={{ fontSize: 12.5, color: "#dc2626", marginTop: 16 }}>
          {error}
        </p>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 26 }}>
        {stepIndex > 0 && (
          <Button variant="secondary" onClick={() => setStepIndex((i) => i - 1)} disabled={busy}>
            Back
          </Button>
        )}
        <Button onClick={advance} disabled={busy || !canContinue}>
          {busy ? "Saving…" : "Continue"}
        </Button>
        {!prompt.required && !prompt.satisfied && (
          <button
            type="button"
            onClick={() => setStepIndex((i) => i + 1)}
            disabled={busy}
            style={{ background: "none", border: "none", color: "var(--text3)", fontSize: 12.5, cursor: "pointer" }}
          >
            Skip
          </button>
        )}
      </div>
      <Toast toast={toast} />
    </div>
  );
}

interface WizardStep {
  prompt: OnboardingPrompt;
  /** An optional credential prompt for the same connector, folded into the connection step as the
   *  "paste a key instead" escape hatch rather than shown as its own confusing extra question. */
  fallback?: OnboardingPrompt;
}

function buildSteps(state: OnboardingState): WizardStep[] {
  const connectorsWithConnection = new Set(
    state.prompts.filter((p) => p.type === "connection" && p.connector).map((p) => p.connector!)
  );
  const steps: WizardStep[] = [];
  for (const p of state.prompts) {
    // A credential prompt whose connector already has a real connect button is the fallback for
    // that button, not a separate step.
    if (p.type === "credential" && p.connector && connectorsWithConnection.has(p.connector)) continue;
    const fallback =
      p.type === "connection" && p.connector
        ? state.prompts.find((q) => q.type === "credential" && q.connector === p.connector)
        : undefined;
    steps.push(fallback ? { prompt: p, fallback } : { prompt: p });
  }
  return steps;
}

function summarize(prompt: OnboardingPrompt, answers: Record<string, string>): string {
  if (prompt.type === "connection" || prompt.type === "credential") return prompt.satisfied ? "Connected" : "Not connected";
  const value = answers[prompt.id];
  if (!value) return "Skipped";
  return value.length > 34 ? `${value.slice(0, 34)}…` : value;
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function OptionRow({
  selected,
  onSelect,
  label,
  note,
}: {
  selected: boolean;
  onSelect: () => void;
  label: string;
  note?: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        width: "100%",
        padding: "12px 14px",
        borderRadius: 10,
        border: `1px solid ${selected ? "var(--accent, #5b52f0)" : "var(--border)"}`,
        background: selected ? "var(--accent-soft, #eef2ff)" : "transparent",
        cursor: "pointer",
        textAlign: "left",
        fontSize: 13.5,
        color: "var(--text1)",
        lineHeight: 1.4,
      }}
    >
      <span>{label}</span>
      {note && <span style={{ fontSize: 11.5, color: "var(--text3)", whiteSpace: "nowrap" }}>{note}</span>}
    </button>
  );
}
