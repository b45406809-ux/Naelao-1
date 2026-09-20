import { readFile, readdir } from "node:fs/promises";

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
const expectedDeltaBatches = new Map([
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
  const [from, to] = expectedRanges[index];
  const promptPath = `repomix/prompts/batch-${String(index + 1).padStart(2, "0")}-items-${from}-${to}.md`;
  if (output.instructionFilePath !== promptPath)
    throw new Error(`${file} is not paired with its tracked batch prompt`);
  const expectedOutput = `repomix/outputs/${file.replace(/\.json$/, ".xml")}`;
  if (output.filePath !== expectedOutput)
    throw new Error(
      `${file} must write its downloadable XML to ${expectedOutput}`
    );
  const prompt = await readFile(promptPath, "utf8");
  for (const required of [
    "This prompt is self-contained",
    "Final resolved implementation specification",
    "Final behavior:",
    "Production acceptance contract:",
    "Retained implementation constraints:",
    "Manual AI Studio hand-off contract",
    `repomix/patches/batch-${String(index + 1).padStart(2, "0")}.patch`,
    "must start with `diff --git`",
  ]) {
    if (!prompt.includes(required))
      throw new Error(`${promptPath} omits prompt contract: ${required}`);
  }
  const expectedDeltas = [...expectedDeltaBatches]
    .filter(([, batches]) => batches.includes(index + 1))
    .map(([delta]) => delta);
  if (
    expectedDeltas.length &&
    !prompt.includes("Final reconciled architectural changes")
  )
    throw new Error(`${promptPath} omits its architectural delta section`);
  for (const delta of expectedDeltas) {
    if (!prompt.includes(`#### ${delta}. `))
      throw new Error(`${promptPath} omits architectural delta ${delta}`);
  }
  for (let item = from; item <= to; item++) {
    const heading = `### ${item}. `;
    const itemStart = prompt.indexOf(heading);
    if (itemStart < 0) {
      throw new Error(`${promptPath} omits detailed plan item ${item}`);
    }
    const nextHeading = prompt.indexOf("\n### ", itemStart + heading.length);
    const itemSpec = prompt.slice(
      itemStart,
      nextHeading < 0 ? undefined : nextHeading
    );
    for (const required of [
      "**Final behavior:**",
      "**Production acceptance contract:**",
      "**Retained implementation constraints:**",
    ]) {
      if (!itemSpec.includes(required)) {
        throw new Error(`${promptPath} item ${item} omits ${required}`);
      }
    }
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

for (const delta of expectedDeltaBatches.keys()) {
  const covered = files.some((_, index) =>
    expectedDeltaBatches.get(delta)?.includes(index + 1)
  );
  if (!covered)
    throw new Error(`Architectural delta ${delta} has no owning batch`);
}

console.log(
  `Verified ${files.length} full-source Repomix configs covering plan items 1–130.`
);
