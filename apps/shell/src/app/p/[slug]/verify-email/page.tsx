"use client";


// This page lets a new user verify account ownership before signing in. It is reachable two ways:
// (1) the emailed link, when
// PRODUCT_SHELL_URL is configured server-side, carries ?token= and this auto-verifies on load;
// (2) either from the shell's "Verify now" banner or a stale/manually-typed token, a paste-in
// form covers the case where no link was ever sent. Deliberately NOT gated behind
// isAuthenticated — a person may open the emailed link on a different device/browser than the
// one they signed up on, and /end-users/verify-email itself is a public, token-based endpoint.

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Button, FormInput } from "@naelao/ui";
import { useProduct } from "@/lib/product-context";
import { useProductAuth, useSessionCredentials } from "@/lib/auth-provider";
import { verifyEmail, resendVerification } from "@/lib/productAccount";
import { getMe } from "@/lib/api";

type Status = "checking-token" | "idle" | "verifying" | "verified" | "error";

export default function VerifyEmailPage() {
  const product = useProduct();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isHydrated, isAuthenticated } = useProductAuth();
  const urlToken = searchParams.get("token");

  const [status, setStatus] = React.useState<Status>(urlToken ? "checking-token" : "idle");
  const [message, setMessage] = React.useState<string | null>(null);
  const [manualToken, setManualToken] = React.useState("");
  const [resendEmail, setResendEmail] = React.useState("");
  const [knownEmail, setKnownEmail] = React.useState<string | null>(null);
  const [resendSent, setResendSent] = React.useState(false);

  const creds = useSessionCredentials();

  // If already signed in, pre-fill the resend email from the account's own profile — no need to
  // ask a signed-in user to retype the address they already gave at signup.
  React.useEffect(() => {
    if (!creds) return;
    getMe(product.space_id, creds).then((me) => {
      if (me.email) setKnownEmail(me.email);
    }).catch(() => {});
  }, [creds, product.space_id]);

  // Live-reported bug: landing here (from the layout banner's "Verify now" button, or a stale
  // bookmark — anything without ?token=) showed a passive "check your email" message with a
  // SEPARATE "Resend" button below it — someone who never noticed the original signup email (or
  // whose mail client buried a bare token string with no clickable link, before
  // PRODUCT_SHELL_URL was actually configured — see that var's own comment) had to realize a
  // second explicit click was needed, which several real users didn't. Landing here with a known
  // account and no token IS the request for a fresh email — fire it once automatically rather
  // than making that a second, easy-to-miss step. Guarded so this can't double-fire on React 18
  // StrictMode's dev-mode double-invoke (the same pattern this codebase already uses for "don't
  // bill/send twice" effects).
  const autoResendFiredRef = React.useRef(false);
  React.useEffect(() => {
    if (urlToken || !knownEmail || autoResendFiredRef.current) return;
    autoResendFiredRef.current = true;
    resendVerification(product.space_id, knownEmail).catch(() => {}).finally(() => setResendSent(true));
  }, [urlToken, knownEmail, product.space_id]);

  const runVerify = React.useCallback(async (token: string) => {
    setStatus("verifying");
    setMessage(null);
    try {
      await verifyEmail(product.space_id, token);
      setStatus("verified");
    } catch (err) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : "This verification link is invalid or has expired");
    }
  }, [product.space_id]);

  React.useEffect(() => {
    if (urlToken) runVerify(urlToken);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlToken]);

  async function handleManualSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!manualToken.trim()) return;
    await runVerify(manualToken.trim());
  }

  async function handleResend(e: React.FormEvent) {
    e.preventDefault();
    const target = knownEmail ?? resendEmail;
    if (!target) return;
    setResendSent(false);
    try {
      await resendVerification(product.space_id, target);
    } catch {
      // The endpoint never reveals whether the send actually succeeded (constant response by
      // design) — show the same confirmation regardless, matching that contract.
    } finally {
      setResendSent(true);
    }
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        background: "var(--bg)",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 400,
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          padding: 28,
          boxShadow: "var(--shadow-md)",
        }}
      >
        <h1
          style={{
            fontFamily: "'Instrument Serif',serif",
            fontSize: 22,
            marginBottom: 4,
            color: product.brand_color ?? "var(--text)",
          }}
        >
          Verify your email
        </h1>

        {(status === "checking-token" || status === "verifying") && (
          <p style={{ color: "var(--text2)", fontSize: 13, marginTop: 12 }}>Verifying…</p>
        )}

        {status === "verified" && (
          <div>
            <p style={{ color: "var(--text2)", fontSize: 13, marginTop: 12, marginBottom: 20 }}>
              Your email is verified. Your free starting credits are now available.
            </p>
            {isHydrated && isAuthenticated ? (
              <Button onClick={() => router.replace(`/p/${product.slug}`)}>Continue to {product.product_name}</Button>
            ) : (
              <Link href={`/p/${product.slug}/login`} style={{ color: "var(--accent)", fontSize: 13 }}>
                Sign in to continue →
              </Link>
            )}
          </div>
        )}

        {status === "error" && (
          <div>
            <p style={{ color: "#dc2626", fontSize: 12.5, marginTop: 12, marginBottom: 16 }}>{message}</p>
            <ManualAndResendForms
              manualToken={manualToken}
              setManualToken={setManualToken}
              onManualSubmit={handleManualSubmit}
              knownEmail={knownEmail}
              resendEmail={resendEmail}
              setResendEmail={setResendEmail}
              onResend={handleResend}
              resendSent={resendSent}
            />
          </div>
        )}

        {status === "idle" && (
          <div>
            <p style={{ color: "var(--text2)", fontSize: 13, marginTop: 12, marginBottom: 16 }}>
              {knownEmail
                ? `We sent a verification link to ${knownEmail}. Click it, or paste the token below.`
                : "Check your email for a verification link, or paste the token below."}
            </p>
            <ManualAndResendForms
              manualToken={manualToken}
              setManualToken={setManualToken}
              onManualSubmit={handleManualSubmit}
              knownEmail={knownEmail}
              resendEmail={resendEmail}
              setResendEmail={setResendEmail}
              onResend={handleResend}
              resendSent={resendSent}
            />
          </div>
        )}

        {isHydrated && isAuthenticated && status !== "verified" && (
          <p style={{ marginTop: 20, fontSize: 12.5, color: "var(--text3)", textAlign: "center" }}>
            <Link href={`/p/${product.slug}`} style={{ color: "var(--accent)" }}>
              Skip for now
            </Link>
          </p>
        )}
      </div>
    </div>
  );
}

