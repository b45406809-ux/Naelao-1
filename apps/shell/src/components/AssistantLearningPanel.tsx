"use client";
import * as React from "react";
import { assistantMailApi, type SessionCredentials } from "@/lib/api";
export function AssistantLearningPanel({
  spaceId,
  projectId,
  session,
}: { spaceId: string; projectId?: string; session: SessionCredentials }) {
  const [skills, setSkills] = React.useState<
      Array<{ name: string; description: string; status: string }>
    >([]),
    [error, setError] = React.useState(""),
    [detail, setDetail] = React.useState("");
  const gen = React.useRef(0);
  const call = React.useCallback(
    <T,>(action: string, args: Record<string, unknown> = {}, write = false) =>
      assistantMailApi<T>(
        spaceId,
        session,
        { action, ...(projectId ? { projectId } : {}), ...args },
        write
      ),
    [spaceId, projectId, session]
  );
  const refresh = React.useCallback(async () => {
    const g = ++gen.current;
    try {
      const r = await call<{ skills: typeof skills }>("learning-list");
      if (g === gen.current) setSkills(r.skills);
    } catch (e) {
      if (g === gen.current)
        setError(e instanceof Error ? e.message : "Learning unavailable");
    }
  }, [call]);
  React.useEffect(() => {
    setSkills([]);
    setDetail("");
    setError("");
    void refresh();
    return () => {
      gen.current++;
    };
  }, [refresh]);
  async function act(
    action: string,
    name: string,
    args: Record<string, unknown> = {}
  ) {
    const g = gen.current;
    try {
      const r = await call<{ skill: unknown }>(
        action,
        { name, ...args },
        action !== "learning-read"
      );
      if (g !== gen.current) return;
      if (action === "learning-read")
        setDetail(JSON.stringify(r.skill, null, 2));
      await refresh();
    } catch (e) {
      if (g === gen.current)
        setError(e instanceof Error ? e.message : "Action failed");
    }
  }
  return (
    <section aria-label="Learned browser skills">
      <h4>Learned browser skills</h4>
      <p>
        Private to you and this assistant workspace. Record a demonstration
        under Website accounts, review its parameters, and ask this assistant to
        test it using a test account. A successful replay and final assertion
        are required before you enable reuse.
      </p>
      {error && <p role="alert">{error}</p>}
      <button type="button" onClick={() => void refresh()}>
        Refresh skills
      </button>
      <ul>
        {skills.map((s) => (
          <li key={s.name}>
            <strong>{s.name}</strong> — {s.status}{" "}
            <button
              type="button"
              onClick={() => void act("learning-read", s.name)}
            >
              Review
            </button>
            {s.status === "validated" && (
              <button
                type="button"
                onClick={() => {
                  if (
                    window.confirm(
                      "Enable this tested browser workflow for reuse by your assistant? Current permissions and action approvals still apply."
                    )
                  )
                    void act("learning-enable", s.name, {
                      confirm: true,
                      enabled: true,
                    });
                }}
              >
                Enable tested skill
              </button>
            )}
            {s.status === "enabled" && (
              <button
                type="button"
                onClick={() =>
                  void act("learning-enable", s.name, {
                    confirm: true,
                    enabled: false,
                  })
                }
              >
                Disable
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                if (window.confirm("Delete this learned skill?"))
                  void act("learning-discard", s.name, { confirm: true });
              }}
            >
              Delete
            </button>
            <p>
              Test request: Test browser skill “{s.name}” using an authorized
              test website connection and synthetic values for its parameters.
            </p>
          </li>
        ))}
      </ul>
      {detail && <pre style={{ whiteSpace: "pre-wrap" }}>{detail}</pre>}
    </section>
  );
}
