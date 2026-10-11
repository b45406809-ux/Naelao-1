#!/usr/bin/env node
import { runBridge } from "./runtime.mjs";
runBridge(process.argv.slice(2)).then((result: unknown) => {
  if (result !== undefined) process.stdout.write(JSON.stringify(result) + "\n");
}).catch((error: unknown) => {
  process.stderr.write((error instanceof Error ? error.message : "Bridge failed") + "\n");
  process.exitCode = 1;
});
