export interface TaskPublication {
  status: "prepared" | "merged" | "review_required" | "unchanged";
  baseCommit: string; headCommit: string;
  review?: { id: string; thread_id: string | null; status: "review_required"; card?: Record<string, unknown> };
}
export interface TaskPublicationHost {
  load(): Promise<TaskPublication | undefined>;
  save(state: TaskPublication): Promise<void>;
  prepare(): Promise<{ baseCommit: string; headCommit: string; changed: boolean }>;
  memberCount(): Promise<number>;
  mainHead(): Promise<string>;
  merge(expectedHead: string): Promise<void>;
  review(): Promise<NonNullable<TaskPublication["review"]>>;
}

/** Publish only a completed root task. A durable intent precedes any merge/review effect. */
export async function publishCompletedTask(host: TaskPublicationHost): Promise<TaskPublication> {
  let state = await host.load();
  if (state && state.status !== "prepared") return state;
  if (!state) {
    const prepared = await host.prepare();
    state = { status: prepared.changed ? "prepared" : "unchanged", baseCommit: prepared.baseCommit, headCommit: prepared.headCommit };
    await host.save(state);
    if (state.status === "unchanged") return state;
  }
  const count = await host.memberCount();
  if (!Number.isSafeInteger(count) || count < 1) throw new Error("task_publication_membership_required");
  // Recheck current membership even on recovery: a formerly solo project may now be shared.
  if (count > 1) {
    state = { ...state, status: "review_required", review: await host.review() };
  } else {
    const current = await host.mainHead();
    if (current !== state.headCommit) {
      if (current !== state.baseCommit) throw new Error("task_publication_main_changed_needs_review");
      await host.merge(state.baseCommit);
    }
    state = { ...state, status: "merged" };
  }
  await host.save(state);
  return state;
}
