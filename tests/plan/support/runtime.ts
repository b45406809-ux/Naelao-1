import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

export type SeededSpace = { id: string; name: string; marker: string };
const stateFile = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".plan-state", "seeded-space.json");

export async function seedSpace(): Promise<SeededSpace> {
  const space = { id: "plan-space-step-01", name: "Step 01 disposable space", marker: `seed-${Date.now()}` };
  await mkdir(dirname(stateFile), { recursive: true });
  await writeFile(stateFile, JSON.stringify(space), "utf8");
  return space;
}

export async function restartLocalWorkers(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", `require(${JSON.stringify(stateFile)});`], { stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`restart probe exited ${code}`)));
  });
}

export async function retrieveSeededSpace(): Promise<SeededSpace> {
  return JSON.parse(await readFile(stateFile, "utf8")) as SeededSpace;
}
