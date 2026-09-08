export async function dispatchToProjectIndexers(
  spaceId: string, 
  projectId: string, 
  fileChange: { path: string; content: string },
  env: any
) {
  // 1. Query SpaceDO for installed Tier 3 gadgets in this project
  const spaceDO = await env.SPACES_WORKER.getSpace(spaceId);
  const gadgets = await spaceDO.listGadgets({ projectId, tier: 3 });

  // 2. Fan-out to each indexer gadget
  const pings = gadgets.map(gadget => {
    const gadgetDO = env.MICRO_APP_DO.get(env.MICRO_APP_DO.idFromName(`${spaceId}:${projectId}:${gadget.manifestId}`));
    return gadgetDO.fetch("http://internal/events/ingest", {
      method: "POST",
      body: JSON.stringify({
        type: "file_changed",
        filePath: fileChange.path,
        content: fileChange.content
      })
    });
  });

  await Promise.allSettled(pings);
}
