import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";

const batches = [
  [1,4,"Hierarchy, isolation, and project-anchored automation",1], [5,7,"Artifact Git, isolate workspace, and namespace separation",1],
  [8,13,"Execution ladder, hypervisor, synchronization, sleep, and Pyodide",2], [14,19,"Browser/container bridge, forks, time machine, and blame",2],
  [20,24,"Runtime SDK, vault, WriteGuard, and virtual CLI",3], [25,33,"Connector aliases, authorization, channels, and delegation",3],
  [34,38,"Skills, demonstrations, progressive disclosure, hooks, and DLP",3], [39,46,"Universal kernel, role firewall, goals, memory, and compaction",4],
  [47,52,"Scoped retrieval, Cohere ingestion, grounding, and citations",5], [53,54,"Project MCP mesh and managed OAuth brokers",5],
  [55,56,"Four thread tiers and lossless solo promotion",6], [57,60,"Artifact CAS, locks, trusted PRs, and rebases",6],
  [61,66,"Task leases, spectators, intent/RFC governance, and alerts",7], [67,70,"Provenance, model races, presence, and invoker actors",7],
  [71,75,"Model certification, LoRA, local inference, air-gap, and sleep",8], [76,79,"Display modes and seven canvas kinds",9],
  [80,84,"Extensions, gadgets, daemons, tree-sitter, and MCP exposure",9], [85,87,"MCP-UI, safe widgets, and workflow classes",9],
  [88,91,"Asymmetric subagents and durable workflow harness",10], [92,99,"Authenticated automation ingress and failure defenses",10],
  [100,103,"Scheduling, receipts, calendar connector, and slot mutex",10], [104,111,"Voice, executive, and quarantined customer channels",11],
  [112,115,"Credit metering, subscriptions, budgets, and self-funding",12], [116,119,"Venture export, scrubbing, blueprint compilation, and security gate",12],
  [120,124,"Marketplace recipes, tiers, pricing, and attribution",13], [125,130,"Cycle ledgers, price floors, graduation, partner portal, and radar",13],
];

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

const [plan, traceMatrix, avosRaw, claude, expandedHtml, appendix, evolutionaryDelta] =
  await Promise.all([
    readFile("_BUILD_PLAN/plan.md", "utf8"),
    readFile("docs/requirements-trace-matrix.md", "utf8"),
    readFile("_BUILD_PLAN/avos1.json", "utf8"),
    readFile("CLAUDE.md", "utf8"),
    readFile("naelao_expanded_gaps_resolved.html", "utf8"),
    readFile(
      "docs/spec-appendix/A1-script-agents-and-space-assistants.md",
      "utf8"
    ),
    readFile("_BUILD_PLAN/EVOLUTIONARY_ARCHITECTURAL_CHANGELOG.md", "utf8"),
  ]);
const avos = JSON.parse(avosRaw);
const expanded = htmlToText(expandedHtml);
const blocks = itemBlocks(plan);
await mkdir("repomix/prompts", { recursive: true });
for (const file of await readdir("repomix/prompts")) {
  if (/^batch-\d{2}-items-\d+-\d+\.md$/.test(file)) await unlink(`repomix/prompts/${file}`);
}

for (const [batchIndex, [from, to, focus]] of batches.entries()) {
  let prompt = `${commonPrompt(batchIndex + 1, from, to, focus)}\n## Newest cross-cutting architectural delta (overrides conflicts)\n\n${evolutionaryDelta}\n`;
  for (const block of blocks.filter(
    ({ number }) => number >= from && number <= to
  )) {
    const terms = keywords(block);
    const retained = [
      ...extractConstraints(claude, terms, 1, 700),
      ...extractConstraints(expanded, terms, 1, 700),
      ...extractConstraints(appendix, terms, 1, 700),
      ...extractConstraints(evolutionaryDelta, terms, 2, 1_200),
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
      retained.push(...extractConstraints(text, terms, 1, 900));
    }
    const unique = [...new Set(retained)].slice(-4);
    prompt += `\n### ${block.number}. ${block.title}\n\n**Final behavior:** ${details(block)}\n`;
    const acceptance = matrixRequirement(traceMatrix, block.number);
    prompt += `\n**Production acceptance contract:**\n${acceptance || "Expose the feature through its authenticated production ingress; persist scoped state in the authoritative worker or Durable Object; declare every required binding in development, staging, and production; connect the applicable shell surface; and prove the complete journey with non-trivial integration and isolation tests."}\n`;
    if (unique.length) {
      prompt += `\n**Retained implementation constraints:**\n${unique.map((value) => `- ${value}`).join("\n")}\n`;
    }
  }
  prompt += responseContract();
  prompt = prompt.replace(/[\t \u00a0]+$/gm, "");
  await writeFile(
    `repomix/prompts/batch-${String(batchIndex + 1).padStart(2, "0")}-items-${from}-${to}.md`,
    prompt
  );
}

await writeFile("repomix/phases.json", `${JSON.stringify({
  schema_version: 3,
  target_input_tokens: 32_000,
  hard_input_tokens: 96_000,
  phases: batches.map(([from, to, focus, macroProfile], index) => ({
    phase: index + 1, slice_id: `slice-${String(index + 1).padStart(2, "0")}`, from, to, focus,
    prompt: `repomix/prompts/batch-${String(index + 1).padStart(2, "0")}-items-${from}-${to}.md`,
    macro_profile: macroProfile,
    depends_on: index === 0 ? [] : [index],
  })),
}, null, 2)}\n`);
