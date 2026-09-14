import { readdir, readFile } from "node:fs/promises";

const expectedRanges = [
  [1, 19],
  [20, 24],
  [25, 38],
  [39, 46],
  [47, 54],
  [55, 60],
  [61, 70],
  [71, 75],
  [76, 87],
  [88, 103],
  [104, 111],
  [112, 119],
  [120, 130],
];
const files = (await readdir("repomix"))
  .filter((name) => /^batch-\d{2}-.+\.json$/.test(name))
  .sort();
if (files.length !== expectedRanges.length)
  throw new Error(`Expected 13 batch configs, found ${files.length}`);

for (const [index, file] of files.entries()) {
  const config = JSON.parse(await readFile(`repomix/${file}`, "utf8"));
  const output = config.output ?? {};
  if (
    output.compress === true ||
    output.removeComments !== false ||
    output.removeEmptyLines !== false
  )
    throw new Error(`${file} must retain complete source text`);
  if (
    output.showLineNumbers !== true ||
    output.style !== "xml" ||
    output.parsableStyle !== true
  )
    throw new Error(`${file} must emit parsable line-numbered XML`);
  if (config.tokenCount?.encoding !== "o200k_base")
    throw new Error(`${file} has the wrong AI Studio tokenizer`);
  if (!output.instructionFilePath?.endsWith(`authority-batch-${index + 1}.md`))
    throw new Error(`${file} is not paired with its authority trail`);
  const [from, to] = expectedRanges[index];
  const promptPath = `repomix/prompts/batch-${String(index + 1).padStart(2, "0")}-items-${from}-${to}.md`;
  const prompt = await readFile(promptPath, "utf8");
  for (const required of [
    "override it when they conflict",
    "Origin & Transition",
    "Unified diffs",
    "Migration/deployment operations",
    "Release ledger",
  ]) {
    if (!prompt.includes(required))
      throw new Error(`${promptPath} omits prompt contract: ${required}`);
  }
  for (const boundary of [
    "workers/router/**",
    "infra/migrations/**",
    "docs/requirements-trace-matrix.md",
  ])
    if (!config.include?.includes(boundary))
      throw new Error(`${file} omits cross-cutting boundary ${boundary}`);
}

for (let index = 1; index < expectedRanges.length; index++) {
  if (expectedRanges[index - 1][1] + 1 !== expectedRanges[index][0])
    throw new Error("Item ranges contain a gap");
}
if (expectedRanges[0][0] !== 1 || expectedRanges.at(-1)[1] !== 130)
  throw new Error("Item ranges do not cover plan items 1–130");

console.log(
  `Verified ${files.length} full-source Repomix configs covering plan items 1–130.`
);
