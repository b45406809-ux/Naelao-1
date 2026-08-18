"use client";

// Step 21: the customer-bot Automation dashboard — a no-code editor for the "after the customer
// says X, this happens" rules that run BEFORE the reasoning loop (cheap, deterministic, so a bot
// can answer an FAQ or hand off to a human without spending a model call). Shown only on a
// customer_bot project. Business ADMIN can add/remove; a member sees them read-only.

import * as React from "react";
import { Button, Card, Badge, FormInput, FormSelect, useToast, Toast } from "@naelao/ui";
import {
  getProjectRules,
  createProjectRule,
  deleteProjectRule,
  type ProjectRule,
  type SessionCredentials,
} from "@/lib/api";

const ACTION_LABEL: Record<ProjectRule["action"], string> = {
  reply: "Reply with a set message",
  run_script: "Run a skill",
  human_takeover: "Hand off to a human",
};
const ACTION_BADGE: Record<ProjectRule["action"], "green" | "blue" | "amber"> = {
  reply: "green",
  run_script: "blue",
  human_takeover: "amber",
};

export function CustomerBotAutomation({
  spaceId,
  projectId,
  creds,
}: {
  spaceId: string;
  projectId: string;
  creds: SessionCredentials;
}) {
  const { toast, show } = useToast();
  const [rules, setRules] = React.useState<ProjectRule[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [failed, setFailed] = React.useState(false);

  const [adding, setAdding] = React.useState(false);
  const [trigger, setTrigger] = React.useState("");
  const [action, setAction] = React.useState<ProjectRule["action"]>("reply");
  const [replyText, setReplyText] = React.useState("");
  const [scriptName, setScriptName] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    try {
      setRules(await getProjectRules(spaceId, projectId, creds));
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceId, projectId]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!trigger.trim()) return;
    if (action === "reply" && !replyText.trim()) {
      show("A reply message is required for this action.");
      return;
    }
    if (action === "run_script" && !scriptName.trim()) {
      show("A skill name is required for this action.");
      return;
    }
    setSaving(true);
    try {
      await createProjectRule(spaceId, projectId, creds, {
        trigger_pattern: trigger.trim(),
        action,
        ...(action === "reply" ? { reply_text: replyText.trim() } : {}),
        ...(action === "run_script" ? { script_name: scriptName.trim() } : {}),
      });
      setTrigger("");
      setReplyText("");
      setScriptName("");
      setAdding(false);
      show("Rule added.");
      await refresh();
    } catch (err) {
      // The most common real failure is 403 (not an admin) — surface it plainly rather than a
      // generic message, so a member understands they can look but not change.
      show(err instanceof Error ? err.message : "Couldn't add the rule.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(ruleId: string) {
    try {
      await deleteProjectRule(spaceId, projectId, ruleId, creds);
      await refresh();
    } catch (err) {
      show(err instanceof Error ? err.message : "Couldn't remove the rule.");
    }
  }

  return (
    <div style={{ marginTop: 24 }}>
      <div className="section-label" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span>Automation</span>
        {!adding && (
          <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>
            Add rule
          </Button>
        )}
      </div>
      <p style={{ fontSize: 12, color: "var(--text3)", margin: "-4px 0 12px" }}>
        Run automatically when a customer message matches — before the AI ever spends a thought.
        Checked in priority order; the first match wins.
      </p>

      {adding && (
        <Card interactive={false} style={{ marginBottom: 12 }}>
          <form onSubmit={handleAdd} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div>
              <div className="settings-row-label" style={{ marginBottom: 4 }}>When the message contains</div>
              <FormInput placeholder="e.g. refund, hours, cancel" value={trigger} onChange={(e) => setTrigger(e.target.value)} required autoFocus />
            </div>
            <div>
              <div className="settings-row-label" style={{ marginBottom: 4 }}>Then</div>
              <FormSelect value={action} onChange={(e) => setAction(e.target.value as ProjectRule["action"])}>
                <option value="reply">Reply with a set message</option>
                <option value="run_script">Run a skill</option>
                <option value="human_takeover">Hand off to a human</option>
              </FormSelect>
            </div>
            {action === "reply" && (
              <div>
                <div className="settings-row-label" style={{ marginBottom: 4 }}>Reply message</div>
                <FormInput placeholder="What to send back" value={replyText} onChange={(e) => setReplyText(e.target.value)} />
              </div>
            )}
            {action === "run_script" && (
              <div>
                <div className="settings-row-label" style={{ marginBottom: 4 }}>Skill to run</div>
                <FormInput placeholder="e.g. refund-request" value={scriptName} onChange={(e) => setScriptName(e.target.value)} />
              </div>
            )}
            <div style={{ display: "flex", gap: 8 }}>
              <Button size="sm" type="submit" disabled={saving || !trigger.trim()}>
                {saving ? "Adding…" : "Add rule"}
              </Button>
              <Button size="sm" variant="secondary" type="button" onClick={() => setAdding(false)}>
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      )}

      {loading ? (
        <p style={{ color: "var(--text3)", fontSize: 13 }}>Loading rules…</p>
      ) : failed ? (
        <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 13 }}>
          <span style={{ color: "#dc2626" }} role="alert">Couldn&rsquo;t load automation rules.</span>
          <Button size="sm" variant="secondary" onClick={() => void refresh()}>Retry</Button>
        </div>
      ) : rules.length === 0 ? (
        <p style={{ color: "var(--text3)", fontSize: 13 }}>
          No rules yet. Add one so common messages get handled instantly, without a model call.
        </p>
      ) : (
        <div className="settings-block">
          {rules.map((r) => (
            <div key={r.id} className="settings-row">
              <div style={{ minWidth: 0 }}>
                <div className="settings-row-label" style={{ marginBottom: 2 }}>
                  &ldquo;{r.trigger_pattern}&rdquo;
                </div>
                <div className="settings-row-sub" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <Badge color={ACTION_BADGE[r.action]}>{ACTION_LABEL[r.action]}</Badge>
                  {r.action === "reply" && r.reply_text ? <span>→ {r.reply_text}</span> : null}
                  {r.action === "run_script" && r.script_name ? <span>→ {r.script_name}</span> : null}
                </div>
              </div>
              <Button size="sm" variant="secondary" onClick={() => void handleDelete(r.id)}>
                Remove
              </Button>
            </div>
          ))}
        </div>
      )}
      <Toast toast={toast} />
    </div>
  );
}
