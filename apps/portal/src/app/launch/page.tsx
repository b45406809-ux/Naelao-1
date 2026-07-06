"use client";

import { useEffect } from "react";
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

  useEffect(() => {
    if (!isAuthenticated()) router.replace("/login");
  }, [router]);

  const user = getUser();

  return (
    <main className="min-h-screen bg-gray-50 px-4 py-10">
      <div className="max-w-lg mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-xl font-bold text-gray-900">Naelao</h1>
          <button onClick={() => { logout(); router.replace("/login"); }} className="text-sm text-gray-500 hover:text-gray-700">Sign out</button>
        </div>
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
