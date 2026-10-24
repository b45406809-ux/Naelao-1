"use client";
import * as React from "react";
import { Button, FormInput, FormSelect } from "@naelao/ui";
import {
  assistantMailApi,
  listProjects,
  listWebsiteConnections,
  createWebsiteConnection,
  disconnectWebsite,
  websiteBrowser,
  type WebsiteConnection,
  type Project,
  type SessionCredentials,
} from "@/lib/api";
import type {
  BrowserObservation,
  BrowserScopedAction,
} from "@naelao/agent-sdk";
export function WebsiteConnections({
  spaceId,
  session,
}: { spaceId: string; session: SessionCredentials }) {
  const [items, setItems] = React.useState<WebsiteConnection[]>([]),
    [projects, setProjects] = React.useState<Project[]>([]);
  const [name, setName] = React.useState(""),
    [url, setUrl] = React.useState(""),
    [project, setProject] = React.useState(""),
    [origins, setOrigins] = React.useState(""),
    [agents, setAgents] = React.useState("");
  const [error, setError] = React.useState(""),
    [busy, setBusy] = React.useState(false),
    [active, setActive] = React.useState<{
      id: string;
      session_id: string;
    } | null>(null);
  const [observation, setObservation] =
      React.useState<BrowserObservation | null>(null),
    [image, setImage] = React.useState(""),
    [field, setField] = React.useState(""),
    [value, setValue] = React.useState("");
  const [recording, setRecording] = React.useState(false),
    [recorded, setRecorded] = React.useState<Array<Record<string, unknown>>>(
      []
    ),
    [skillName, setSkillName] = React.useState("");
  const generation = React.useRef(0);
  const refresh = React.useCallback(async () => {
    try {
      setItems(await listWebsiteConnections(spaceId, session));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load websites");
    }
  }, [spaceId, session]);
  React.useEffect(() => {
    generation.current++;
    setActive(null);
    setRecording(false);
    setRecorded([]);
    setObservation(null);
    setImage("");
    setValue("");
    setItems([]);
    void refresh();
    void listProjects(spaceId, session)
      .then(setProjects)
      .catch(() => setProjects([]));
    return () => {
      generation.current++;
    };
  }, [spaceId, session, refresh]);
  async function operate(
    connection: { id: string; session_id: string },
    operation: string,
    action?: BrowserScopedAction
  ) {
    const version = generation.current;
    const demonstrated =
      recording && action?.handle
        ? observation?.elements.find((e) => e.handle === action.handle)
        : undefined;
    setBusy(true);
    setError("");
    try {
      const result = await websiteBrowser(spaceId, session, {
        ...connection,
        operation,
        ...(action ? { action } : {}),
      });
      if (version !== generation.current) return;
      if (operation === "act" && action && demonstrated && recording) {
        if (action.type === "scroll") {
          /* scrolling is re-observed, not stored as a brittle coordinate */
        } else if (
          (action.type === "type" || action.type === "select") &&
          /password|passcode|one.?time|otp|verification|security.?code|recovery.?code/i.test(
            demonstrated.name
          )
        ) {
          setRecording(false);
          setError(
            "Recording paused: credentials and verification codes must not become skill steps."
          );
        } else
          setRecorded((previous) =>
            previous.length >= 31
              ? previous
              : [
                  ...previous,
                  {
                    type: action.type,
                    target: {
                      role: demonstrated.role,
                      name: demonstrated.name,
                    },
                    ...(action.type === "type" || action.type === "select"
                      ? { parameter: "input_" + previous.length }
                      : {}),
                  },
                ]
          );
      }
      if (operation === "close") {
        setRecording(false);
        setActive(null);
        setObservation(null);
        setImage("");
        return;
      }
      if (result.result) {
        setObservation(result.result);
        setField("");
        setValue("");
        const shot = await websiteBrowser(spaceId, session, {
          ...connection,
          operation: "see",
        });
        if (version === generation.current)
          setImage(
            shot.image_base64
              ? "data:image/png;base64," + shot.image_base64
              : ""
          );
      }
    } catch (e) {
      if (version === generation.current)
        setError(
          e instanceof Error
            ? e.message
            : "Browser operation failed. Refresh the page before retrying."
        );
    } finally {
      if (version === generation.current) setBusy(false);
    }
  }
  async function start(item: WebsiteConnection) {
    const next = { id: item.id, session_id: crypto.randomUUID() };
    setRecording(false);
    setRecorded([]);
    setActive(next);
    setObservation(null);
    setImage("");
    await operate(next, "navigate");
  }
  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await createWebsiteConnection(spaceId, session, {
        name,
        start_url: url,
        ...(project ? { project_id: project } : {}),
        origins: origins
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
        agent_ids: agents
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
      });
      setName("");
      setUrl("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not connect website");
    } finally {
      setBusy(false);
    }
  }
  async function saveDemonstration() {
    if (!active || !observation) return;
    const expected = observation.elements.find(
      (e) => e.handle === field && e.enabled
    );
    if (!expected) {
      setError(
        "Select the control that proves the workflow finished before saving."
      );
      return;
    }
    const connection = items.find((item) => item.id === active.id);
    setBusy(true);
    setError("");
    try {
      await assistantMailApi(
        spaceId,
        session,
        {
          action: "learning-draft",
          ...(connection?.project_id
            ? { projectId: connection.project_id }
            : {}),
          name: skillName,
          description:
            "Workflow demonstrated through the private website browser",
          steps: [
            ...recorded,
            {
              type: "assert",
              target: { role: expected.role, name: expected.name },
            },
          ],
        },
        true
      );
      setRecording(false);
      setRecorded([]);
      setSkillName("");
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not save the demonstration"
      );
    } finally {
      setBusy(false);
    }
  }
  const selected = observation?.elements.find((e) => e.handle === field);
  return (
    <section
      style={{
        border: "1px solid var(--border)",
        borderRadius: 12,
        padding: 16,
        marginBottom: 20,
      }}
    >
      <h3>Website accounts</h3>
      <p>
        Sign in through the assistant’s browser. Your saved login can be reused
        without an API key. Accounts remain private to you and the selected
        assistant workspace.
      </p>
      {items.map((item) => (
        <div
          key={item.id}
          style={{
            display: "flex",
            gap: 10,
            alignItems: "center",
            marginBottom: 8,
          }}
        >
          <strong>{item.name}</strong>
          <span>
            {item.project_id
              ? (projects.find((p) => p.id === item.project_id)?.name ??
                "Project")
              : "Space assistant"}
          </span>
          <Button disabled={busy || !!active} onClick={() => void start(item)}>
            Sign in / reconnect
          </Button>
          <Button
            disabled={busy || !!active}
            onClick={() =>
              void disconnectWebsite(spaceId, session, item.id)
                .then(refresh)
                .catch((e) => setError(String(e.message)))
            }
          >
            Disconnect
          </Button>
          <code title="Use this connection ID in an assistant task">
            {item.id}
          </code>
        </div>
      ))}
      {!active && (
        <form onSubmit={create} style={{ display: "grid", gap: 8 }}>
          <FormInput
            aria-label="Website account name"
            placeholder="Account name"
            required
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <FormInput
            aria-label="Website address"
            type="url"
            placeholder="https://website.com/login"
            required
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <FormSelect
            aria-label="Assistant workspace"
            value={project}
            onChange={(e) => setProject(e.target.value)}
          >
            <option value="">Space assistant</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </FormSelect>
          <details>
            <summary>Access settings</summary>
            <p>
              Additional HTTPS origins allow sign-in redirects and website
              assets. Only approve domains you trust.
            </p>
            <FormInput
              aria-label="Additional origins"
              placeholder="https://accounts.example.com, https://cdn.example.com"
              value={origins}
              onChange={(e) => setOrigins(e.target.value)}
            />
            <p>
              Limit access to assistant IDs, or leave empty to allow workers
              acting for you in this workspace.
            </p>
            <FormInput
              aria-label="Allowed assistant IDs"
              placeholder="Optional assistant IDs, separated by commas"
              value={agents}
              onChange={(e) => setAgents(e.target.value)}
            />
          </details>
          <Button type="submit" disabled={busy}>
            Add website
          </Button>
        </form>
      )}
      {active && (
        <div>
          <p>
            Complete sign-in here, then choose Done. Enter passwords and
            verification codes only in this panel. If the page expires while you
            verify, refresh to observe its current state.
          </p>
          <fieldset disabled={busy}>
            <legend>Teach a reusable workflow</legend>
            <p>
              Sign in first, then record a workflow using test data. Recorded
              inputs become named parameters; passwords, codes and screenshots
              are not saved as skill steps. Unsaved recordings stay in this tab.
            </p>
            <Button
              disabled={!observation || recorded.length > 0}
              onClick={() => {
                setRecorded([{ type: "navigate" }]);
                setRecording(true);
              }}
            >
              Start recording
            </Button>
            {recorded.length > 0 && (
              <>
                <Button onClick={() => setRecording(!recording)}>
                  {recording ? "Pause recording" : "Resume recording"}
                </Button>
                <Button
                  onClick={() => {
                    setRecording(false);
                    setRecorded([]);
                  }}
                >
                  Discard recording
                </Button>
                <p>
                  {recorded.length} steps. Select the final expected website
                  control, then save a draft. A real test and explicit
                  enablement are required before reuse.
                </p>
                <FormInput
                  aria-label="Demonstration skill name"
                  value={skillName}
                  onChange={(e) => setSkillName(e.target.value)}
                  placeholder="my-workflow"
                />
                <Button
                  disabled={!field || !skillName}
                  onClick={() => void saveDemonstration()}
                >
                  Save skill draft
                </Button>
              </>
            )}
          </fieldset>
          {image && (
            <img
              src={image}
              alt="Current website in your private assistant browser"
              style={{ width: "100%", maxHeight: 500, objectFit: "contain" }}
            />
          )}
          <div style={{ display: "flex", gap: 8, marginBlock: 8 }}>
            <Button
              disabled={busy}
              onClick={() => void operate(active, "observe")}
            >
              Refresh
            </Button>
            <Button
              disabled={busy || !observation}
              onClick={() =>
                observation &&
                void operate(active, "act", {
                  actionId: crypto.randomUUID(),
                  observationRevision: observation.revision,
                  type: "scroll",
                  y: -600,
                })
              }
            >
              Scroll up
            </Button>
            <Button
              disabled={busy || !observation}
              onClick={() =>
                observation &&
                void operate(active, "act", {
                  actionId: crypto.randomUUID(),
                  observationRevision: observation.revision,
                  type: "scroll",
                  y: 600,
                })
              }
            >
              Scroll down
            </Button>
            <Button
              disabled={busy}
              onClick={() => void operate(active, "close")}
            >
              Done — save and close
            </Button>
          </div>
          {observation && (
            <>
              <p>
                {observation.title} · {observation.url}
              </p>
              <FormSelect
                aria-label="Website control"
                value={field}
                onChange={(e) => {
                  setField(e.target.value);
                  setValue("");
                }}
              >
                <option value="">Choose a website control</option>
                {observation.elements
                  .filter((e) => e.enabled)
                  .map((e) => (
                    <option key={e.handle} value={e.handle}>
                      {e.name || "Unnamed control"} ({e.role})
                    </option>
                  ))}
              </FormSelect>
              {selected?.permittedActions.some(
                (a) => a === "type" || a === "select"
              ) && (
                <FormInput
                  type="password"
                  autoComplete="off"
                  aria-label="Value for selected website field"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                />
              )}
              <Button
                disabled={busy || !selected}
                onClick={() => {
                  if (!selected) return;
                  const type = selected.permittedActions.includes("type")
                    ? "type"
                    : selected.permittedActions.includes("select")
                      ? "select"
                      : "click";
                  void operate(active, "act", {
                    actionId: crypto.randomUUID(),
                    observationRevision: observation.revision,
                    type,
                    handle: selected.handle,
                    ...(type === "type"
                      ? { text: value }
                      : type === "select"
                        ? { value }
                        : {}),
                  });
                  setValue("");
                }}
              >
                Apply
              </Button>
            </>
          )}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
