export interface BrowserFrameTreeNode {
  frame: { id: string };
  childFrames?: BrowserFrameTreeNode[];
}

/** Iterate only a bounded prefix of a provider-generated collection. */
export function* boundedValues<T>(items: readonly T[], maxItems: number): Generator<T> {
  const limit = Math.min(items.length, Math.max(0, Math.floor(maxItems)));
  for (let index = 0; index < limit; index++) yield items[index]!;
}

/** Bound both the output and traversal work for attacker-controlled nested frames. */
export function collectBoundedFrameIds(
  root: BrowserFrameTreeNode,
  maxFrames = 16,
  maxVisited = 64,
): string[] {
  const ids: string[] = [];
  const pending: BrowserFrameTreeNode[] = [root];
  let visited = 0;
  while (pending.length && ids.length < maxFrames && visited < maxVisited) {
    const current = pending.pop();
    if (!current) break;
    visited++;
    ids.push(current.frame.id);
    const children = current.childFrames ?? [];
    const capacity = maxVisited - visited - pending.length;
    for (let index = Math.min(children.length, capacity) - 1; index >= 0; index--) {
      const child = children[index];
      if (child) pending.push(child);
    }
  }
  return ids;
}
