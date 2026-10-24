"use client";
import * as React from "react";
import { assistantMailApi, type SessionCredentials } from "@/lib/api";
type Channel =
  | "voice"
  | "web_push"
  | "whatsapp"
  | "telegram"
  | "email"
  | "phone";
interface Policy {
  channels: Channel[];
  timezone: string;
  quietStart: number;
  quietEnd: number;
  allowUrgentDuringQuiet: boolean;
  allowPhone: boolean;
  dailyLimit: number;
}
const channels: Channel[] = [
  "voice",
  "web_push",
  "whatsapp",
  "telegram",
  "email",
  "phone",
];
const labels: Record<Channel, string> = {
  voice: "Current call",
  web_push: "App notification",
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  email: "Email",
  phone: "Phone call",
};
const clock = (n: number) =>
  `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
const minutes = (value: string) => {
  const [h, m] = value.split(":").map(Number);
  return h! * 60 + m!;
};
export function AssistantDeliveryPanel({
  spaceId,
  projectId,
  session,
}: { spaceId: string; projectId?: string; session: SessionCredentials }) {
  const [policy, setPolicy] = React.useState<Policy | null>(null),
    [error, setError] = React.useState(""),
    [busy, setBusy] = React.useState(false),
    [saved, setSaved] = React.useState(false);
  const generation = React.useRef(0);
  const call = React.useCallback(
    <T,>(action: string, extra: Record<string, unknown> = {}, write = false) =>
      assistantMailApi<T>(
        spaceId,
        session,
        { action, ...(projectId ? { projectId } : {}), ...extra },
        write
      ),
    [spaceId, projectId, session]
  );
  React.useEffect(() => {
    const g = ++generation.current;
    setPolicy(null);
    setError("");
    setSaved(false);
    setBusy(false);
    void call<{ policy: Policy }>("delivery-policy")
      .then((result) => {
        if (g === generation.current) setPolicy(result.policy);
      })
      .catch(() => {
        if (g === generation.current)
          setError("Could not load communication preferences.");
      });
    return () => {
      generation.current++;
    };
  }, [call]);
  if (!policy)
    return <p role="status">{error || "Loading communication preferences…"}</p>;
  const patch = (value: Partial<Policy>) => {
    setPolicy({ ...policy, ...value });
    setSaved(false);
  };
  async function save() {
    const g = generation.current;
    setBusy(true);
    setError("");
    try {
      await call("delivery-policy-set", { policy }, true);
      if (g === generation.current) setSaved(true);
    } catch {
      if (g === generation.current)
        setError(
          "Could not save preferences. Phone calls require assistant owner permission."
        );
    } finally {
      if (g === generation.current) setBusy(false);
    }
  }
  return (
    <fieldset
      disabled={busy}
      aria-label="Personal assistant communication preferences"
    >
      <legend>How your assistant reaches you</legend>
      <p>
        These preferences apply to you in this Space or project. Only verified
        connections can receive updates.
      </p>
      {channels.map((channel) => (
        <label key={channel} style={{ display: "block" }}>
          <input
            type="checkbox"
            checked={policy.channels.includes(channel)}
            onChange={(e) =>
              patch({
                channels: e.target.checked
                  ? [...policy.channels, channel]
                  : policy.channels.filter((c) => c !== channel),
              })
            }
          />
          {labels[channel]}
        </label>
      ))}
      <p>
        Delivery order:{" "}
        {policy.channels.map((c) => labels[c]).join(" → ") ||
          "No outgoing channels"}
        . A current call receives relevant updates without moving background
        planning into it.
      </p>
      <label>
        Timezone{" "}
        <input
          value={policy.timezone}
          onChange={(e) => patch({ timezone: e.target.value })}
        />
      </label>
      <label>
        Quiet hours start{" "}
        <input
          type="time"
          value={clock(policy.quietStart)}
          onChange={(e) =>
            e.target.value && patch({ quietStart: minutes(e.target.value) })
          }
        />
      </label>
      <label>
        Quiet hours end{" "}
        <input
          type="time"
          value={clock(policy.quietEnd)}
          onChange={(e) =>
            e.target.value && patch({ quietEnd: minutes(e.target.value) })
          }
        />
      </label>
      <p>Set the same start and end time to disable quiet hours.</p>
      <label>
        <input
          type="checkbox"
          checked={policy.allowUrgentDuringQuiet}
          onChange={(e) => patch({ allowUrgentDuringQuiet: e.target.checked })}
        />
        Allow urgent updates during quiet hours
      </label>
      <label>
        <input
          type="checkbox"
          checked={policy.allowPhone}
          onChange={(e) => patch({ allowPhone: e.target.checked })}
        />
        Allow proactive calls for updates. Carrier charges apply; this does not
        approve task actions.
      </label>
      <label>
        Maximum updates per day{" "}
        <input
          type="number"
          min={1}
          max={100}
          value={policy.dailyLimit}
          onChange={(e) => patch({ dailyLimit: Number(e.target.value) })}
        />
      </label>
      <button type="button" onClick={() => void save()}>
        Save communication preferences
      </button>
      {saved && <p role="status">Preferences saved.</p>}
      {error && <p role="alert">{error}</p>}
    </fieldset>
  );
}
