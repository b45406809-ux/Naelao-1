import { mkdir, readFile, writeFile } from "node:fs/promises";

const batches = [
  [1, 19, "Foundation, storage, Git, and execution ladder"],
  [20, 24, "Runtime SDK, vault, WriteGuard, and virtual CLI"],
  [25, 38, "Connectors, capabilities, delegation, skills, and DLP"],
  [39, 46, "Agent kernel, prompts, memory, isolation, and compaction"],
  [47, 54, "Sovereign retrieval, citations, project MCP, and OAuth brokers"],
  [
    55,
    60,
    "Thread tiers, solo promotion, artifact CAS, locks, PRs, and rebases",
  ],
  [
    61,
    70,
    "Task governance, provenance, model races, presence, and actor identity",
  ],
  [71, 75, "Certified models, LoRA, air-gap enforcement, and terminal sleep"],
  [
    76,
    87,
    "Progressive canvas, project kinds, extensions, daemons, widgets, and workflows",
  ],
  [
    88,
    103,
    "Subagent workflows, webhook reliability, queues, replay, scheduling, and calendars",
  ],
  [104, 111, "Voice, telephony, private channels, and customer automation"],
  [
    112,
    119,
    "Credits, subscriptions, budgets, wallets, export, compilation, and security rating",
  ],
  [
    120,
    130,
    "Recipes, marketplace economics, partner distribution, and market radar",
  ],
];

// A cross-cutting transition may belong to several packs. Repeating its resolved
// contract is safer than asking a later implementation turn to infer it.
const architecturalDeltaBatches = new Map([
  [1, [1, 4, 7, 10]],
  [2, [3, 4, 12]],
  [3, [4, 10]],
  [4, [4, 6, 10]],
  [5, [7]],
  [6, [3, 10]],
  [7, [7, 12]],
  [8, [7]],
  [9, [4, 9]],
  [10, [9, 10]],
  [11, [10]],
  [12, [10]],
  [13, [3]],
  [14, [3, 10]],
  [15, [11]],
  [16, [10]],
  [17, [1, 6, 9]],
  [18, [9, 13]],
]);

const STOP_WORDS = new Set(
  "the a an and or to of in on for with from by as at is are be this that into via all per vs style level complete architecture system engine model native dynamic automated real actual".split(
    " "
  )
);

