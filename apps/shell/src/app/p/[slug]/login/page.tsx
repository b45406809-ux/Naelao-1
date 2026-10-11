"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useProduct } from "@/lib/product-context";
import { useProductAuth } from "@/lib/auth-provider";
import { logIn, requestWhatsAppLogin, verifyWhatsAppLogin } from "@/lib/productAccount";

export default function LoginPage() {
  const product = useProduct();
  const { setSession, isHydrated, isAuthenticated } = useProductAuth();
  const router = useRouter();
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [mode, setMode] = React.useState<"password" | "whatsapp">("password");
  const [phone, setPhone] = React.useState("");
  const [code, setCode] = React.useState("");
  const [challengeSent, setChallengeSent] = React.useState(false);

  React.useEffect(() => {
    if (isHydrated && isAuthenticated) router.replace(`/p/${product.slug}`);
  }, [isHydrated, isAuthenticated, product.slug, router]);

  React.useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("wa_token");
    if (!token || !isHydrated || isAuthenticated) return;
    setMode("whatsapp");
    setSubmitting(true);
    verifyWhatsAppLogin(product.space_id, { token })
      .then((session) => {
        setSession(session);
        router.replace(`/p/${product.slug}`);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "This sign-in link is invalid or expired"))
      .finally(() => setSubmitting(false));
  }, [isHydrated, isAuthenticated, product.space_id, product.slug, router, setSession]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const session = await logIn(product.space_id, email, password);
      setSession(session);
      router.replace(`/p/${product.slug}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleWhatsApp(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (!challengeSent) {
        await requestWhatsAppLogin(product.space_id, phone);
        setChallengeSent(true);
      } else {
        const session = await verifyWhatsAppLogin(product.space_id, { phone, code });
        setSession(session);
        router.replace(`/p/${product.slug}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "WhatsApp sign in failed");
    } finally {
      setSubmitting(false);
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
          maxWidth: 380,
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          padding: 28,
          boxShadow: "var(--shadow-md)",
        }}
      >
        {product.logo_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={product.logo_url} alt={product.product_name} style={{ height: 32, marginBottom: 16 }} />
        ) : (
          <h1
            style={{
              fontFamily: "'Instrument Serif',serif",
              fontSize: 24,
              marginBottom: 4,
              color: product.brand_color ?? "var(--text)",
            }}
          >
            {product.product_name}
          </h1>
        )}
        <p style={{ color: "var(--text2)", fontSize: 13, marginBottom: 20 }}>Sign in to continue</p>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 14, padding: 4, background: "var(--bg)", borderRadius: 10 }}>
          <button type="button" onClick={() => { setMode("password"); setError(null); }} style={{ padding: 8, border: 0, borderRadius: 7, background: mode === "password" ? "var(--surface)" : "transparent", color: "var(--text)", cursor: "pointer" }}>Password</button>
          <button type="button" onClick={() => { setMode("whatsapp"); setError(null); }} style={{ padding: 8, border: 0, borderRadius: 7, background: mode === "whatsapp" ? "var(--surface)" : "transparent", color: "var(--text)", cursor: "pointer" }}>WhatsApp</button>
        </div>

        {mode === "password" ? <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            style={{ padding: "10px 12px", border: "1px solid var(--border)", borderRadius: 8, background: "var(--surface)", color: "var(--text)" }}
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            style={{ padding: "10px 12px", border: "1px solid var(--border)", borderRadius: 8, background: "var(--surface)", color: "var(--text)" }}
          />
          {error && <div style={{ color: "#dc2626", fontSize: 12.5 }}>{error}</div>}
          <button type="submit" disabled={submitting} style={{ padding: "10px 12px", border: 0, borderRadius: 8, background: "var(--accent)", color: "white", fontWeight: 600, cursor: submitting ? "default" : "pointer" }}>
            {submitting ? "Signing in…" : "Sign in"}
          </button>
        </form> : <form onSubmit={handleWhatsApp} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <input
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="+27 82 123 4567"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            disabled={challengeSent}
            required
            style={{ padding: "10px 12px", border: "1px solid var(--border)", borderRadius: 8, background: "var(--surface)", color: "var(--text)" }}
          />
          {challengeSent && <>
            <p style={{ margin: 0, color: "var(--text2)", fontSize: 12.5 }}>Enter the 6-digit code sent on WhatsApp. You can also use the sign-in link in that message.</p>
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              placeholder="6-digit code"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              required
              style={{ padding: "10px 12px", border: "1px solid var(--border)", borderRadius: 8, background: "var(--surface)", color: "var(--text)", letterSpacing: 4 }}
            />
          </>}
          {error && <div style={{ color: "#dc2626", fontSize: 12.5 }}>{error}</div>}
          <button type="submit" disabled={submitting || (challengeSent && code.length !== 6)} style={{ padding: "10px 12px", border: 0, borderRadius: 8, background: "var(--accent)", color: "white", fontWeight: 600, cursor: submitting ? "default" : "pointer" }}>
            {submitting ? "Please wait…" : challengeSent ? "Verify and sign in" : "Send WhatsApp code"}
          </button>
          {challengeSent && <button type="button" onClick={() => { setChallengeSent(false); setCode(""); }} style={{ border: 0, background: "transparent", color: "var(--text2)", cursor: "pointer" }}>Use another number</button>}
        </form>}

        <p style={{ marginTop: 16, fontSize: 12.5, color: "var(--text3)", textAlign: "center" }}>
          Don&apos;t have an account?{" "}
          <Link href={`/p/${product.slug}/signup`} style={{ color: "var(--accent)" }}>
            Sign up
          </Link>
        </p>
      </div>
    </div>
  );
}
