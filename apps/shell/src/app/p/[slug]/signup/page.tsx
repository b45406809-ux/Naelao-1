"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button, FormInput } from "@naelao/ui";
import { useProduct } from "@/lib/product-context";
import { useProductAuth } from "@/lib/auth-provider";
import { signUp } from "@/lib/productAccount";

export default function SignupPage() {
  const product = useProduct();
  const { setSession, isHydrated, isAuthenticated } = useProductAuth();
  const router = useRouter();
  const [displayName, setDisplayName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(() => {
    if (isHydrated && isAuthenticated) router.replace(`/p/${product.slug}`);
  }, [isHydrated, isAuthenticated, product.slug, router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const session = await signUp(product.space_id, email, password, displayName || undefined);
      setSession(session);
      router.replace(`/p/${product.slug}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign up failed");
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
        <p style={{ color: "var(--text2)", fontSize: 13, marginBottom: 20 }}>Create your account</p>

        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <FormInput
            type="text"
            placeholder="Name (optional)"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
          <FormInput
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <FormInput
            type="password"
            placeholder="Password (min 8 characters)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={8}
            required
          />
          {error && <div style={{ color: "#dc2626", fontSize: 12.5 }}>{error}</div>}
          <Button type="submit" disabled={submitting}>
            {submitting ? "Creating account…" : "Create account"}
          </Button>
        </form>

        <p style={{ marginTop: 16, fontSize: 12.5, color: "var(--text3)", textAlign: "center" }}>
          Already have an account?{" "}
          <Link href={`/p/${product.slug}/login`} style={{ color: "var(--accent)" }}>
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
