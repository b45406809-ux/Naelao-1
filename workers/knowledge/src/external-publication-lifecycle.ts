/**
 * Prepare an atomic publication revision bump when a currently published Project document's
 * content changes or the document is removed. The owner must approve the new collection revision
 * before a Space-shared extension can use it again.
 */
export function revisionExternalPublicationsForDocument(
  db: D1Database,
  input: { tenantId: string; spaceId: string; projectId: string | null; documentId: string; updatedAt: string },
) {
  if (!input.projectId) return [];
  return [
    db.prepare(`UPDATE kb_external_publications SET revision=revision+1,
        mutation_token=lower(hex(randomblob(16))),updated_at=?
      WHERE tenant_id=? AND space_id=? AND project_id=? AND EXISTS (
        SELECT 1 FROM kb_external_publication_documents x WHERE x.publication_id=kb_external_publications.id
          AND x.tenant_id=kb_external_publications.tenant_id AND x.space_id=kb_external_publications.space_id
          AND x.project_id=kb_external_publications.project_id AND x.document_id=?
      )`).bind(input.updatedAt, input.tenantId, input.spaceId, input.projectId, input.documentId),
    db.prepare(`UPDATE kb_external_publication_documents SET publication_revision=(
        SELECT p.revision FROM kb_external_publications p WHERE p.id=kb_external_publication_documents.publication_id
          AND p.tenant_id=kb_external_publication_documents.tenant_id AND p.space_id=kb_external_publication_documents.space_id
          AND p.project_id=kb_external_publication_documents.project_id
      ) WHERE tenant_id=? AND space_id=? AND project_id=? AND publication_id IN (
        SELECT p.id FROM kb_external_publications p WHERE p.tenant_id=? AND p.space_id=? AND p.project_id=?
          AND EXISTS (SELECT 1 FROM kb_external_publication_documents x WHERE x.publication_id=p.id
            AND x.tenant_id=p.tenant_id AND x.space_id=p.space_id AND x.project_id=p.project_id AND x.document_id=?)
      )`).bind(input.tenantId, input.spaceId, input.projectId,
      input.tenantId, input.spaceId, input.projectId, input.documentId),
  ];
}
