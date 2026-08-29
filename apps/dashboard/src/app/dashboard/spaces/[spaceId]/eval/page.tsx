"use client";


import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { apiFetch } from "@/lib/api";

interface EvalSuite {
  id: string;
  name: string;
  description: string;
  status: "pending" | "running" | "completed" | "failed";
  pass_rate?: number;
  run_count: number;
  created_at: string;
}

interface EvalResult {
  id: string;
  suite_id: string;
  score: number;
  passed: boolean;
  input: string;
  expected: string;
  actual: string;
  judge_reasoning: string;
  created_at: string;
}

export default function EvalPage() {
  const params = useParams<{ spaceId: string }>();
  const [suites, setSuites] = useState<EvalSuite[]>([]);
  const [results, setResults] = useState<EvalResult[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState({ name: "", description: "", test_cases: "[]" });

  useEffect(() => {
    void loadSuites();
  }, [params.spaceId]);

  async function loadSuites() {
    setLoading(true);
    try {
      const data = await apiFetch<{ data: EvalSuite[] }>(`/v1/spaces/${params.spaceId}/eval`);
      setSuites(data.data);
    } catch { /* ignore */ } finally { setLoading(false); }
  }

  async function loadResults(suiteId: string) {
    setSelected(suiteId);
    try {
      const data = await apiFetch<{ data: EvalResult[] }>(`/v1/evals/${suiteId}/results`);
      setResults(data.data);
    } catch { /* ignore */ }
  }

  async function runEval(suiteId: string) {
    setRunning(suiteId);
    try {
      await apiFetch(`/v1/evals/${suiteId}/run`, { method: "POST" });
      await loadSuites();
    } catch { /* ignore */ } finally { setRunning(null); }
  }

  async function createSuite() {
    try {
      const testCases = JSON.parse(form.test_cases) as unknown[];
      await apiFetch(`/v1/spaces/${params.spaceId}/eval`, {
        method: "POST",
        body: JSON.stringify({ name: form.name, description: form.description, test_cases: testCases }),
      });
      setShowNew(false);
      setForm({ name: "", description: "", test_cases: "[]" });
      await loadSuites();
    } catch { /* ignore */ }
  }

  return (
    <div className="max-w-5xl mx-auto">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Eval Suites</h1>
          <p className="text-gray-500 mt-1">LLM-judged evaluation runs for this Space</p>
        </div>
        <button onClick={() => setShowNew(true)} className="px-4 py-2 bg-brand-600 text-white text-sm font-semibold rounded-lg hover:bg-brand-700">
          + New Suite
        </button>
      </div>

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
                    <span>Runs: {suite.run_count}</span>
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
                    disabled={running === suite.id || suite.status === "running"}
                    className="px-3 py-1.5 bg-brand-600 text-white text-xs font-semibold rounded-lg hover:bg-brand-700 disabled:opacity-50"
                  >
                    {running === suite.id ? "Running…" : "Run"}
                  </button>
                </div>
              </div>

              {selected === suite.id && results.length > 0 && (
                <div className="mt-4 border-t border-gray-100 pt-4">
                  <h4 className="text-sm font-medium text-gray-700 mb-2">Latest Results</h4>
                  <div className="space-y-2 max-h-80 overflow-y-auto">
                    {results.map((r) => (
                      <div key={r.id} className={`text-xs p-3 rounded-lg border ${r.passed ? "border-green-200 bg-green-50" : "border-red-200 bg-red-50"}`}>
                        <div className="flex justify-between mb-1">
                          <span className="font-medium">{r.passed ? "PASS" : "FAIL"}</span>
                          <span className="text-gray-500">Score: {r.score.toFixed(2)}</span>
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