function itemBlocks(plan) {
  const matches = [...plan.matchAll(/^### (\d+)\. (.+)$/gm)];
  return matches.map((match, index) => ({
    number: Number(match[1]),
    title: match[2].trim(),
    text: plan
      .slice(match.index, matches[index + 1]?.index ?? plan.length)
      .trim(),
  }));
}

function architecturalDeltaBlocks(changelog) {
  const matches = [...changelog.matchAll(/^#### (\d+)\. (.+)$/gm)];
  return matches.map((match, index) => ({
    number: Number(match[1]),
    title: match[2].trim(),
    text: changelog
      .slice(match.index, matches[index + 1]?.index ?? changelog.length)
      .replace(/\n---\s*[\s\S]*$/m, "")
      .trim(),
  }));
}

function details(block) {
  return block.text.match(/^\* \*\*Details:\*\* (.+)$/m)?.[1]?.trim() ?? "";
}

function sourceNames(block) {
  return [
    ...block.text.matchAll(/`([^`]+\.(?:txt|json))`(?: \(Chunk (\d+)\))?/g),
  ].map((match) => ({
    name: match[1],
    chunk: match[2] === undefined ? undefined : Number(match[2]),
  }));
}

function keywords(block) {
  return [
    ...new Set(
      `${block.title} ${details(block)}`
        .toLowerCase()
        .match(/[a-z][a-z0-9_/-]{2,}/g) ?? []
    ),
  ]
    .filter((word) => !STOP_WORDS.has(word))
    .slice(0, 28);
}

function units(text) {
  return text
    .replace(/\r/g, "")
    .split(/\n(?=#{1,4}\s)|\n\s*---+\s*\n|\n\s*\n/)
    .map((unit) => unit.trim())
    .filter(
      (unit) =>
        unit.length >= 100 &&
        unit.length <= 8_000 &&
        !/^(?:I(?:'m| am) now|We need to|I'm focusing|I'm analyzing)/i.test(
          unit
        )
    );
}

function extractConstraints(text, terms, limit = 3, maxUnitChars = 8_000) {
  return units(text)
    .map((unit, index) => ({
      unit,
      index,
      score: terms.reduce(
        (score, term) => score + (unit.toLowerCase().includes(term) ? 1 : 0),
        0
      ),
    }))
    .filter(({ score }) => score >= 2)
    .sort((a, b) => b.score - a.score || b.index - a.index)
    .slice(0, limit)
    .sort((a, b) => a.index - b.index)
    .map(({ unit }) =>
      unit
        .slice(0, maxUnitChars)
        .replace(/CLAUDE\.md/gi, "the established architecture")
        .replace(/Appendix\s+[A-Z0-9.-]+/gi, "the established specification")
    );
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

function matrixRequirement(matrix, number) {
  const line = matrix
    .split("\n")
    .find((candidate) => candidate.startsWith(`| ${number} |`));
  if (!line) return "";
  const columns = line
    .split("|")
    .map((column) => column.trim())
    .filter(Boolean);
  if (columns.length < 5) return "";
  return [
    `Production entry: ${columns[2]}`,
    `Persistence/deployment: ${columns[3]}`,
    `Required observable verification: ${columns[4]}`,
  ].join("\n");
}

function commonPrompt(batch, from, to, focus) {
  return `# AI Studio implementation prompt — batch ${String(batch).padStart(2, "0")}, plan items ${from}–${to}

## Mission

Implement every requirement below end to end on the current accumulator branch. The cohesive focus
is **${focus}**. This prompt is self-contained: the feature definitions and retained implementation
constraints have already been extracted and reconciled into the final specification below.
Do not seek or cite external design context. Repository code is evidence of current
state, not evidence that a requirement is complete.

When present, the **Final reconciled architectural changes** section is the newest authority in
this prompt. Where it updates or replaces a numbered plan requirement or retained constraint,
implement the new architecture and do not preserve the superseded behavior for compatibility.

## Non-negotiable production rules

- Trace and use the real router → authorization → worker/Durable Object → scoped persistence or
  binding → shell path. A helper, type, schema, comment, standalone endpoint, mock, or UI placeholder
  is not an implementation.
- Scope durable state and cache/index keys by every applicable tenant, space, project, invoker/user,
  actor, extension/gadget, and policy version. Conceal inaccessible private resources exactly like
  absent resources. Security-sensitive resolution fails closed.
- Reauthorize immediately before external side effects, artifact commits, merges, connector calls,
  workflow dispatch, and sibling-project calls. Preserve the original human invoker through every
  delegation and background boundary.
- Add migrations and identical development/staging/production Wrangler bindings, service bindings,
  queues, workflows, R2/KV/Vectorize/Analytics resources, secrets documentation, rotations,
  backfills, limits, alarms, and rollback behavior required by the feature.
- Add the real shell experience where applicable, including loading, empty, error, unauthorized,
  offline/reconnecting, spectator/frozen, air-gapped, and completed states. Treat model and source
  data as untrusted; never execute supplied HTML, JavaScript, URLs, or expressions.
- Add contract, isolation, race, replay, expiry, crash/hibernation, fail-closed, and router-to-worker
  journeys using realistic Cloudflare behavior. Success-only mocks may not replace authorization,
  transactions, bindings, namespace isolation, alarms, WebSockets, or Workflow behavior.
- Update the requirements trace matrix only after verification. Mark an item IMPLEMENTED only when
  every required production boundary and meaningful integration/E2E evidence exists.

## Final resolved implementation specification
`;
}

function responseContract() {
  return `
## Required execution and response

1. Convert every numbered specification above into a file/request-path checklist before editing.
2. Implement in dependency order and reuse canonical workers/DOs rather than parallel helpers.
3. Return complete apply-ready unified diffs for every changed, created, or deleted file. Do not use
   ellipses, pseudo-code, TODO-only stubs, omitted boilerplate, or comments standing in for code.
4. Include exact migration, provisioning, secret rotation, rollout/backfill, rollback, and staging
   smoke commands.
5. Include exact test/typecheck/config-parity commands and the security/race assertions they prove.
6. Finish with an item-by-item release ledger: IMPLEMENTED, PARTIAL, or MISSING with honest gaps.

For automation, put exactly one machine-readable line before the first diff:
\`PHASE_STATUS: CONTINUE\` when another implementation turn is required, or
\`PHASE_STATUS: COMPLETE\` only when every numbered item and verification boundary is finished.
Place all prose after the diff or in a separate \`PHASE_NOTES\` section. A COMPLETE response with no
apply-ready diff is valid only when the current branch already satisfies and verifies every item.

Do not silently omit an item. If one response cannot hold the implementation, stop only after an
atomic, testable commit boundary and return a continuation prompt containing the remaining numbered
specifications and current verification state. Never claim completion because code merely compiles.
`;
}

const [
  plan,
  traceMatrix,
  avosRaw,
  claude,
  expandedHtml,
  appendix,
  architecturalChangelog,
] = await Promise.all([
  readFile("_BUILD_PLAN/plan.md", "utf8"),
  readFile("docs/requirements-trace-matrix.md", "utf8"),
  readFile("_BUILD_PLAN/avos1.json", "utf8"),
  readFile("CLAUDE.md", "utf8"),
  readFile("naelao_expanded_gaps_resolved.html", "utf8"),
  readFile(
    "docs/spec-appendix/A1-script-agents-and-space-assistants.md",
    "utf8"
  ),
  readFile("repomix/Update the batches.md", "utf8"),
]);
const avos = JSON.parse(avosRaw);
const expanded = htmlToText(expandedHtml);
const blocks = itemBlocks(plan);
const deltaBlocks = architecturalDeltaBlocks(architecturalChangelog);
if (deltaBlocks.length !== architecturalDeltaBatches.size) {
  throw new Error(
    `Expected ${architecturalDeltaBatches.size} architectural deltas, found ${deltaBlocks.length}`
  );
}
await mkdir("repomix/prompts", { recursive: true });

for (const [batchIndex, [from, to, focus]] of batches.entries()) {
  let prompt = commonPrompt(batchIndex + 1, from, to, focus);
  for (const block of blocks.filter(
    ({ number }) => number >= from && number <= to
  )) {
    const terms = keywords(block);
    const retained = [
      ...extractConstraints(claude, terms, 1, 2_500),
      ...extractConstraints(expanded, terms, 1, 2_500),
      ...extractConstraints(appendix, terms, 1, 2_500),
    ];
    for (const source of sourceNames(block)) {
      let text = "";
      if (source.name === "avos1.json" && source.chunk !== undefined) {
        text = avos.chunkedPrompt?.chunks?.[source.chunk]?.text ?? "";
      } else if (source.name.endsWith(".txt")) {
        try {
          text = await readFile(`_BUILD_PLAN/${source.name}`, "utf8");
        } catch {
          // The consolidated final definition remains authoritative when an archived source is absent.
        }
      }
      retained.push(...extractConstraints(text, terms));
    }
    const unique = [...new Set(retained)].slice(-10);
    prompt += `\n### ${block.number}. ${block.title}\n\n**Final behavior:** ${details(block)}\n`;
    const acceptance = matrixRequirement(traceMatrix, block.number);
    prompt += `\n**Production acceptance contract:**\n${acceptance || "Expose the feature through its authenticated production ingress; persist scoped state in the authoritative worker or Durable Object; declare every required binding in development, staging, and production; connect the applicable shell surface; and prove the complete journey with non-trivial integration and isolation tests."}\n`;
    if (unique.length) {
      prompt += `\n**Retained implementation constraints:**\n${unique.map((value) => `- ${value}`).join("\n")}\n`;
    }
  }
  const applicableDeltas = deltaBlocks.filter((delta) =>
    architecturalDeltaBatches.get(delta.number)?.includes(batchIndex + 1)
  );
  if (applicableDeltas.length) {
    prompt +=
      "\n## Final reconciled architectural changes (newest authority)\n\nThese are normative replacements, not optional context. Remove or migrate superseded behavior; do not implement both architectures.\n\n";
    prompt += applicableDeltas.map(({ text }) => text).join("\n\n");
    prompt += "\n";
  }
  prompt += responseContract();
  prompt = prompt.replace(/[\t \u00a0]+$/gm, "");
  await writeFile(
    `repomix/prompts/batch-${String(batchIndex + 1).padStart(2, "0")}-items-${from}-${to}.md`,
    prompt
  );
}
