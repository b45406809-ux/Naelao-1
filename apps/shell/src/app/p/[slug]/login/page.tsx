"use client";

export const runtime = "edge";

import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button, FormInput } from "@naelao/ui";
import { useProduct } from "@/lib/product-context";
import { useProductAuth } from "@/lib/auth-provider";
import { logIn } from "@/lib/productAccount";

export default function LoginPage() {
  const product = useProduct();
  const { setSession, isHydrated, isAuthenticated } = useProductAuth();
  const router = useRouter();
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
      const session = await logIn(product.space_id, email, password);
      setSession(session);
      router.replace(`/p/${product.slug}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed");
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

        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <FormInput
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <FormInput
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          {error && <div style={{ color: "#dc2626", fontSize: 12.5 }}>{error}</div>}
          <Button type="submit" disabled={submitting}>
            {submitting ? "Signing in…" : "Sign in"}
          </Button>
        </form>

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