function ManualAndResendForms(props: {
  manualToken: string;
  setManualToken: (v: string) => void;
  onManualSubmit: (e: React.FormEvent) => void;
  knownEmail: string | null;
  resendEmail: string;
  setResendEmail: (v: string) => void;
  onResend: (e: React.FormEvent) => void;
  resendSent: boolean;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <form onSubmit={props.onManualSubmit} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <FormInput
          type="text"
          placeholder="Paste verification token"
          value={props.manualToken}
          onChange={(e) => props.setManualToken(e.target.value)}
        />
        <Button type="submit" disabled={!props.manualToken.trim()}>
          Verify
        </Button>
      </form>

      <form onSubmit={props.onResend} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {!props.knownEmail && (
          <FormInput
            type="email"
            placeholder="Your email"
            value={props.resendEmail}
            onChange={(e) => props.setResendEmail(e.target.value)}
          />
        )}
        <Button type="submit" variant="secondary" disabled={!props.knownEmail && !props.resendEmail}>
          Resend verification email
        </Button>
        {props.resendSent && (
          <p style={{ color: "var(--text2)", fontSize: 12, textAlign: "center" }}>
            If that account exists and isn&apos;t yet verified, a new link is on its way.
          </p>
        )}
      </form>
    </div>
  );
}
