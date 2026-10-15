import test from "node:test";
import assert from "node:assert/strict";
import { discoverLocalModelIds } from "../src/runtime.mjs";

test("discovers OpenAI-compatible loopback models only with explicit inference consent", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push([String(url), init.method]);
    return Response.json({ data: [{ id: "qwen:7b" }, { id: "llama3.2" }, { id: "qwen:7b" }] });
  };
  assert.deepEqual(await discoverLocalModelIds({ allowInference: false, inferenceUrl: "http://127.0.0.1:11434/v1/chat/completions" }, fetchImpl), []);
  assert.equal(calls.length, 0);
  assert.deepEqual(await discoverLocalModelIds({ allowInference: true, inferenceUrl: "http://127.0.0.1:11434/v1/chat/completions" }, fetchImpl), ["qwen:7b", "llama3.2"]);
  assert.deepEqual(calls, [["http://127.0.0.1:11434/v1/models", "GET"]]);
});

test("falls back to Ollama tags and ignores malformed or oversized inventory", async () => {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(String(url));
    if (String(url).endsWith("/v1/models")) return new Response("", { status: 404 });
    return Response.json({ models: [{ name: "qwen2.5:7b" }, { name: "bad\nmodel" }] });
  };
  assert.deepEqual(await discoverLocalModelIds({ allowInference: true, inferenceUrl: "http://localhost:11434/v1/chat/completions" }, fetchImpl), ["qwen2.5:7b"]);
  assert.deepEqual(calls, ["http://localhost:11434/v1/models", "http://localhost:11434/api/tags"]);
  await assert.rejects(() => discoverLocalModelIds({ allowInference: true, inferenceUrl: "http://192.168.1.4:11434/v1/chat/completions" }, fetchImpl), /bridge_inference_loopback_required/);
});
