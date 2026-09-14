import { mkdir, readFile, writeFile } from "node:fs/promises";

const batches = [
  {
    id: 1,
    from: 1,
    to: 19,
    words:
      /hierarchy|sub.?space|private project|artifactfs|git.?for.?agents|execution ladder|runtime hypervisor|container|micro.?fork|git blame/i,
  },
  {
    id: 2,
    from: 20,
    to: 24,
    words: /runtime sdk|vault|writeguard|virtual cli|cli synthesis/i,
  },
  {
    id: 3,
    from: 25,
    to: 38,
    words:
      /connector scoping|re.?auth|gatekeeper|delegation|skill distillation|tool catalog|egress dlp|turn holder/i,
  },
  {
    id: 4,
    from: 39,
    to: 46,
    words:
      /agent kernel|system prompt|role firewall|planner|memory|context isolation|semantic fact|compact context/i,
  },
  {
    id: 5,
    from: 47,
    to: 54,
    words:
      /sovereign permission|vector pre.?filter|cohere|hybrid retrieval|citation|project mcp|composio|pipedream/i,
  },
  {
    id: 6,
    from: 55,
    to: 60,
    words:
      /thread tier|scratchpad|solo promotion|compare.?and.?swap|mutex|pull request|rebase/i,
  },
  {
    id: 7,
    from: 61,
    to: 70,
    words:
      /task lease|spectator|intent dedup|rfc|deliberation|alert routing|provenance|model race|presence|split.?actor/i,
  },
  {
    id: 8,
    from: 71,
    to: 75,
    words:
      /certified model|whitelist.?only|lora|air.?gap|local tunnel|auto.?sleep|terminal/i,
  },
  {
    id: 9,
    from: 76,
    to: 87,
    words:
      /business mode|developer mode|canvas|project kind|extension|gadget|daemon|tree.?sitter|mcp.?ui|widget|workflow class/i,
  },
  {
    id: 10,
    from: 88,
    to: 103,
    words:
      /subagent context|branch accumulator|workflow harness|webhook|tombstone|queue|replay lake|rate.?limit|idempotency|hop count|schema repair|scheduled cron|calendar/i,
  },
  {
    id: 11,
    from: 104,
    to: 111,
    words:
      /telephon|voice|dictation|executive copilot|customer telemetry|customer.?facing|call session/i,
  },
  {
    id: 12,
    from: 112,
    to: 119,
    words:
      /credit meter|subscription plan|budget envelope|wallet|self.?funding|venture export|pii scrub|blueprint compiler|security rating/i,
  },
  {
    id: 13,
    from: 120,
    to: 130,
    words:
      /recipe marketplace|customer service automation|developer marketplace|pricing rule|commission|cycle quota|plan.?hopping|price floor|vertical saas|partner portal|market radar|iceberg/i,
  },
];

function planSlice(plan, from, to) {
  const start = plan.search(new RegExp(`^### ${from}\\.`, "m"));
  const end =
    to === 130
      ? plan.length
      : plan.search(new RegExp(`^### ${to + 1}\\.`, "m"));
  if (start < 0 || end < 0)
    throw new Error(`Cannot locate plan items ${from}-${to}`);
  return plan.slice(start, end);
}

function relevantBlocks(text, matcher, radius = 2, maxChars = 250_000) {
  const blocks = text.replace(/\r/g, "").split(/\n\s*\n/);
  const candidates = [];
  for (let index = 0; index < blocks.length; index++) {
    const matches = (blocks[index] ?? "").match(
      new RegExp(matcher.source, "gi")
    );
    if (!matches) continue;
    candidates.push({ index, score: matches.length });
  }
  candidates.sort((a, b) => b.score - a.score || b.index - a.index);
  const selected = new Set();
  let size = 0;
  for (const candidate of candidates) {
    if (size >= maxChars) break;
    for (let offset = -radius; offset <= radius; offset++) {
      const index = candidate.index + offset;
      if (!selected.has(index) && blocks[index]?.trim()) {
        selected.add(index);
        size += blocks[index].length;
      }
    }
  }
  return [...selected]
    .sort((a, b) => a - b)
    .map((index) => blocks[index])
    .join("\n\n");
}

