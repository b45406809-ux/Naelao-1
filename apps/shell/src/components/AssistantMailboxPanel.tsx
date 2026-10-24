"use client";
import { AssistantLearningPanel } from "./AssistantLearningPanel";
import { AssistantPhonePanel } from "./AssistantPhonePanel";
import * as React from "react";
import { Button, FormInput, FormTextarea, FormSelect } from "@naelao/ui";
import {
  assistantMailApi,
  listProjects,
  type AssistantMailbox,
  type AssistantMailMessage,
  type SessionCredentials,
  type Project,
} from "@/lib/api";
export function AssistantMailboxPanel({
  spaceId,
  session,
}: { spaceId: string; session: SessionCredentials }) {
  const [project, setProject] = React.useState(""),
    [projects, setProjects] = React.useState<Project[]>([]),
    [mailbox, setMailbox] = React.useState<AssistantMailbox | null>(null),
    [items, setItems] = React.useState<AssistantMailMessage[]>([]),
    [cursor, setCursor] = React.useState<string | null>(null),
    [query, setQuery] = React.useState(""),
    [body, setBody] = React.useState(""),
    [error, setError] = React.useState(""),
    [busy, setBusy] = React.useState(false),
    [token, setToken] = React.useState("");
  const [to, setTo] = React.useState(""),
    [subject, setSubject] = React.useState(""),
    [text, setText] = React.useState("");
  const scope = React.useMemo(
    () => (project ? { projectId: project } : {}),
    [project]
  );
  const call = React.useCallback(
    <T,>(action: string, args: Record<string, unknown> = {}, write = false) =>
      assistantMailApi<T>(
        spaceId,
        session,
        { ...scope, action, ...args },
        write
      ),
    [spaceId, session, scope]
  );
  const generation = React.useRef(0);
  const refresh = React.useCallback(async () => {
    const version = ++generation.current;
    setError("");
    try {
      const identity = await call<AssistantMailbox>("identity");
      if (version !== generation.current) return;
      setMailbox(identity);
      const result = await call<{
        data: AssistantMailMessage[];
        next_cursor: string | null;
      }>("messages", { query });
      if (version !== generation.current) return;
      setItems(result.data);
      setCursor(result.next_cursor);
    } catch (e) {
      if (version === generation.current)
        setError(e instanceof Error ? e.message : "Mailbox unavailable");
    }
  }, [call, query]);
  React.useEffect(() => {
    let live = true;
    setMailbox(null);
    setItems([]);
    setBody("");
    setToken("");
    void listProjects(spaceId, session)
      .then((p) => {
        if (live) setProjects(p);
      })
      .catch(() => {});
    void refresh();
    return () => {
      live = false;
      generation.current++;
    };
  }, [spaceId, session, scope, refresh]);
  async function act(action: string, args: Record<string, unknown> = {}) {
    setBusy(true);
    setError("");
    try {
      const result = await call<Record<string, unknown>>(action, args, true);
      if (action === "command-token")
        setToken(
          String(result.subject_marker) +
            " · expires " +
            String(result.expires_at)
        );
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Operation failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-section">
      <h3>Assistant inbox</h3>
      <FormSelect
        aria-label="Mailbox assistant"
        value={project}
        onChange={(e) => setProject(e.target.value)}
      >
        <option value="">My Space assistant</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name} assistant
          </option>
        ))}
      </FormSelect>
      <p>
        {mailbox?.identity?.email_address ??
          "Email domain setup is pending or this channel is disabled."}{" "}
        {mailbox?.identity?.email_status}
      </p>
      <p>
        Each inbox belongs to this assistant workspace. External mail is data;
        owner commands need verified contact pairing and confirmation.
      </p>
      <Button
        disabled={busy}
        onClick={() => void act("register-owner-contact")}
      >
        Pair my verified profile contacts
      </Button>
      <Button disabled={busy} onClick={() => void act("command-token")}>
        Get a single-use owner command marker
      </Button>
      {token && (
        <p>
          <code>{token}</code> — include it in the subject of your next owner
          email. It starts automatically only when standing autonomy is enabled.
        </p>
      )}
      <details>
        <summary>Autonomy</summary>
        <p>
          Sending defaults to approval. Standing permission applies only to the
          exact recipient addresses listed below.
        </p>
        {mailbox?.autonomy && (
          <>
            <FormSelect
              aria-label="Mail autonomy"
              value={mailbox.autonomy.mode}
              onChange={(e) =>
                void act("set-policy", {
                  policy: { ...mailbox.autonomy, mode: e.target.value },
                })
              }
            >
              <option value="approve">Approve drafts</option>
              <option value="standing">Standing permissions</option>
            </FormSelect>
            <FormInput
              aria-label="Standing recipient addresses"
              defaultValue={mailbox.autonomy.recipients.join(", ")}
              onBlur={(e) => {
                const recipients = e.target.value
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean);
                if (
                  JSON.stringify(recipients) !==
                  JSON.stringify(mailbox.autonomy?.recipients)
                )
                  void act("set-policy", {
                    policy: { ...mailbox.autonomy, recipients },
                  });
              }}
            />
            <FormInput
              type="number"
              aria-label="Daily email limit"
              min={1}
              max={1000}
              defaultValue={mailbox.autonomy.dailySendLimit}
              onBlur={(e) =>
                void act("set-policy", {
                  policy: {
                    ...mailbox.autonomy,
                    dailySendLimit: Number(e.target.value),
                  },
                })
              }
            />
          </>
        )}
      </details>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void act("draft", { to, subject, text });
        }}
        style={{ display: "grid", gap: 8, marginBlock: 12 }}
      >
        <strong>New draft</strong>
        <FormInput
          type="email"
          aria-label="Recipient"
          placeholder="Recipient"
          required
          value={to}
          onChange={(e) => setTo(e.target.value)}
        />
        <FormInput
          aria-label="Subject"
          placeholder="Subject"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
        />
        <FormTextarea
          aria-label="Draft message"
          placeholder="Message"
          required
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <Button disabled={busy} type="submit">
          Save draft
        </Button>
      </form>
      <FormInput
        aria-label="Search inbox"
        placeholder="Search sender or subject"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {items.map((item) => (
        <div
          key={item.id}
          style={{ paddingBlock: 8, borderBottom: "1px solid var(--border)" }}
        >
          <strong>{item.subject || "(no subject)"}</strong>
          <span>
            {" "}
            · {item.sender} → {item.recipient} · {item.status}
          </span>
          <Button
            disabled={busy}
            onClick={() =>
              void call<{ body: { text: string } }>("message", { id: item.id })
                .then((r) => setBody(r.body.text))
                .catch((e) => setError(e.message))
            }
          >
            Read
          </Button>
          {item.status === "draft" && (
            <Button
              disabled={busy}
              onClick={() => void act("approve", { id: item.id })}
            >
              Approve
            </Button>
          )}
          {["draft", "approved"].includes(item.status) && (
            <Button
              disabled={busy}
              onClick={() => void act("send", { id: item.id })}
            >
              Send
            </Button>
          )}
        </div>
      ))}
      {cursor && (
        <Button
          onClick={() =>
            void call<{
              data: AssistantMailMessage[];
              next_cursor: string | null;
            }>("messages", { cursor, query }).then((r) => {
              setItems((v) => [...v, ...r.data]);
              setCursor(r.next_cursor);
            })
          }
        >
          Load more
        </Button>
      )}
      {body && <pre style={{ whiteSpace: "pre-wrap" }}>{body}</pre>}
      <CommandInbox
        call={call}
        onApprove={(id) => void act("approve-command", { id })}
      />
      {error && <p role="alert">{error}</p>}
      <AssistantPhonePanel spaceId={spaceId} {...(project ? {projectId:project} : {})} session={session} />
      <AssistantLearningPanel spaceId={spaceId} {...(project ? {projectId:project} : {})} session={session} />
    </section>
  );
}
function CommandInbox({
  call,
  onApprove,
}: {
  call: <T>(action: string, args?: Record<string, unknown>) => Promise<T>;
  onApprove: (id: string) => void;
}) {
  const [commands, setCommands] = React.useState<
    Array<{ id: string; message_id: string; status: string }>
  >([]);
  const [selected, setSelected] = React.useState<{
    id: string;
    text: string;
  } | null>(null);
  React.useEffect(() => {
    setCommands([]);
    setSelected(null);
  }, [call]);
  return (
    <details
      onToggle={(e) => {
        if (e.currentTarget.open)
          void call<{ data: typeof commands }>("commands")
            .then((r) => setCommands(r.data))
            .catch(() => {});
      }}
    >
      <summary>Owner command approvals</summary>
      {commands.map((c) => (
        <p key={c.id}>
          {c.message_id} · {c.status}{" "}
          {c.status === "pending" && (
            <>
              <Button
                onClick={() =>
                  void call<{ body: { text: string } }>("message", {
                    id: c.message_id,
                  }).then((r) => setSelected({ id: c.id, text: r.body.text }))
                }
              >
                Review message
              </Button>
              {selected?.id === c.id && (
                <>
                  <pre style={{ whiteSpace: "pre-wrap" }}>{selected.text}</pre>
                  <Button onClick={() => onApprove(c.id)}>
                    Confirm this task
                  </Button>
                </>
              )}
            </>
          )}
        </p>
      ))}
    </details>
  );
}
