"use client";

import { useState, type FormEvent } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";
const TOKEN_KEY = "naelao_token";

function safeReturnPath(value: string | null): string {
  if (!value || value.startsWith("//") || value.includes("\\")) return "/";
  try {
    const target = new URL(value, window.location.origin);
    return target.origin === window.location.origin ? `${target.pathname}${target.search}${target.hash}` : "/";
  } catch {
    return "/";
  }
}

export default function MarketplaceLoginPage() {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`${API_URL}/v1/auth/${mode}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const payload = await response.json().catch(() => null) as { data?: { token?: unknown }; token?: unknown; error?: string; message?: string } | null;
      if (!response.ok) throw new Error(payload?.message ?? payload?.error ?? `${mode === "login" ? "Sign-in" : "Registration"} failed (${response.status})`);
      const token = payload?.data?.token ?? payload?.token;
      if (typeof token !== "string" || !token) throw new Error("The authentication service did not return a session.");
      localStorage.setItem(TOKEN_KEY, token);
      const returnTo = safeReturnPath(new URLSearchParams(window.location.search).get("return_to"));
      window.location.assign(returnTo);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Sign-in is unavailable.");
      setBusy(false);
    }
  }

  return <main className="min-h-screen bg-gray-50 px-4 py-12">
    <form onSubmit={submit} className="mx-auto max-w-sm space-y-4 rounded-xl border border-gray-200 bg-white p-6">
      <div><h1 className="text-xl font-bold text-gray-900">{mode === "login" ? "Sign in to Naelao" : "Create a Naelao account"}</h1>
        <p className="mt-1 text-sm text-gray-500">Use your Naelao account to access template licensing.</p></div>
      <label className="block text-sm font-medium text-gray-700">Email
        <input autoComplete="email" type="email" required value={email} onChange={event => setEmail(event.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" />
      </label>
      <label className="block text-sm font-medium text-gray-700">Password
        <input autoComplete="current-password" type="password" required value={password} onChange={event => setPassword(event.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" />
      </label>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <button type="submit" disabled={busy} className="w-full rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">
        {busy ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
      </button>
      <button type="button" disabled={busy} onClick={() => { setMode(value => value === "login" ? "register" : "login"); setError(""); }} className="w-full text-sm text-brand-700 disabled:opacity-60">
        {mode === "login" ? "Need an account? Create one" : "Already have an account? Sign in"}
      </button>
    </form>
  </main>;
}
