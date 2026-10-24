"use client";
import * as React from "react";
import { Button, FormSelect } from "@naelao/ui";
import {
  ASSISTANT_CHANNELS,
  resolveAssistantChannels,
  type AssistantChannelPreferences,
} from "@naelao/agent-sdk";
import {
  getAssistantChannels,
  saveAssistantChannels,
  listProjects,
  type SessionCredentials,
  type AssistantChannelSettings,
  type Project,
} from "@/lib/api";
export function AssistantChannelsPanel({
  spaceId,
  session,
  canManage = false,
  onboarding = false,
}: {
  spaceId: string;
  session: SessionCredentials;
  canManage?: boolean;
  onboarding?: boolean;
}) {
  const [target, setTarget] = React.useState("space"),
    [settings, setSettings] = React.useState<AssistantChannelSettings | null>(
      null
    ),
    [projects, setProjects] = React.useState<Project[]>([]),
    [error, setError] = React.useState(""),
    [busy, setBusy] = React.useState(false);
  const scope = React.useMemo(
    () =>
      target === "project-defaults"
        ? { projectDefaults: true }
        : target.startsWith("project:")
          ? { projectId: target.slice(8) }
          : {},
    [target]
  );
  const template = target === "template-space" || target === "template-project";
  const preferences = settings
    ? template
      ? resolveAssistantChannels(
          target === "template-space" ? "space_assistant" : "project_assistant",
          settings.templateDefaults[
            target === "template-space" ? "spaceAssistant" : "projectAssistants"
          ]
        )
      : settings.preferences
    : null;
  React.useEffect(() => {
    let live = true;
    setSettings(null);
    getAssistantChannels(spaceId, session, scope)
      .then((s) => {
        if (live) setSettings(s);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [spaceId, session, scope]);
  React.useEffect(() => {
    void listProjects(spaceId, session)
      .then(setProjects)
      .catch(() => setProjects([]));
  }, [spaceId, session]);
  async function save(next: AssistantChannelPreferences | undefined) {
    setBusy(true);
    setError("");
    try {
      const preferences = next ?? {};
      setSettings(
        await saveAssistantChannels(
          spaceId,
          session,
          template
            ? {
                templateDefaults: {
                  ...settings?.templateDefaults,
                  [target === "template-space"
                    ? "spaceAssistant"
                    : "projectAssistants"]: preferences,
                },
              }
            : { preferences },
          scope
        )
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save channels");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-section">
      <h3>{onboarding ? "Your assistants’ channels" : "Assistant channels"}</h3>
      <p>
        Email is included for Space and Project assistants unless disabled.
        Phone is optional and supports calls and messaging; a number is
        purchased only after you accept its quote.
      </p>
      <FormSelect
        aria-label="Assistant channel scope"
        value={target}
        onChange={(e) => setTarget(e.target.value)}
      >
        <option value="space">My Space assistant</option>
        {canManage && (
          <option value="project-defaults">
            Defaults for Project assistants
          </option>
        )}
        {projects.map((p) => (
          <option key={p.id} value={"project:" + p.id}>
            {p.name} assistant
          </option>
        ))}
        {canManage && (
          <>
            <option value="template-space">
              Exported template: Space assistant defaults
            </option>
            <option value="template-project">
              Exported template: Project assistant defaults
            </option>
          </>
        )}
      </FormSelect>
      {preferences && (
        <>
          <div
            style={{
              display: "flex",
              gap: 12,
              flexWrap: "wrap",
              marginBlock: 12,
            }}
          >
            {ASSISTANT_CHANNELS.filter(
              (ch) => !onboarding || ch === "email" || ch === "phone"
            ).map((channel) => (
              <label key={channel}>
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={preferences.enabled[channel]}
                  onChange={(e) =>
                    void save({
                      ...preferences,
                      enabled: {
                        ...preferences.enabled,
                        [channel]: e.target.checked,
                      },
                    })
                  }
                />
                {channel === "phone" ? "Phone: calls, SMS and MMS" : channel}
              </label>
            ))}
          </div>
          <label>
            Phone onboarding prompt
            <FormSelect
              aria-label="Phone onboarding prompt"
              disabled={busy}
              value={preferences.phonePrompt}
              onChange={(e) =>
                void save({
                  ...preferences,
                  phonePrompt: e.target
                    .value as AssistantChannelPreferences["phonePrompt"],
                })
              }
            >
              <option value="optional">Optional</option>
              <option value="recommended">Recommended by template</option>
              <option value="required">
                Required for this template’s phone workflows
              </option>
            </FormSelect>
          </label>
          <p>
            Enabling a channel makes it available. Connected accounts and phone
            numbers still need setup. Changing these preferences does not
            release existing numbers.
          </p>
          <Button
            disabled={busy}
            variant="secondary"
            onClick={() => void save(undefined)}
          >
            Use inherited defaults
          </Button>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
