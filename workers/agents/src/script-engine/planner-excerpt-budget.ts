/** Host-owned cumulative response budget for persistent-planner workspace excerpts. */
export function createPlannerExcerptBudget(): (maxBytes: number) => boolean {
  let calls = 0;
  let bytes = 0;
  return (maxBytes) => {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 8 * 1024
      || calls >= 4 || bytes + maxBytes > 24 * 1024) return false;
    calls++;
    bytes += maxBytes;
    return true;
  };
}
