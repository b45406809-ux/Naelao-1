"use client";

export const runtime = "edge";

// G-P-AUTH: Magic link authentication landing page.
// Reads ?token= from the URL, verifies it, stores the auth token, and redirects.

import { useEffect, useState } from "react";
import { useParams, useSearchParams, useRouter } from "next/navigation";
import { requestMagicLink, verifyMagicLink } from "@/lib/api";
import { getStrings } from "@/lib/i18n";

const AUTH_TOKEN_KEY = "naelao_auth_token";
const AUTH_USER_KEY = "naelao_auth_user_id";

function storeAuthToken(token: string, userId: string): void {
  try {
    localStorage.setItem(AUTH_TOKEN_KEY, token);
    localStorage.setItem(AUTH_USER_KEY, userId);
  } catch { /* ignore */ }
}

type Phase = "request" | "sent" | "verifying" | "success" | "error";

export default function AuthPage() {
  const params = useParams<{ spaceId: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();
  const t = getStrings();

  const token = searchParams.get("token");
  const [phase, setPhase] = useState<Phase>(token ? "verifying" : "request");
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  // Auto-verify if token present in URL
  useEffect(() => {
    if (!token) return;

    async function verify() {
      setPhase("verifying");
      try {
        const res = await verifyMagicLink(params.spaceId, token!);
        storeAuthToken(res.auth_token, res.end_user_id);
        setPhase("success");
        setTimeout(() => {
          router.replace(`/${params.spaceId}`);
        }, 1500);
      } catch {
        setPhase("error");
      }
    }
    void verify();
  }, [token, params.spaceId, router]);

  async function handleRequest() {
    if (!email.trim()) return;
    setSending(true);
    setErrorMsg("");
    try {
      await requestMagicLink(params.spaceId, email.trim());
      setPhase("sent");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to send link.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="max-w-sm w-full">
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8">
          <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center mb-6 mx-auto">
            <svg className="w-5 h-5 text-white" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
              <path fillRule="evenodd" d="M18 10c0 3.866-3.582 7-8 7a8.841 8.841 0 01-4.083-.98L2 17l1.338-3.123C2.493 12.767 2 11.434 2 10c0-3.866 3.582-7 8-7s8 3.134 8 7zM7 9H5v2h2V9zm8 0h-2v2h2V9zM9 9h2v2H9V9z" clipRule="evenodd" />
            </svg>
          </div>

          {phase === "verifying" && (
            <div className="text-center">
              <div className="inline-flex items-center gap-2 text-gray-500">
                <svg className="animate-spin w-5 h-5 text-indigo-500" fill="none" viewBox="0 0 24 24" aria-hidden="true">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                </svg>
                <span className="text-sm font-medium">{t.verifying}</span>
              </div>
            </div>
          )}

          {phase === "success" && (
            <div className="text-center">
              <div className="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-3">
                <svg className="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <p className="text-sm font-medium text-gray-900">{t.authSuccess}</p>
            </div>
          )}

          {phase === "error" && (
            <div className="text-center">
              <div className="w-12 h-12 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-3">
                <svg className="w-6 h-6 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </div>
              <p className="text-sm text-gray-700 mb-4">{t.authError}</p>
              <button onClick={() => setPhase("request")} className="text-sm text-indigo-600 hover:underline">
                {t.sendMagicLink}
              </button>
            </div>
          )}

          {phase === "request" && (
            <>
              <h1 className="text-lg font-semibold text-gray-900 mb-1 text-center">{t.signInWithEmail}</h1>
              <p className="text-sm text-gray-500 mb-6 text-center">We&apos;ll send you a sign-in link.</p>
              <label className="block text-sm font-medium text-gray-700 mb-1">{t.emailLabel}</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void handleRequest(); }}
                placeholder="you@example.com"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-1 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              {errorMsg && <p className="text-xs text-red-600 mb-2">{errorMsg}</p>}
              <button
                onClick={() => void handleRequest()}
                disabled={sending || !email.trim()}
                className="w-full mt-3 py-2.5 bg-indigo-600 text-white text-sm font-semibold rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors"
              >
                {sending ? "Sending…" : t.sendMagicLink}
              </button>
            </>
          )}

          {phase === "sent" && (
            <div className="text-center">
              <div className="w-12 h-12 bg-indigo-100 rounded-full flex items-center justify-center mx-auto mb-3">
                <svg className="w-6 h-6 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
              </div>
              <h2 className="text-base font-semibold text-gray-900 mb-2">{t.checkYourEmail}</h2>
              <p className="text-sm text-gray-500">{t.magicLinkSent} <strong>{email}</strong></p>
            </div>
          )}
        </div>
        <p className="text-xs text-gray-400 text-center mt-4">{t.poweredBy}</p>
      </div>
    </div>
  );
}
