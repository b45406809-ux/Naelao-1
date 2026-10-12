/**
 * Load the TypeScript transpiler only when a guest compile is requested. TypeScript's
 * Node system probes `__filename` during module initialization to detect filesystem case
 * sensitivity. workerd is case-sensitive and has no Node module filename, so provide a
 * short-lived, nonexistent path for that probe and restore the global immediately after
 * module evaluation. The compiler APIs used here (`createSourceFile`, `transpileModule`)
 * operate on source strings and do not access the host filesystem.
 */
type TypeScriptCompiler = typeof import("typescript");

let compilerPromise: Promise<TypeScriptCompiler> | undefined;

export function loadTypeScriptCompiler(): Promise<TypeScriptCompiler> {
  if (!compilerPromise) {
    compilerPromise = (async () => {
      const target = globalThis as typeof globalThis & { __filename?: string };
      const previous = Object.getOwnPropertyDescriptor(target, "__filename");
      if (typeof target.__filename !== "string") {
        Object.defineProperty(target, "__filename", {
          configurable: true,
          value: "/__naelao_typescript_runtime__.js",
        });
      }
      try {
        return await import("typescript");
      } finally {
        if (previous) Object.defineProperty(target, "__filename", previous);
        else delete target.__filename;
      }
    })().catch((error) => {
      compilerPromise = undefined;
      throw error;
    });
  }
  return compilerPromise;
}
