"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { isAuthenticated, getUser, logout } from "@/lib/account";

// The BusinessDO/ProductDO backend this page used to onboard/monitor/pause a Whop business
// against was retired (legacy Whop-niche runtime, superseded by SpaceDO + NaelaoAgentDO + the
// script engine) — see the BusinessDO retirement. This route is kept alive (rather than deleted
// outright) purely so existing links (login's post-auth redirect, the catalog page's CTA) don't
// 404 — apps/shell is the real, current product experience; migrating this app's own legacy
// account/login system onto it is a separate, larger effort than this page's own retirement.
export default function LaunchPage() {
  const router = useRouter();
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    if (!isAuthenticated()) router.replace("/login");
  }, [router]);

  const user = getUser();

  async function handleSignOut() {
    setSigningOut(true);
    setSignOutError(null);
    try {
      await logout();
      router.replace("/login");
    } catch (error) {
      setSignOutError(error instanceof Error ? error.message : "Could not sign out. Try again.");
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <main className="min-h-screen bg-gray-50 px-4 py-10">
      <div className="max-w-lg mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-xl font-bold text-gray-900">Naelao</h1>
          <button onClick={() => void handleSignOut()} disabled={signingOut} className="text-sm text-gray-500 hover:text-gray-700 disabled:opacity-50">{signingOut ? "Signing out…" : "Sign out"}</button>
        </div>
        {signOutError && <p role="alert" className="mb-4 text-sm text-red-700">{signOutError}</p>}
        {user?.email && <p className="text-sm text-gray-500 mb-6">{user.email}</p>}
        <div className="bg-white border border-gray-200 rounded-xl p-5">
          <p className="text-sm text-gray-600">
            This experience has moved. Reach out to your Naelao contact for access to your product.
          </p>
        </div>
      </div>
    </main>
  );
}
