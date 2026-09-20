import { mkdir, readFile, writeFile } from "node:fs/promises";

// Keep this range list aligned with build-prompts.mjs and verify-configs.mjs.

const batches = [
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

await mkdir(".repomix-cache", { recursive: true });
for (const [index, [from, to]] of batches.entries()) {
  const promptPath = `repomix/prompts/batch-${String(index + 1).padStart(2, "0")}-items-${from}-${to}.md`;
  const prompt = await readFile(promptPath, "utf8");
  if (!prompt.includes("Final resolved implementation specification")) {
    throw new Error(
      `${promptPath} is not a compiled self-contained implementation prompt`
    );
  }
  await writeFile(`.repomix-cache/authority-batch-${index + 1}.md`, prompt);
}
