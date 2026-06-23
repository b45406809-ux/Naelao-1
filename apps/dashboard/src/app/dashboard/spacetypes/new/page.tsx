"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createSpaceType } from "@/lib/api";
import type { CreateSpaceTypeInput } from "@/lib/api";

// G-BE10: SpaceType CRUD — builders configure only, no code writing ever

const MODEL_OPTIONS = [
  { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5 (Fast & Economical)" },
  { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Balanced)" },
];

const BUILT_IN_TOOLS = [
  {
    name: "http_get",
    description: "Fetch content from a public URL via HTTP GET",
  },
  {
    name: "calculate",
    description: "Evaluate mathematical expressions safely",
  },
  {
    name: "search_web",
    description: "Search the web for current information",
  },
];

export default function NewSpaceTypePage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [systemPrompt, setSystemPrompt] = useState(
    "You are a helpful AI assistant. {{#if context}}Use the following context to answer:\n{{context}}{{/if}}"
  );
  const [model, setModel] = useState("claude-haiku-4-5-20251001");
  const [maxTokens, setMaxTokens] = useState(1024);
  const [temperature, setTemperature] = useState(0.7);
  const [maxDocuments, setMaxDocuments] = useState(100);
  const [topK, setTopK] = useState(5);
  const [selectedTools, setSelectedTools] = useState<string[]>([]);

  function toggleTool(toolName: string) {
    setSelectedTools((prev) =>
      prev.includes(toolName)
        ? prev.filter((t) => t !== toolName)
        : [...prev, toolName]
    );
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    // Validation
    if (name.trim().length < 3) {
      setError("Name must be at least 3 characters");
      return;
    }
    if (name.trim().length > 100) {
      setError("Name must be 100 characters or fewer");
      return;
    }
    if (!systemPrompt.trim()) {
      setError("System prompt template is required");
      return;
    }

    setLoading(true);
    try {
      const tools = selectedTools.map((toolName) => {
        const tool = BUILT_IN_TOOLS.find((t) => t.name === toolName);
        return {
          name: toolName,
          description: tool?.description ?? toolName,
        };
      });

      const input: CreateSpaceTypeInput = {
        name: name.trim(),
        description: description.trim(),
        system_prompt_template: systemPrompt.trim(),
        model_config: {
          model,
          max_tokens: maxTokens,
          temperature,
        },
        kb_config: {
          max_documents: maxDocuments,
          chunk_size: 512,
          top_k: topK,
        },
        tools,
      };

      await createSpaceType(input);
      router.push("/dashboard/spacetypes");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create SpaceType");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="max-w-2xl mx-auto">
      <div className="mb-6">
        <div className="flex items-center gap-2 text-sm text-gray-500 mb-2">
          <Link href="/dashboard/spacetypes" className="hover:text-gray-700">
            SpaceTypes
          </Link>
          <span>/</span>
          <span className="text-gray-900">New SpaceType</span>
        </div>
        <h1 className="text-2xl font-bold text-gray-900">New SpaceType</h1>
        <p className="text-gray-500 mt-1">
          Define a reusable blueprint for your AI-powered Spaces.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Basic Info */}
        <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
          <h2 className="font-semibold text-gray-900">Basic Information</h2>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Name <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              minLength={3}
              maxLength={100}
              placeholder="e.g. Customer Support Bot"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition text-sm"
            />
            <p className="text-xs text-gray-400 mt-1">3–100 characters</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              maxLength={500}
              placeholder="What does this SpaceType do?"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition text-sm resize-none"
            />
          </div>
        </div>

        {/* System Prompt */}
        <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
          <div>
            <h2 className="font-semibold text-gray-900">System Prompt Template</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Use {"{{variable}}"} placeholders for dynamic content. This is
              not code — it is a text template sent to the AI.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Template <span className="text-red-500">*</span>
            </label>
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              required
              rows={6}
              placeholder="You are a helpful assistant. {{#if context}}Use this context: {{context}}{{/if}}"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition text-sm font-mono resize-y"
            />
            <p className="text-xs text-gray-400 mt-1">
              Available placeholders: {"{{context}}"} (KB results),{" "}
              {"{{user_name}}"}, {"{{space_name}}"}
            </p>
          </div>
        </div>

        {/* Model Configuration */}
        <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
          <h2 className="font-semibold text-gray-900">Model Configuration</h2>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Model
            </label>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition text-sm bg-white"
            >
              {MODEL_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Max Tokens:{" "}
              <span className="text-brand-600 font-semibold">{maxTokens}</span>
            </label>
            <input
              type="number"
              value={maxTokens}
              onChange={(e) => setMaxTokens(Number(e.target.value))}
              min={256}
              max={8192}
              step={256}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition text-sm"
            />
            <p className="text-xs text-gray-400 mt-1">256 – 8,192 tokens</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Temperature:{" "}
              <span className="text-brand-600 font-semibold">
                {temperature.toFixed(1)}
              </span>
            </label>
            <input
              type="range"
              value={temperature}
              onChange={(e) => setTemperature(Number(e.target.value))}
              min={0}
              max={1}
              step={0.1}
              className="w-full accent-brand-600"
            />
            <div className="flex justify-between text-xs text-gray-400 mt-1">
              <span>0.0 (Precise)</span>
              <span>1.0 (Creative)</span>
            </div>
          </div>
        </div>

        {/* KB Configuration */}
        <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
          <h2 className="font-semibold text-gray-900">
            Knowledge Base Configuration
          </h2>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Max Documents
              </label>
              <input
                type="number"
                value={maxDocuments}
                onChange={(e) => setMaxDocuments(Number(e.target.value))}
                min={1}
                max={10000}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition text-sm"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Top K Results
              </label>
              <input
                type="number"
                value={topK}
                onChange={(e) => setTopK(Number(e.target.value))}
                min={1}
                max={20}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition text-sm"
              />
              <p className="text-xs text-gray-400 mt-1">1 – 20 results per query</p>
            </div>
          </div>
        </div>

        {/* Tools */}
        <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
          <div>
            <h2 className="font-semibold text-gray-900">Built-in Tools</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Select which tools this SpaceType can use during conversations.
            </p>
          </div>

          <div className="space-y-3">
            {BUILT_IN_TOOLS.map((tool) => (
              <label
                key={tool.name}
                className="flex items-start gap-3 p-3 rounded-lg border border-gray-200 cursor-pointer hover:bg-gray-50 transition-colors"
              >
                <input
                  type="checkbox"
                  checked={selectedTools.includes(tool.name)}
                  onChange={() => toggleTool(tool.name)}
                  className="mt-0.5 accent-brand-600"
                />
                <div>
                  <p className="text-sm font-medium text-gray-800">
                    {tool.name}
                  </p>
                  <p className="text-xs text-gray-500">{tool.description}</p>
                </div>
              </label>
            ))}
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm">
            {error}
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-end gap-3">
          <Link
            href="/dashboard/spacetypes"
            className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
          >
            Cancel
          </Link>
          <button
            type="submit"
            disabled={loading}
            className="px-6 py-2 bg-brand-600 hover:bg-brand-700 disabled:bg-brand-300 text-white text-sm font-semibold rounded-lg transition-colors"
          >
            {loading ? "Creating..." : "Create SpaceType"}
          </button>
        </div>
      </form>
    </div>
  );
}
