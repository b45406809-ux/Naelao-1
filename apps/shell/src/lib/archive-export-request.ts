const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export interface ArchiveExportRequestStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function spaceArchiveExportRequestKey(spaceId: string, endUserId: string): string {
  return `naelao:space-archive-export:${encodeURIComponent(spaceId)}:${encodeURIComponent(endUserId)}`;
}

export function readPendingSpaceArchiveExportRequest(
  storage: Pick<ArchiveExportRequestStorage, "getItem">,
  spaceId: string,
  endUserId: string,
): string | null {
  const value = storage.getItem(spaceArchiveExportRequestKey(spaceId, endUserId));
  return value && REQUEST_ID_PATTERN.test(value) ? value : null;
}

export function getOrCreateSpaceArchiveExportRequest(
  storage: Pick<ArchiveExportRequestStorage, "getItem" | "setItem">,
  spaceId: string,
  endUserId: string,
  createId: () => string = () => crypto.randomUUID(),
): string {
  const key = spaceArchiveExportRequestKey(spaceId, endUserId);
  const existing = storage.getItem(key);
  if (existing && REQUEST_ID_PATTERN.test(existing)) return existing;
  const requestId = createId();
  if (!REQUEST_ID_PATTERN.test(requestId)) throw new Error("archive_export_request_id_invalid");
  storage.setItem(key, requestId);
  return requestId;
}

export function clearPendingSpaceArchiveExportRequest(
  storage: Pick<ArchiveExportRequestStorage, "removeItem">,
  spaceId: string,
  endUserId: string,
): void {
  storage.removeItem(spaceArchiveExportRequestKey(spaceId, endUserId));
}
