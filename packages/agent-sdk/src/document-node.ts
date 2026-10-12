/** Stable identifier shared by the Document canvas and the agent's guarded edit operation. */
export function documentClauseNodeId(path: string, index: number): string {
  if (!path || !Number.isSafeInteger(index) || index < 0) throw new Error("invalid_document_node");
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(`${path}\0${index}`)) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  }
  return `clause-${hash.toString(16)}`;
}
