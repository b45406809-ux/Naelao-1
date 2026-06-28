"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { login, register } from "@/lib/account";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "login") await login(email, password);
      else await register(email, password);
      router.replace("/launch");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-bold text-gray-900 text-center mb-1">
          {mode === "login" ? "Sign in" : "Create account"}
        </h1>
        <p className="text-sm text-gray-500 text-center mb-6">
          Run an AI micro-tool + community on Whop.
        </p>

        <form onSubmit={submit} className="space-y-3 bg-white border border-gray-200 rounded-xl p-5">
          <input
            type="email" required placeholder="Email" value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          />
          <input
            type="password" required placeholder="Password" value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          />
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button
            type="submit" disabled={busy}
            className="w-full bg-indigo-600 text-white text-sm font-semibold py-2 rounded-lg disabled:opacity-60"
          >
            {busy ? "…" : mode === "login" ? "Sign in" : "Create account"}
          </button>
        </form>

        <button
          onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(null); }}
          className="w-full text-sm text-gray-500 mt-4 hover:text-gray-700"
        >
          {mode === "login" ? "Need an account? Register" : "Have an account? Sign in"}
        </button>
      </div>
    </main>
  );
}
