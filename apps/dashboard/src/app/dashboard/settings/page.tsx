"use client";

import { getMyPreferences, updateMyPreferences } from "@/lib/api";
import { useAuth } from "@/lib/auth-provider";
import Link from "next/link";
import { useEffect, useState } from "react";

// G-BE40: Settings — subscription info, org info. API key management lives on its own page
// (/dashboard/api-keys) — this page used to embed a second, simpler API-key UI pointed at a
// route (/settings/api-keys) that no worker ever implemented; consolidated onto the one real
// UI (scopes + expiry) instead of maintaining two dead call sites.

function SectionCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white rounded-xl border border-gray-200">
      <div className="px-6 py-4 border-b border-gray-200">
        <h2 className="font-semibold text-gray-900">{title}</h2>
      </div>
      <div className="p-6">{children}</div>
    </div>
  );
}

export default function SettingsPage() {
  const { claims } = useAuth();

  const [language, setLanguage] = useState("");
  const [languageLoading, setLanguageLoading] = useState(true);
  const [languageSaving, setLanguageSaving] = useState(false);
  const [languageMessage, setLanguageMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getMyPreferences().then((preferences) => {
      if (active) setLanguage(preferences.preferred_language ?? "");
    }).catch((err: unknown) => {
      if (active) setLanguageMessage(err instanceof Error ? err.message : "Could not load language preference.");
    }).finally(() => { if (active) setLanguageLoading(false); });
    return () => { active = false; };
  }, []);

  async function saveLanguagePreference() {
    setLanguageSaving(true);
    setLanguageMessage(null);
    try {
      await updateMyPreferences({ preferred_language: language.trim() || null });
      setLanguageMessage("Language preference saved.");
    } catch (err) {
      setLanguageMessage(err instanceof Error ? err.message : "Could not save language preference.");
    } finally { setLanguageSaving(false); }
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
        <p className="text-gray-500 mt-1">
          Manage your account preferences and API access
        </p>
      </div>

      {/* Org Info */}
      <SectionCard title="Organization">
        <div className="space-y-3">
          <div>
            <p className="text-sm text-gray-500">Organization ID</p>
            <p className="font-medium text-gray-900 mt-0.5">
              {claims?.tid ?? "—"}
            </p>
          </div>
          <div>
            <p className="text-sm text-gray-500">Account Email</p>
            <p className="font-medium text-gray-900 mt-0.5">
              {claims?.email ?? "—"}
            </p>
          </div>
          <div>
            <p className="text-sm text-gray-500">Role</p>
            <p className="font-medium text-gray-900 capitalize mt-0.5">
              {claims?.role ?? "—"}
            </p>
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Language preference">
        <p className="text-sm text-gray-500 mb-3">
          Choose a BCP-47 language tag such as en, fr-CA, or sw-KE. Leave blank to follow each message.
        </p>
        <div className="flex items-center gap-3">
          <input
            aria-label="Preferred response language"
            className="border border-gray-300 rounded-md px-3 py-2 text-sm"
            value={language}
            onChange={(event) => setLanguage(event.target.value)}
            placeholder="en"
            disabled={languageLoading || languageSaving}
          />
          <button
            type="button"
            onClick={() => void saveLanguagePreference()}
            disabled={languageLoading || languageSaving}
            className="px-4 py-2 bg-brand-600 hover:bg-brand-700 disabled:bg-brand-300 text-white text-sm font-semibold rounded-lg"
          >
            {languageSaving ? "Saving..." : "Save"}
          </button>
        </div>
        {languageMessage && <output className="text-sm text-gray-500 mt-2">{languageMessage}</output>}
      </SectionCard>

      {/* API Keys */}
      <SectionCard title="API Keys">
        <p className="text-sm text-gray-500 mb-4">
          Scoped programmatic access to the Naelao API.
        </p>
        <Link
          href="/dashboard/api-keys"
          className="inline-flex items-center gap-2 px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white text-sm font-semibold rounded-lg transition-colors"
        >
          Manage API Keys
        </Link>
      </SectionCard>
    </div>
  );
}
