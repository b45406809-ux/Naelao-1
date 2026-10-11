"use client";

import * as React from "react";
import { answerQuestion, type RunPendingApproval, type SessionCredentials } from "@/lib/api";

type QuestionnaireItem = { question: string; options?: string[] };

/** Claude-Code-style mid-run questionnaire. The run remains durable while this card is open. */
export function InlineQuestionCard({
  spaceId,
  question,
  session,
  onAnswered,
}: {
  spaceId: string;
  question: RunPendingApproval;
  session: SessionCredentials;
  onAnswered?: () => void;
}) {
  const items: QuestionnaireItem[] = question.questions?.length
    ? question.questions.slice(0, 5)
    : [{ question: question.question ?? "Please provide the missing information.", ...(question.options?.length ? { options: question.options } : {}) }];
  const [answers, setAnswers] = React.useState<string[]>(() => items.map(() => ""));
  const [busy, setBusy] = React.useState(false);
  const [answered, setAnswered] = React.useState(false);
  const [error, setError] = React.useState("");
  const questionId = question.question_id ?? question.approval_id;
  const complete = answers.length === items.length && answers.every((answer) => answer.trim());

  function setAnswer(index: number, value: string) {
    setAnswers((current) => current.map((answer, i) => i === index ? value : answer));
  }

  async function submit() {
    if (!complete || !questionId) return;
    setBusy(true);
    setError("");
    const payload = items.length === 1
      ? answers[0]!.trim()
      : JSON.stringify(items.map((item, index) => ({ question: item.question, answer: answers[index]!.trim() })));
    try {
      await answerQuestion(spaceId, questionId, payload, session);
      setAnswered(true);
      onAnswered?.();
    } catch {
      setError("I couldn't send those answers. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div role="dialog" aria-label="Questions from the planner" style={{ marginTop: 6, maxWidth: 520, border: "1px solid var(--accent)", borderRadius: "var(--radius-sm)", background: "var(--surface2)", padding: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 7 }}>
        <span aria-hidden style={{ fontSize: 14 }}>?</span>
        <span style={{ fontSize: 12.5, fontWeight: 650, color: "var(--text)" }}>
          {items.length === 1 ? "Question from the planner" : `${items.length} questions from the planner`}
        </span>
      </div>
      {answered ? (
        <div style={{ fontSize: 12.5, color: "var(--accent)", fontWeight: 600 }}>Thanks — continuing the run…</div>
      ) : (
        <>
          {items.map((item, index) => (
            <div key={`${item.question}-${index}`} style={{ marginBottom: index === items.length - 1 ? 10 : 12 }}>
              <div style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.45, marginBottom: 6 }}>
                {items.length > 1 && <span style={{ color: "var(--muted)", marginRight: 5 }}>{index + 1}.</span>}
                {item.question}
              </div>
              {item.options?.length ? (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 6 }}>
                  {item.options.map((option) => (
                    <button key={option} type="button" className="btn btn-ghost btn-sm" onClick={() => setAnswer(index, option)} disabled={busy}>
                      {option}
                    </button>
                  ))}
                </div>
              ) : null}
              <input
                className="form-input"
                value={answers[index] ?? ""}
                onChange={(event) => setAnswer(index, event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter" && index === items.length - 1) void submit(); }}
                placeholder={items.length > 1 ? `Answer ${index + 1}` : "Type your answer"}
                autoFocus={index === 0}
                style={{ width: "100%", fontSize: 12.5 }}
                disabled={busy}
              />
            </div>
          ))}
          <button type="button" className="btn btn-primary btn-sm" onClick={() => void submit()} disabled={busy || !complete}>
            {busy ? "…" : "Continue"}
          </button>
          {error && <div role="alert" style={{ marginTop: 7, fontSize: 12, color: "var(--danger, #f87171)" }}>{error}</div>}
        </>
      )}
    </div>
  );
}
