"use client";
import { AssistantLearningPanel } from "./AssistantLearningPanel";
import { AssistantPhonePanel } from "./AssistantPhonePanel";
import * as React from "react";
import { Button, FormInput, FormTextarea, FormSelect } from "@naelao/ui";
import {
  assistantMailApi,
  assistantMailAttachment,
  listProjects,
  type AssistantMailbox,
  type AssistantMailAttachment,
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
    [bodyMessageId, setBodyMessageId] = React.useState(""),
    [attachments, setAttachments] = React.useState<AssistantMailAttachment[]>([]),
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
  const actionVersion = React.useRef(0);
  const pendingPages = React.useRef(new Set<string>());
  React.useEffect(() => {
    actionVersion.current++;
    setBusy(false);
    setTo("");
    setSubject("");
    setText("");
    setBody("");
    setBodyMessageId("");
    setAttachments([]);
    setToken("");
    setQuery("");
  }, [spaceId, session, project]);
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
    const version = generation.current,
      requestId = ++actionVersion.current;
    setBusy(true);
    setError("");
    try {
      const result = await call<Record<string, unknown>>(action, args, true);
      if (version !== generation.current) return;
      if (action === "command-token")
        setToken(
          String(result.subject_marker) +
            " · expires " +
            String(result.expires_at)
        );
      await refresh();
    } catch (e) {
      if (version === generation.current)
        setError(e instanceof Error ? e.message : "Operation failed");
    } finally {
      if (requestId === actionVersion.current) setBusy(false);
    }
  }
  async function readMessage(id: string) {
    const version = generation.current;
    try {
      const r = await call<{ body: { text: string; attachments?: AssistantMailAttachment[] } }>("message", { id });
      if (version === generation.current) {
        setBody(r.body.text);
        setBodyMessageId(id);
        setAttachments(Array.isArray(r.body.attachments) ? r.body.attachments : []);
      }
    } catch (e) {
      if (version === generation.current)
        setError(e instanceof Error ? e.message : "Message unavailable");
    }
  }
  async function downloadAttachment(messageId: string, attachment: AssistantMailAttachment) {
    setBusy(true);
    setError("");
    try {
      const blob = await assistantMailAttachment(spaceId, session, {
        messageId,
        attachmentId: attachment.id,
        ...(project ? { projectId: project } : {}),
      });
      const url = URL.createObjectURL(blob), link = document.createElement("a");
      link.href = url;
      link.download = attachment.filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Attachment unavailable");
    } finally {
      setBusy(false);
    }
  }
  async function loadMore() {
    if (!cursor) return;
    const version = generation.current,
      key = version + ":" + cursor;
    if (pendingPages.current.has(key)) return;
    pendingPages.current.add(key);
    try {
      const r = await call<{
        data: AssistantMailMessage[];
        next_cursor: string | null;
      }>("messages", { cursor, query });
      if (version !== generation.current) return;
      setItems((v) => [
        ...v,
        ...r.data.filter((item) => !v.some((old) => old.id === item.id)),
      ]);
      setCursor(r.next_cursor);
    } catch (e) {
      if (version === generation.current)
        setError(e instanceof Error ? e.message : "Inbox page unavailable");
    } finally {
      pendingPages.current.delete(key);
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
              key={
                "recipients:" +
                mailbox.identity?.id +
                ":" +
                mailbox.autonomy.recipients.join(",")
              }
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
              key={
                "limit:" +
                mailbox.identity?.id +
                ":" +
                mailbox.autonomy.dailySendLimit
              }
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
          <Button disabled={busy} onClick={() => void readMessage(item.id)}>
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
      {cursor && <Button onClick={() => void loadMore()}>Load more</Button>}
      {body && <pre style={{ whiteSpace: "pre-wrap" }}>{body}</pre>}
      {bodyMessageId && attachments.length > 0 && (
        <MailboxAttachments messageId={bodyMessageId} attachments={attachments} busy={busy} onDownload={downloadAttachment} />
      )}
      <CommandInbox
        key={spaceId + ":" + project + ":" + session.endUserId}
        call={call}
        onApprove={(id) => void act("approve-command", { id })}
        onDownload={downloadAttachment}
        busy={busy}
      />
      {error && <p role="alert">{error}</p>}
      <AssistantPhonePanel
        spaceId={spaceId}
        {...(project ? { projectId: project } : {})}
        session={session}
      />
      <AssistantLearningPanel
        spaceId={spaceId}
        {...(project ? { projectId: project } : {})}
        session={session}
      />
    </section>
  );
}
function CommandInbox({
  call,
  onApprove,
  onDownload,
  busy,
}: {
  call: <T>(action: string, args?: Record<string, unknown>) => Promise<T>;
  onApprove: (id: string) => void;
  onDownload: (messageId: string, attachment: AssistantMailAttachment) => Promise<void>;
  busy: boolean;
}) {
  const [commands, setCommands] = React.useState<
    Array<{ id: string; message_id: string; status: string }>
  >([]);
  const [selected, setSelected] = React.useState<{
    id: string;
    messageId: string;
    text: string;
    attachments: AssistantMailAttachment[];
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
                  void call<{ body: { text: string; attachments?: AssistantMailAttachment[] } }>("message", {
                    id: c.message_id,
                  }).then((r) => setSelected({ id: c.id, messageId: c.message_id, text: r.body.text, attachments: r.body.attachments ?? [] }))
                }
              >
                Review message
              </Button>
              {selected?.id === c.id && (
                <>
                  <pre style={{ whiteSpace: "pre-wrap" }}>{selected.text}</pre>
                  {selected.attachments.length > 0 && (
                    <MailboxAttachments messageId={selected.messageId} attachments={selected.attachments} busy={busy} onDownload={onDownload} />
                  )}
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

function MailboxAttachments({
  messageId,
  attachments,
  busy,
  onDownload,
}: {
  messageId: string;
  attachments: AssistantMailAttachment[];
  busy: boolean;
  onDownload: (messageId: string, attachment: AssistantMailAttachment) => Promise<void>;
}) {
  return (
    <ul aria-label="Message attachments">
      {attachments.map((attachment) => (
        <li key={attachment.id}>
          {attachment.filename} · {attachment.mimeType} · {attachment.sizeBytes} bytes{" "}
          <Button disabled={busy} onClick={() => void onDownload(messageId, attachment)}>Download</Button>
        </li>
      ))}
    </ul>
  );
}
