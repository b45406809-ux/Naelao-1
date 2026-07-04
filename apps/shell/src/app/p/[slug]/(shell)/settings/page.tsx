"use client";

import { useProductAuth } from "@/lib/auth-provider";

export default function SettingsPage() {
  const { session, signOut } = useProductAuth();

  return (
    <div className="page-view">
      <div className="page-header">
        <div className="page-title">Settings</div>
        <div className="page-subtitle">Members, billing, and credentials land in a later phase.</div>
      </div>
      <div className="settings-block">
        <div className="settings-row">
          <div>
            <div className="settings-row-label">Signed in as</div>
            <div className="settings-row-sub">{session?.end_user_id}</div>
          </div>
          <button className="btn btn-secondary" type="button" onClick={signOut}>
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
