import { describe, it, expect } from "vitest";
import { PRODUCT_END_USER_PATH_PATTERNS } from "../../workers/router/src/index.js";

// The Files and Artifacts side panels were reachable only for LISTING. The allowlist pattern
// covering them is anchored with `$`:
//
//   /^\/spaces\/([^/]+)\/assistant\/(memory|channels|sub-agents|files|capabilities)$/
//
// so `/assistant/files/<path>` (open a file) and `/assistant/artifacts` + `/assistant/artifacts/<id>`
// never matched, and a product end user got "Malformed JWT" — the router demanding a platform JWT
// because it didn't recognise the path as end-user reachable. Verified live: the file list returned
// data while reading any file from it 401'd, and the Artifacts panel could not load at all.
//
// These paths are identity-only at the router; authorization stays on the agents worker
// (requireEndUserBusinessMembership), same split as every sibling entry.

function reachable(path: string): boolean {
  return PRODUCT_END_USER_PATH_PATTERNS.some((re) => re.test(path));
}

const SPACE = "01f5290c-7340-46d3-9f10-e10eeba69e84";

describe("assistant side-panel routes a product end user must reach", () => {
  it("lists were already reachable and stay so", () => {
    expect(reachable(`/spaces/${SPACE}/assistant/files`)).toBe(true);
    expect(reachable(`/spaces/${SPACE}/assistant/memory`)).toBe(true);
    expect(reachable(`/spaces/${SPACE}/assistant/capabilities`)).toBe(true);
    expect(reachable(`/spaces/${SPACE}/assistant/channels`)).toBe(true);
    expect(reachable(`/spaces/${SPACE}/assistant/sub-agents`)).toBe(true);
  });

  it("opening a file — the exact live 401 — is reachable, including a nested path", () => {
    expect(reachable(`/spaces/${SPACE}/assistant/files/downloads/README.md`)).toBe(true);
    expect(reachable(`/spaces/${SPACE}/assistant/files/uploads/a/b/c.txt`)).toBe(true);
  });

  it("the Artifacts panel is reachable, both its list and a single artifact", () => {
    expect(reachable(`/spaces/${SPACE}/assistant/artifacts`)).toBe(true);
    expect(reachable(`/spaces/${SPACE}/assistant/artifacts/abc-123`)).toBe(true);
  });

  it("does not widen into unrelated assistant routes", () => {
    // Only the panels named above are opened up — anything else still needs a platform JWT.
    expect(reachable(`/spaces/${SPACE}/assistant/policy`)).toBe(false);
    expect(reachable(`/spaces/${SPACE}/assistant/skills/promote`)).toBe(false);
  });
});
