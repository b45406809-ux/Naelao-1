// The Cloudflare worker tsconfig intentionally includes only Workers types. These declarations
// cover the Node built-ins used by the repository's SQLite-backed local test fixture.
declare module "node:module" {
  export function createRequire(url: string): (specifier: string) => unknown;
}

declare module "node:sqlite" {
  interface SQLiteStatement {
    get(...args: unknown[]): Record<string, unknown> | undefined;
    all(...args: unknown[]): Record<string, unknown>[];
    run(...args: unknown[]): { changes: number };
  }
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): SQLiteStatement;
  }
}

declare module "node:fs" {
  export function readFileSync(path: URL | string, encoding: "utf8"): string;
}

interface ImportMeta {
  readonly url: string;
}
