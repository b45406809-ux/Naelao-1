import { build } from "esbuild";
process.once("message", async ({ src, out }) => {
  try {
    // Bundling resolves user-supplied imports, so it uses the guest UID too. The supervisor
    // must never resolve an import with its own filesystem privileges.
    await build({ entryPoints: [src], outfile: out, bundle: true, format: "esm", platform: "node", logLevel: "silent" });
    process.send?.({ ok: true }, () => process.exit(0));
  } catch (error) { process.send?.({ ok: false, error: String(error).slice(0, 2000) }, () => process.exit(1)); }
});
