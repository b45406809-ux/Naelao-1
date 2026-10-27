"use client";

export const runtime = "edge";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { apiFetch } from "@/lib/api";

interface EvalSuite {
  id: string;
  name: string;
  description?: string;
  case_count: number;
  pass_rate?: number;
  run_count: number;
  created_at: string;
}

interface EvalRun {
  id: string;
  model: string | null;
  status: "pending" | "running" | "completed" | "failed";
  total_cases: number;
  passed: number;
  failed: number;
  avg_score: number | null;
  avg_latency_ms?: number | null;
  started_at: string | null;
  completed_at: string | null;
}

interface EvalCaseResult {
  id: string;
  case_index: number;
  passed: boolean;
  input: string;
  expected: string;
  actual: string;
  judge_reasoning: string;
  score: number | null;
  latency_ms: number | null;
}

export default function EvalPage() {
  const params = useParams<{ spaceId: string }>();
  const [suites, setSuites] = useState<EvalSuite[]>([]);
  const [runs, setRuns] = useState<EvalRun[]>([]);
  const [results, setResults] = useState<EvalCaseResult[]>([]);
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState({ name: "", description: "", test_cases: "[]" });
  const [sessionId, setSessionId] = useState("");
  const [modelCandidates, setModelCandidates] = useState("");
  const [matrixResults, setMatrixResults] = useState<Array<{ model: string; run_id: string; case_count: number; avg_score: number; avg_latency_ms: number | null; agent_errors: number; judge_errors: number }>>([]);
  const [matrixProgress, setMatrixProgress] = useState("");
  const [runMessage, setRunMessage] = useState("");
  const [runError, setRunError] = useState("");
  const [generatingFixtures, setGeneratingFixtures] = useState(false);
  const [fixtureMessage, setFixtureMessage] = useState("");
  const [fixtureError, setFixtureError] = useState("");

  useEffect(() => {
    void loadSuites();
  }, [params.spaceId]);

  async function loadSuites() {
    setLoading(true);
    try {
      const data = await apiFetch<{ data: EvalSuite[] }>(`/v1/evals?space_id=${encodeURIComponent(params.spaceId)}`);
      setSuites(data.data);
    } catch { /* ignore */ } finally { setLoading(false); }
  }

  async function loadResults(suiteId: string) {
    setSelected(suiteId);
    try {
      const data = await apiFetch<{ data: EvalRun[] }>(`/v1/evals/${suiteId}/results`);
      setRuns(data.data);
      const latest = data.data[0];
      if (latest) await loadRunResults(suiteId, latest.id);
      else { setSelectedRun(null); setResults([]); }
    } catch { /* ignore */ }
  }

  async function loadRunResults(suiteId: string, runId: string) {
    const data = await apiFetch<{ data: EvalCaseResult[] }>(`/v1/evals/${suiteId}/results?run_id=${encodeURIComponent(runId)}`);
    setSelectedRun(runId);
    setResults(data.data);
  }

  async function runEval(suiteId: string, model?: string) {
    if (!sessionId.trim()) {
      setRunError("Enter an existing agent session ID to run the suite against the actual agent.");
      setRunMessage("");
      return;
    }
    setRunning(suiteId);
    setRunError("");
    setRunMessage("");
    try {
      const result = await apiFetch<{ run_id: string; mode: string; case_count: number; avg_score: number; avg_latency_ms: number | null; agent_errors: number; judge_errors: number }>(
        `/v1/evals/${suiteId}/run`,
        { method: "POST", body: JSON.stringify({ mode: "agent", session_id: sessionId.trim(), ...(model ? { model } : {}) }) },
      );
      setRunMessage(`Agent run ${result.run_id}${model ? ` · ${model}` : ""}: ${result.case_count} cases, average score ${result.avg_score.toFixed(2)}, average latency ${result.avg_latency_ms === null ? "unavailable" : `${result.avg_latency_ms} ms`}, ${result.agent_errors} agent errors, ${result.judge_errors} judge errors.`);
      await loadSuites();
      await loadResults(suiteId);
    } catch (error) {
      setRunError(error instanceof Error ? error.message : "Agent evaluation failed.");
    } finally { setRunning(null); }
  }

  async function runModelMatrix(suiteId: string) {
    if (!sessionId.trim()) { setRunError("Enter an existing agent session ID before comparing models."); return; }
    const models = [...new Set(modelCandidates.split(/[\n,]/).map(value => value.trim()).filter(Boolean))];
    if (!models.length || models.length > 8 || models.some(model => model.length > 200)) {
      setRunError("Enter 1–8 model IDs. Each model must also be available in the agents worker's approved model catalog.");
      return;
    }
    setRunning(suiteId); setRunError(""); setRunMessage(""); setMatrixResults([]);
    const completed: typeof matrixResults = [];
    try {
      for (const [index, model] of models.entries()) {
        setMatrixProgress(`Running ${index + 1}/${models.length}: ${model}`);
        const result = await apiFetch<{ run_id: string; case_count: number; avg_score: number; avg_latency_ms: number | null; agent_errors: number; judge_errors: number }>(
          `/v1/evals/${suiteId}/run`,
          { method: "POST", body: JSON.stringify({ mode: "agent", session_id: sessionId.trim(), model }) },
        );
        completed.push({ model, run_id: result.run_id, case_count: result.case_count, avg_score: result.avg_score,
          avg_latency_ms: result.avg_latency_ms, agent_errors: result.agent_errors, judge_errors: result.judge_errors });
        setMatrixResults([...completed]);
      }
      setMatrixProgress("Comparison complete. Runs were sequential and are retained in suite history.");
      await loadSuites(); await loadResults(suiteId);
    } catch (error) {
      setRunError(error instanceof Error ? error.message : "Model comparison failed.");
      setMatrixProgress(`Stopped after ${completed.length} of ${models.length} runs; completed results are retained.`);
    } finally { setRunning(null); }
  }

  async function createSuite() {
    try {
      const testCases = JSON.parse(form.test_cases) as unknown[];
      await apiFetch(`/v1/evals`, {
        method: "POST",
        body: JSON.stringify({ name: form.name, description: form.description, space_id: params.spaceId, cases: testCases }),
      });
      setShowNew(false);
      setForm({ name: "", description: "", test_cases: "[]" });
      await loadSuites();
    } catch { /* ignore */ }
  }

  async function generateFixtures() {
    setGeneratingFixtures(true);
    setFixtureMessage("");
    setFixtureError("");
    try {
      const result = await apiFetch<{ cases: Array<{ input: string; expected_output: string; criteria: string; tags?: string[] }>; count: number; requires_review: boolean }>(
        "/v1/evals/fixtures/generate",
        { method: "POST", body: JSON.stringify({ description: form.description, count: 40 }) },
      );
      setForm(current => ({ ...current, test_cases: JSON.stringify(result.cases, null, 2) }));
      setFixtureMessage(`Generated ${result.count} synthetic cases. Review and edit them before creating the suite; generation does not run or certify them.`);
    } catch (error) {
      setFixtureError(error instanceof Error ? error.message : "Fixture generation failed.");
    } finally { setGeneratingFixtures(false); }
  }

  return (
    <div className="max-w-5xl mx-auto">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Eval Suites</h1>
          <p className="text-gray-500 mt-1">Run evaluation cases against a real agent session and inspect trace-backed checks.</p>
        </div>
        <button onClick={() => setShowNew(true)} className="px-4 py-2 bg-brand-600 text-white text-sm font-semibold rounded-lg hover:bg-brand-700">
          + New Suite
        </button>
      </div>

      <div className="mb-4 rounded-lg border border-gray-200 bg-white p-4">
        <label htmlFor="eval-session-id" className="block text-sm font-medium text-gray-700">Agent session ID</label>
        <p className="mb-2 text-xs text-gray-500">Choose an existing session in this Space. The suite sends each case as a goal to the agent.</p>
        <input id="eval-session-id" value={sessionId} onChange={event => setSessionId(event.currentTarget.value)}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono" placeholder="session_…" />
        {runMessage && <p role="status" className="mt-2 text-sm text-green-700">{runMessage}</p>}
        {runError && <p role="alert" className="mt-2 text-sm text-red-700">{runError}</p>}
      </div>

      <section className="mb-6 rounded-xl border border-gray-200 bg-white p-4">
        <h2 className="font-semibold text-gray-900">Model comparison</h2>
        <p className="mt-1 text-sm text-gray-500">Run this suite against up to eight approved model IDs, sequentially. Each entry is a real agent run and consumes plan quota.</p>
        <label className="mt-3 block text-xs text-gray-600">Model IDs, one per line
          <textarea value={modelCandidates} onChange={event => setModelCandidates(event.currentTarget.value)} className="mt-1 min-h-16 w-full rounded border border-gray-300 px-2 py-2 text-xs font-mono" placeholder="provider/model-id" />
        </label>
        {selected && <button onClick={() => void runModelMatrix(selected)} disabled={running === selected || !sessionId.trim()} className="mt-2 rounded bg-brand-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">{running === selected ? "Comparing…" : "Run comparison for selected suite"}</button>}
        {matrixProgress && <p role="status" className="mt-3 text-xs text-gray-500">{matrixProgress}</p>}
        {!!matrixResults.length && <div className="mt-3 overflow-x-auto"><table className="w-full text-left text-xs"><thead className="text-gray-500"><tr><th className="py-2 pr-3">Model</th><th className="py-2 pr-3">Score</th><th className="py-2 pr-3">Average latency</th><th className="py-2 pr-3">Agent errors</th><th className="py-2 pr-3">Judge errors</th><th className="py-2">Run</th></tr></thead><tbody>{matrixResults.map(result => <tr key={result.run_id} className="border-t border-gray-100"><td className="py-2 pr-3 font-mono">{result.model}</td><td className="py-2 pr-3">{result.avg_score.toFixed(2)}</td><td className="py-2 pr-3">{result.avg_latency_ms === null ? "—" : `${result.avg_latency_ms} ms`}</td><td className="py-2 pr-3">{result.agent_errors}</td><td className="py-2 pr-3">{result.judge_errors}</td><td className="py-2 font-mono">{result.run_id.slice(0, 8)}</td></tr>)}</tbody></table></div>}
      </section>

      {showNew && (
        <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
          <h2 className="font-semibold text-gray-900 mb-4">New Eval Suite</h2>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
              <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Test Cases (JSON array)</label>
              <button type="button" disabled={generatingFixtures || !form.description.trim()} onClick={() => void generateFixtures()}
                className="mb-2 rounded border border-gray-300 px-3 py-1.5 text-xs text-gray-700 disabled:opacity-50">
                {generatingFixtures ? "Generating…" : "Generate 40 synthetic cases"}
              </button>
              {fixtureMessage && <p role="status" className="mb-2 text-xs text-green-700">{fixtureMessage}</p>}
              {fixtureError && <p role="alert" className="mb-2 text-xs text-red-700">{fixtureError}</p>}
              <textarea rows={6} value={form.test_cases} onChange={(e) => setForm({ ...form, test_cases: e.target.value })}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-brand-500"
                placeholder='[{"input": "What is 2+2?", "expected": "4"}]' />
            </div>
            <div className="flex gap-3">
              <button onClick={() => void createSuite()} className="px-4 py-2 bg-brand-600 text-white text-sm font-semibold rounded-lg hover:bg-brand-700">Create</button>
              <button onClick={() => setShowNew(false)} className="px-4 py-2 border border-gray-300 text-gray-700 text-sm rounded-lg hover:bg-gray-50">Cancel</button>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-center py-12 text-gray-400">Loading...</div>
      ) : (
        <div className="grid grid-cols-1 gap-4">
          {suites.map((suite) => (
            <div key={suite.id} className="bg-white rounded-xl border border-gray-200 p-5">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="font-semibold text-gray-900">{suite.name}</h3>
                  <p className="text-sm text-gray-500 mt-0.5">{suite.description}</p>
                  <div className="flex items-center gap-4 mt-2 text-xs text-gray-400">
                    <span>{suite.case_count} cases</span><span>Runs: {suite.run_count}</span>
                    {suite.pass_rate !== undefined && (
                      <span>Pass rate: <strong className={suite.pass_rate >= 0.8 ? "text-green-600" : "text-red-600"}>{Math.round(suite.pass_rate * 100)}%</strong></span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => void loadResults(suite.id)} className="text-xs text-brand-600 hover:underline">
                    View results
                  </button>
                  <button
                    onClick={() => void runEval(suite.id)}
                    disabled={running === suite.id || !sessionId.trim()}
                    className="px-3 py-1.5 bg-brand-600 text-white text-xs font-semibold rounded-lg hover:bg-brand-700 disabled:opacity-50"
                  >
                    {running === suite.id ? "Running…" : "Run"}
                  </button>
                </div>
              </div>

              {selected === suite.id && results.length > 0 && (
                <div className="mt-4 border-t border-gray-100 pt-4">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <h4 className="text-sm font-medium text-gray-700">Case results</h4>
                    <label className="text-xs text-gray-500">Run <select value={selectedRun ?? ""} onChange={event => void loadRunResults(suite.id, event.currentTarget.value)} className="ml-1 rounded border border-gray-300 px-2 py-1">
                      {runs.map(run => <option key={run.id} value={run.id}>{new Date(run.started_at ?? "").toLocaleString()} · {run.passed}/{run.total_cases} passed · {run.model ?? "default model"}{run.avg_latency_ms != null ? ` · ${Math.round(run.avg_latency_ms)} ms` : ""}</option>)}
                    </select></label>
                  </div>
                  <div className="space-y-2 max-h-80 overflow-y-auto">
                    {results.map((r) => (
                      <div key={r.id} className={`text-xs p-3 rounded-lg border ${r.passed ? "border-green-200 bg-green-50" : "border-red-200 bg-red-50"}`}>
                        <div className="flex justify-between mb-1">
                          <span className="font-medium">{r.passed ? "PASS" : "FAIL"}</span>
                          <span className="text-gray-500">Score: {r.score === null ? "Judge unavailable" : r.score.toFixed(2)}{r.latency_ms !== null ? ` · ${r.latency_ms}ms` : ""}</span>
                        </div>
                        <p className="text-gray-600"><strong>Input:</strong> {r.input}</p>
                        <p className="text-gray-600"><strong>Expected:</strong> {r.expected}</p>
                        <p className="text-gray-600"><strong>Actual:</strong> {r.actual}</p>
                        {r.judge_reasoning && <p className="text-gray-500 italic mt-1">{r.judge_reasoning}</p>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}

          {suites.length === 0 && (
            <div className="text-center py-12 text-gray-400">No eval suites yet. Create one to get started.</div>
          )}
        </div>
      )}
    </div>
  );
}
