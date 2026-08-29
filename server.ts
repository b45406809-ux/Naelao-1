import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const PORT = 3000;
const HOST = "0.0.0.0";

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  
  // Set CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health endpoint
  if (url.pathname === "/health" || url.pathname === "/api/health" || url.pathname === "/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "healthy",
      platform: "Naelao AI Engine",
      runtime: "Cloudflare Workers & Agents Environment",
      timestamp: new Date().toISOString(),
      tools: ["Read", "Edit", "Write", "Grep", "Glob", "Bash", "compact_context"]
    }));
    return;
  }

  // Serve developer dashboard UI
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Naelao Platform — Development Server</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    body { font-family: 'Plus Jakarta Sans', sans-serif; }
    code, pre { font-family: 'JetBrains Mono', monospace; }
  </style>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen flex flex-col justify-between selection:bg-indigo-500 selection:text-white">
  <!-- Top Navigation -->
  <header class="border-b border-slate-800 bg-slate-900/60 backdrop-blur-md sticky top-0 z-50">
    <div class="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
      <div class="flex items-center space-x-3">
        <div class="w-8 h-8 rounded-lg bg-gradient-to-tr from-indigo-500 to-violet-500 flex items-center justify-center font-bold text-white shadow-lg shadow-indigo-500/20">
          N
        </div>
        <span class="font-bold text-lg tracking-tight bg-gradient-to-r from-white to-slate-400 bg-clip-text text-transparent">Naelao Engine</span>
        <span class="text-xs px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-medium">Dev Ready</span>
      </div>
      <div class="flex items-center space-x-4 text-xs text-slate-400">
        <span class="flex items-center gap-1.5">
          <span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
          Port 3000 Active
        </span>
        <span class="hidden sm:inline text-slate-700">|</span>
        <span class="hidden sm:inline font-mono">Node ${process.version}</span>
      </div>
    </div>
  </header>

  <!-- Main Content -->
  <main class="max-w-6xl mx-auto px-6 py-12 flex-1 w-full space-y-10">
    <div class="space-y-4">
      <h1 class="text-3xl sm:text-4xl font-bold tracking-tight text-white">
        Autonomous Business Platform & Agent Runtime
      </h1>
      <p class="text-slate-400 text-base max-w-2xl leading-relaxed">
        The Cloudflare Workers and Agent execution engine is initialized. Workspace primitives, AST patching, and token-optimized REPL loops are active.
      </p>
    </div>

    <!-- Metrics Grid -->
    <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
      <div class="bg-slate-900/80 border border-slate-800 rounded-xl p-5 space-y-3">
        <div class="flex items-center justify-between">
          <span class="text-xs font-semibold uppercase tracking-wider text-slate-400">Agent Tools</span>
          <span class="text-xs px-2 py-0.5 rounded bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">Step 1</span>
        </div>
        <div class="text-2xl font-bold text-white">6 Primitives</div>
        <p class="text-xs text-slate-400">Read, Edit, Write, Grep, Glob, and Bash mapped with near-miss AST line matching.</p>
      </div>

      <div class="bg-slate-900/80 border border-slate-800 rounded-xl p-5 space-y-3">
        <div class="flex items-center justify-between">
          <span class="text-xs font-semibold uppercase tracking-wider text-slate-400">REPL Optimization</span>
          <span class="text-xs px-2 py-0.5 rounded bg-violet-500/10 text-violet-400 border border-violet-500/20">Step 2</span>
        </div>
        <div class="text-2xl font-bold text-white">Garbage Collector</div>
        <p class="text-xs text-slate-400">Surgical tool payload eviction (&gt;3 turns) & in-flight self-compaction active.</p>
      </div>

      <div class="bg-slate-900/80 border border-slate-800 rounded-xl p-5 space-y-3">
        <div class="flex items-center justify-between">
          <span class="text-xs font-semibold uppercase tracking-wider text-slate-400">Prompt Caching</span>
          <span class="text-xs px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">Enabled</span>
        </div>
        <div class="text-2xl font-bold text-white">Ephemeral Cache</div>
        <p class="text-xs text-slate-400">Breakpoints configured across system instructions and tool definitions.</p>
      </div>
    </div>

    <!-- Active Worker Services -->
    <div class="bg-slate-900/50 border border-slate-800 rounded-xl p-6 space-y-4">
      <h2 class="text-lg font-semibold text-white">Worker Architecture & Microservices</h2>
      <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 text-xs">
        <div class="p-3 bg-slate-950/60 rounded-lg border border-slate-800/80 flex items-center space-x-2">
          <span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
          <span class="text-slate-300">workers/agents</span>
        </div>
        <div class="p-3 bg-slate-950/60 rounded-lg border border-slate-800/80 flex items-center space-x-2">
          <span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
          <span class="text-slate-300">workers/router</span>
        </div>
        <div class="p-3 bg-slate-950/60 rounded-lg border border-slate-800/80 flex items-center space-x-2">
          <span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
          <span class="text-slate-300">workers/auth</span>
        </div>
        <div class="p-3 bg-slate-950/60 rounded-lg border border-slate-800/80 flex items-center space-x-2">
          <span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
          <span class="text-slate-300">workers/spaces</span>
        </div>
        <div class="p-3 bg-slate-950/60 rounded-lg border border-slate-800/80 flex items-center space-x-2">
          <span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
          <span class="text-slate-300">workers/billing</span>
        </div>
        <div class="p-3 bg-slate-950/60 rounded-lg border border-slate-800/80 flex items-center space-x-2">
          <span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
          <span class="text-slate-300">workers/knowledge</span>
        </div>
        <div class="p-3 bg-slate-950/60 rounded-lg border border-slate-800/80 flex items-center space-x-2">
          <span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
          <span class="text-slate-300">workers/threads</span>
        </div>
        <div class="p-3 bg-slate-950/60 rounded-lg border border-slate-800/80 flex items-center space-x-2">
          <span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
          <span class="text-slate-300">workers/mcp-hub</span>
        </div>
      </div>
    </div>
  </main>

  <!-- Footer -->
  <footer class="border-t border-slate-900 bg-slate-950/80 py-6 text-center text-xs text-slate-500">
    Naelao Development Environment — Ready for Cloudflare & GitHub Workflows
  </footer>
</body>
</html>`);
});

server.listen(PORT, HOST, () => {
  console.log(`[naelao] Dev server listening at http://${HOST}:${PORT}`);
});
