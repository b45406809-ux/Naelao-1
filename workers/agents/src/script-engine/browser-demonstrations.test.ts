import { describe, it, expect, vi } from "vitest";
import {
  BrowserDemonstrationStore,
  validateDemoSteps,
  replayBrowserDemonstration,
  type BrowserDemoSkill,
} from "./browser-demonstrations.js";
import { browserDemonstrations } from "./prebuilt/browser-demonstrations.js";
import type { PrebuiltOpContext } from "./prebuilt/index.js";
import type { ScriptEngineEnv } from "./types.js";
class Bucket {
  objects = new Map<string, { value: string; etag: string }>();
  version = 0;
  async get(key: string) {
    const o = this.objects.get(key);
    return o
      ? {
          size: o.value.length,
          etag: o.etag,
          json: async () => JSON.parse(o.value),
        }
      : null;
  }
  async put(
    key: string,
    value: string,
    opts?: { onlyIf?: { etagDoesNotMatch?: string; etagMatches?: string } }
  ) {
    const existing = this.objects.get(key);
    if (opts?.onlyIf?.etagDoesNotMatch === "*" && existing) return null;
    if (opts?.onlyIf?.etagMatches && opts.onlyIf.etagMatches !== existing?.etag)
      return null;
    const etag = "v" + ++this.version;
    this.objects.set(key, { value, etag });
    return { etag };
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
  async list({ prefix = "" } = {}) {
    return {
      objects: [...this.objects.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((key) => ({ key })),
      truncated: false,
    };
  }
}
const scope = { spaceId: "space", projectId: "project", userId: "owner" };
const steps = [
  { type: "navigate" },
  {
    type: "type",
    target: { role: "textbox", name: "Search" },
    parameter: "query",
  },
  { type: "click", target: { role: "button", name: "Go" } },
  { type: "assert", target: { role: "button", name: "Done" } },
];
function setup() {
  const bucket = new Bucket(),
    env = {
      ...scope,
      runId: "run-1",
      scriptsBucket: bucket as unknown as R2Bucket,
    } as ScriptEngineEnv;
  return {
    bucket,
    env,
    store: new BrowserDemonstrationStore(bucket as unknown as R2Bucket, env),
  };
}
function runner() {
  let revision = 0;
  return vi.fn(async (name: string) => {
    if (name === "browser.navigate") return { session_id: "session" };
    if (name === "browser.observe")
      return {
        observation_revision: "r" + ++revision,
        elements: [
          {
            handle: "query-" + revision,
            role: "textbox",
            name: "Search",
            enabled: true,
            permittedActions: ["type"],
          },
          {
            handle: "go-" + revision,
            role: "button",
            name: "Go",
            enabled: true,
            permittedActions: ["click"],
          },
          {
            handle: "done-" + revision,
            role: "button",
            name: "Done",
            enabled: true,
            permittedActions: [],
          },
        ],
      };
    return {};
  });
}
describe("demonstration learning lifecycle", () => {
  it("stores only a private scoped draft and cannot enable untested work", async () => {
    const f = setup(),
      skill = await f.store.draft("search", "Find records", steps);
    expect(skill.status).toBe("draft");
    await expect(f.store.enable("search", true)).rejects.toThrow(
      "successful_test"
    );
    const other = new BrowserDemonstrationStore(
      f.bucket as unknown as R2Bucket,
      { ...scope, userId: "other" }
    );
    const project = new BrowserDemonstrationStore(
      f.bucket as unknown as R2Bucket,
      { ...scope, projectId: "elsewhere" }
    );
    expect(await other.read("search")).toBeNull();
    expect(await project.read("search")).toBeNull();
    expect([...f.bucket.objects.keys()]).toEqual([
      "spaces/space/assistant-learning/projects/project/users/owner/search.json",
    ]);
  });
  it("rejects literal secrets, arbitrary commands, handles and missing success assertions", () => {
    for (const invalid of [
      [
        { type: "navigate" },
        {
          type: "type",
          target: { role: "textbox", name: "Password" },
          parameter: "password",
        },
        { type: "assert", target: { role: "button", name: "Done" } },
      ],
      [
        { type: "navigate" },
        {
          type: "type",
          target: { role: "textbox", name: "Search" },
          text: "secret",
          parameter: "query",
        },
        { type: "assert", target: { role: "button", name: "Done" } },
      ],
      [{ type: "navigate" }, { type: "BASH", command: "curl evil" }],
      [
        { type: "navigate" },
        {
          type: "click",
          target: { role: "button", name: "Go" },
          handle: "old-handle",
        },
      ],
    ])
      expect(() => validateDemoSteps(invalid)).toThrow();
    expect(
      () =>
        new BrowserDemonstrationStore({} as R2Bucket, {
          spaceId: "../other",
          userId: "u",
        })
    ).toThrow();
    expect(
      () => new BrowserDemonstrationStore({} as R2Bucket, { spaceId: "s" })
    ).toThrow("authenticated_owner");
  });
  it("reobserves each target and fills dynamic values without persisting them", async () => {
    const f = setup(),
      skill = await f.store.draft("search", "", steps),
      run = runner();
    expect(
      await replayBrowserDemonstration(
        skill,
        {
          connectionId: "website",
          values: { query: "private text" },
          replayId: "replay",
        },
        run
      )
    ).toMatchObject({ ok: true, completed: 4 });
    const type = run.mock.calls.find(([n]) => n === "browser.type")!;
    expect(type[1]).toMatchObject({
      handle: "query-1",
      observation_revision: "r1",
      text: "private text",
      action_id: "replay:1",
    });
    const click = run.mock.calls.find(([n]) => n === "browser.click")!;
    expect(click[1]).toMatchObject({
      handle: "go-2",
      observation_revision: "r2",
    });
    expect(
      [...f.bucket.objects.values()].map((o) => o.value).join("")
    ).not.toContain("private text");
  });
  it("stops on ambiguous targets without clicking and closes the session", async () => {
    const f = setup(),
      skill = await f.store.draft("search", "", steps),
      run = runner();
    run.mockImplementation(async (name) =>
      name === "browser.navigate"
        ? { session_id: "s" }
        : name === "browser.observe"
          ? {
              observation_revision: "r",
              elements: [1, 2].map((i) => ({
                handle: "q" + i,
                role: "textbox",
                name: "Search",
                enabled: true,
                permittedActions: ["type"],
              })),
            }
          : {}
    );
    await expect(
      replayBrowserDemonstration(
        skill,
        {
          connectionId: "website",
          values: { query: "test" },
          replayId: "replay",
        },
        run
      )
    ).rejects.toThrow("ambiguous");
    expect(run.mock.calls.at(-1)![0]).toBe("browser.close");
    expect(run.mock.calls.some(([n]) => n === "browser.type")).toBe(false);
  });
  it("requires a real passing replay, then human enablement, and deduplicates repeated runs", async () => {
    const f = setup();
    await f.store.draft("search", "", steps);
    const run = runner(),
      ctx = { env: f.env, run } as unknown as PrebuiltOpContext;
    const args = {
      name: "search",
      connection_id: "website",
      values: { query: "test" },
    };
    await expect(
      browserDemonstrations.operations["skill.demo.run"]!(args, ctx)
    ).rejects.toThrow("not_enabled");
    await browserDemonstrations.operations["skill.demo.test"]!(args, ctx);
    expect((await f.store.read("search"))!.skill.status).toBe("validated");
    expect(
      browserDemonstrations.operations["skill.demo.enable"]
    ).toBeUndefined();
    await f.store.enable("search", true);
    await browserDemonstrations.operations["skill.demo.run"]!(args, ctx);
    const count = run.mock.calls.length;
    await browserDemonstrations.operations["skill.demo.run"]!(args, ctx);
    expect(run).toHaveBeenCalledTimes(count);
  });
  it("never calls a failed test verified or blindly repeats an interrupted replay", async () => {
    const f = setup();
    await f.store.draft("search", "", steps);
    const run = runner();
    run.mockRejectedValue(new Error("browser_action_reconciliation_required"));
    const ctx = { env: f.env, run } as unknown as PrebuiltOpContext,
      args = {
        name: "search",
        connection_id: "website",
        values: { query: "test" },
      };
    await expect(
      browserDemonstrations.operations["skill.demo.test"]!(args, ctx)
    ).rejects.toThrow("reconciliation_required");
    const calls = run.mock.calls.length;
    await expect(
      browserDemonstrations.operations["skill.demo.test"]!(args, ctx)
    ).rejects.toThrow("reconciliation_required");
    expect(run).toHaveBeenCalledTimes(calls);
    expect((await f.store.read("search"))!.skill.status).toBe("draft");
  });
  it("detects tampering and bounds concurrent draft creation", async () => {
    const f = setup(),
      results = await Promise.allSettled(
        Array.from({ length: 30 }, () => f.store.draft("search", "", steps))
      );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const entry = [...f.bucket.objects.entries()][0]!,
      data = JSON.parse(entry[1].value) as BrowserDemoSkill;
    data.steps[1] = {
      type: "click",
      target: { role: "button", name: "Different" },
    };
    entry[1].value = JSON.stringify(data);
    await expect(f.store.read("search")).rejects.toThrow("digest_mismatch");
  });
});
