import { describe, expect, it, vi } from "vitest";
import { publishCompletedTask, type TaskPublication, type TaskPublicationHost } from "./task-publication.js";

function fixture(count = 1) {
  let journal: TaskPublication | undefined, main = "base";
  const host: TaskPublicationHost = {
    load: async () => journal && structuredClone(journal), save: async state => { journal = structuredClone(state); },
    prepare: vi.fn(async () => ({ baseCommit: "base", headCommit: "worker", changed: true })),
    memberCount: async () => count, mainHead: async () => main,
    merge: vi.fn(async expected => { expect(expected).toBe(main); main = "worker"; }),
    review: vi.fn(async () => ({ id: "review", thread_id: "team", status: "review_required" as const })),
  };
  return { host, setMain(value: string) { main = value; }, getJournal: () => journal };
}
describe("completed task publication", () => {
  it("routes shared project writes to review and replays the receipt without merging", async () => {
    const { host } = fixture(2);
    expect((await publishCompletedTask(host)).status).toBe("review_required");
    expect((await publishCompletedTask(host)).review?.id).toBe("review");
    expect(host.merge).not.toHaveBeenCalled(); expect(host.review).toHaveBeenCalledTimes(1);
  });
  it("recovers a committed merge whose response was lost without merging twice", async () => {
    const f = fixture(), original = f.host.merge;
    f.host.merge = vi.fn(async expected => { await original(expected); throw new Error("response lost"); });
    await expect(publishCompletedTask(f.host)).rejects.toThrow("response lost");
    expect(f.getJournal()?.status).toBe("prepared");
    expect((await publishCompletedTask(f.host)).status).toBe("merged");
    expect(f.host.merge).toHaveBeenCalledTimes(1); expect(f.host.prepare).toHaveBeenCalledTimes(1);
  });
  it("preserves changed main and rejects missing membership on recovery", async () => {
    const f = fixture(); f.setMain("other");
    await expect(publishCompletedTask(f.host)).rejects.toThrow("main_changed");
    f.host.memberCount = async () => 0;
    await expect(publishCompletedTask(f.host)).rejects.toThrow("membership_required");
    expect(f.host.merge).not.toHaveBeenCalled();
  });
  it("does not create a review or merge when workers made no changes", async () => {
    const { host } = fixture(); host.prepare = async () => ({ baseCommit: "base", headCommit: "base", changed: false });
    expect((await publishCompletedTask(host)).status).toBe("unchanged"); expect(host.review).not.toHaveBeenCalled();
    expect(host.merge).not.toHaveBeenCalled();
  });
});
