// Runs only in a UID-10001, no-new-privileges child. Never import guest modules in the supervisor.
import { pathToFileURL } from "node:url";
process.once("message", async ({ modulePath, mode, args }) => {
  try {
    const mod = await import(pathToFileURL(modulePath).href);
    const fn = mode === "tests" ? mod.runTests : mod.run;
    if (typeof fn !== "function") throw new Error(mode === "tests" ? "runTests export required" : "run export required");
    const result = await fn(args ?? {}, { workspaceDir: "/workspace" });
    const encoded = JSON.stringify({ ok: true, result });
    if (Buffer.byteLength(encoded) > 2 * 1024 * 1024) throw new Error("container_result_limit");
    process.send?.(JSON.parse(encoded), () => process.exit(0));
  } catch (error) {
    const fullError = String(error);
    const encoded = JSON.stringify({ ok: false, error: fullError });
    const failure = Buffer.byteLength(encoded) <= 2 * 1024 * 1024 ? JSON.parse(encoded)
      : { ok: false, error: "container_error_limit: full error exceeded 2 MiB; unavailable beyond the execution limit", output_truncated: true };
    process.send?.(failure, () => process.exit(1));
  }
});
