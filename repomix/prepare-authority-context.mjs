import { mkdir, readFile, writeFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile("repomix/phases.json", "utf8"));
await mkdir(".repomix-cache", { recursive: true });
for (const phase of manifest.phases) {
  const prompt = await readFile(phase.prompt, "utf8");
  if (!prompt.includes("Final resolved implementation specification")) {
    throw new Error(`${phase.prompt} is not a compiled self-contained prompt`);
  }
  await writeFile(
    `.repomix-cache/authority-batch-${phase.phase}.md`,
    prompt,
  );
}
