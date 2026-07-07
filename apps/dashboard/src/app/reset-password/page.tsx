"use client";

// Launch-readiness audit follow-up: builders had no account-recovery path at all. Reachable two
// ways: (1) the emailed reset link, when BUILDER_DASHBOARD_URL is configured server-side, carries
// ?token= and lands directly on the "set a new password" form; (2) from the login page's "Forgot
// password?" link, with no token — shows a "request a reset email" form instead. Deliberately not
// gated behind auth — a forgotten password means there's no session to gate behind.

import { useState, FormEvent, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { requestPasswordReset, resetPassword } from "@/lib/api";

function ResetPasswordInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token");

  const [email, setEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [requestSent, setRequestSent] = useState(false);
  const [resetDone, setResetDone] = useState(false);

  async function handleRequest(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await requestPasswordReset(email);
      setRequestSent(true);
    } catch (err) {
      // The endpoint never reveals whether the send actually succeeded (constant response by
      // design) — show the same confirmation regardless, matching that contract.
      setRequestSent(true);
    } finally {
      setLoading(false);
    }
  }

  async function handleReset(e: FormEvent) {
    e.preventDefault();
    if (!token) return;
    setError(null);
    setLoading(true);
    try {
      await resetPassword(token, newPassword);
      setResetDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "This reset link is invalid or has expired");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-brand-50 to-brand-100 flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-brand-600 mb-4">
            <span className="text-white text-2xl font-bold">N</span>
          </div>
          <h1 className="text-3xl font-bold text-gray-900">Reset your password</h1>
        </div>

        <div className="bg-white rounded-2xl shadow-lg overflow-hidden p-8">
          {token ? (
            resetDone ? (
              <div className="space-y-4">
                <p className="text-sm text-gray-600">Your password has been updated.</p>
                <button
                  type="button"
                  onClick={() => router.replace("/login")}
                  className="w-full py-2.5 px-4 bg-brand-600 hover:bg-brand-700 text-white font-semibold rounded-lg transition"
                >
                  Sign in
                </button>
              </div>
            ) : (
              <form onSubmit={handleReset} className="space-y-5">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">New password</label>
                  <input
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    required
                    autoComplete="new-password"
                    minLength={8}
                    placeholder="At least 8 characters"
                    className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition"
                  />
                </div>
                {error && (
                  <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>
                )}
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full py-2.5 px-4 bg-brand-600 hover:bg-brand-700 disabled:bg-brand-300 text-white font-semibold rounded-lg transition"
                >
                  {loading ? "Resetting..." : "Reset password"}
                </button>
              </form>
            )
          ) : requestSent ? (
            <p className="text-sm text-gray-600">
              If an account with that email exists, a reset link has been sent.
            </p>
          ) : (
            <form onSubmit={handleRequest} className="space-y-5">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Email address</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                  placeholder="you@example.com"
                  className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition"
                />
              </div>
              <button
                type="submit"
                disabled={loading}
                className="w-full py-2.5 px-4 bg-brand-600 hover:bg-brand-700 disabled:bg-brand-300 text-white font-semibold rounded-lg transition"
              >
                {loading ? "Sending..." : "Send reset link"}
              </button>
            </form>
          )}

          <p className="mt-6 text-center text-sm text-gray-500">
            <Link href="/login" className="text-brand-600 hover:text-brand-700">
              Back to sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetPasswordInner />
    </Suspense>
  );
}