function htmlToText(html) {
  return html
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, "")
    .replace(/<(?:br|\/p|\/li|\/h[1-6]|\/pre|\/tr|\/section)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n");
}

function jsonChunk(json, index) {
  const parsed = JSON.parse(json);
  return parsed.chunkedPrompt?.chunks?.[index]?.text ?? "";
}

const [plan, claude, expandedHtml, appendix, avos, master] = await Promise.all([
  readFile("_BUILD_PLAN/plan.md", "utf8"),
  readFile("CLAUDE.md", "utf8"),
  readFile("naelao_expanded_gaps_resolved.html", "utf8"),
  readFile(
    "docs/spec-appendix/A1-script-agents-and-space-assistants.md",
    "utf8"
  ),
  readFile("_BUILD_PLAN/avos1.json", "utf8"),
  readFile("_BUILD_PLAN/AVOS Master Architectural Blueprint 1.json", "utf8"),
]);
const expanded = htmlToText(expandedHtml);
const masterFinal = jsonChunk(master, 170);
await mkdir(".repomix-cache", { recursive: true });

for (const batch of batches) {
  const itemPlan = planSlice(plan, batch.from, batch.to);
  const prompt = await readFile(
    `repomix/prompts/batch-${String(batch.id).padStart(2, "0")}-items-${batch.from}-${batch.to}.md`,
    "utf8"
  );
  const chunkNumbers = [
    ...itemPlan.matchAll(/avos1\.json`? \(Chunk (\d+)\)/g),
  ].map((m) => Number(m[1]));
  const avosTrail = [...new Set(chunkNumbers)]
    .map((index) => `## avos1.json chunk ${index}\n\n${jsonChunk(avos, index)}`)
    .join("\n\n");
  const originNames = [...itemPlan.matchAll(/`([^`]+\.txt)`/g)].map(
    (m) => m[1]
  );
  const origins = [];
  for (const name of new Set(originNames)) {
    try {
      origins.push(
        `## Origin: ${name}\n\n${await readFile(`_BUILD_PLAN/${name}`, "utf8")}`
      );
    } catch {
      origins.push(
        `## Missing origin named by plan: ${name}\n\nDo not substitute a similarly named file.`
      );
    }
  }
  const authority =
    `${prompt}\n\n# AUTHORITATIVE CONTEXT — ITEMS ${batch.from}-${batch.to}\n\n` +
    `The sections below are deliberately ordered from older/lower authority to newer/higher authority. Conversation sources come after CLAUDE.md because the conversations occurred after its last update. Within each item's Origin & Transition trail, read left-to-right and let the rightmost decision win.\n\n` +
    `# 1. Exact plan index and source-trail map\n\n${itemPlan}\n\n` +
    `# 2. Older CLAUDE.md baseline (relevant blocks)\n\n${relevantBlocks(claude, batch.words, 2, 130_000)}\n\n` +
    `# 3. Expanded-gaps supplemental decisions (HTML converted to text; relevant blocks)\n\n${relevantBlocks(expanded, batch.words, 1, 250_000)}\n\n` +
    `# 4. Appendix A1 supplemental decisions (relevant blocks)\n\n${relevantBlocks(appendix, batch.words, 2, 160_000)}\n\n` +
    `# 5. Newer complete available Origin & Transition conversation files\n\n${origins.join("\n\n")}\n\n` +
    `# 6. Newer explicit avos1 conversation chunks named by these items\n\n${avosTrail || "No numbered avos1 chunk in this batch."}\n\n` +
    `# 7. Final Master Blueprint conversation response\n\n${masterFinal}\n`;
  await writeFile(`.repomix-cache/authority-batch-${batch.id}.md`, authority);
}
