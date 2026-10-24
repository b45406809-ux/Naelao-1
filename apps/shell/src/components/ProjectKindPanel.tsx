"use client";

import * as React from "react";
import { Button } from "@naelao/ui";
import {
  listWorkspaceFiles, readWorkspaceFile,
  type Project, type WorkspaceFile, type WorkspaceFileContent,
} from "@/lib/api";
import { FileViewer } from "@/components/FileViewer";
import { CanvasContainer } from "@/components/CanvasContainer";

type Creds = { sessionToken: string; endUserId: string };

// F-39 UI: read-only workspace file viewer — lists a project's R2 artifacts; clicking an .html file
// previews it in a sandboxed iframe, other text shows inline.
function WorkspaceFilesPanel({ spaceId, projectId, creds }: { spaceId: string; projectId: string; creds: Creds }) {
  const [files, setFiles] = React.useState<WorkspaceFile[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [open, setOpen] = React.useState<WorkspaceFileContent | null>(null);
  React.useEffect(() => {
    listWorkspaceFiles(spaceId, projectId, creds).then(setFiles).catch(() => setFiles([])).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceId, projectId]);

  async function openFile(path: string) {
    try { setOpen(await readWorkspaceFile(spaceId, projectId, path, creds)); }
    catch { setOpen({ path, content: "(could not read file)" }); }
  }

  if (loading) return <p style={{ color: "var(--text3)", fontSize: 13 }}>Loading files…</p>;
  if (files.length === 0) return <p style={{ color: "var(--text3)", fontSize: 13 }}>No files in this project's workspace yet — your agent's generated artifacts appear here.</p>;
  return (
    <>
      <div className="settings-block">
        {files.map((f) => (
          <div className="settings-row" key={f.path}>
            <div>
              <div className="settings-row-label">{f.path}</div>
              <div className="settings-row-sub">{(f.size / 1024).toFixed(1)} KB · {new Date(f.uploaded).toLocaleDateString()}</div>
            </div>
            <Button size="sm" variant="ghost" onClick={() => openFile(f.path)}>View</Button>
          </div>
        ))}
      </div>
      {open && (
        <div className="settings-block" style={{ marginTop: 12, padding: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <strong style={{ fontSize: 13 }}>{open.path}</strong>
            <Button size="sm" variant="ghost" onClick={() => setOpen(null)}>Close</Button>
          </div>
          {/* Step 4: multi-format viewer (PDF, images, Word/Excel, text/html/markdown/csv). */}
          <FileViewer file={open} />
        </div>
      )}
    </>
  );
}

/**
 * The mount point for the kernel's four layout primitives. Domain-specific canvases are selected
 * by the installed Space Template or extension, never by a hardcoded project kind.
 */
export function ProjectKindPanel({ project, spaceId, creds }: { project: Project; spaceId: string; creds: Creds }) {
  const canvasKind = ["DualPane", "CanvasFirst", "HeadlessPipeline", "TerminalFirst"].includes(project.kind ?? "");
  return (
    <>
      {canvasKind && <CanvasContainer project={project} spaceId={spaceId} creds={creds} />}
      {/* Domain-specific views are supplied by installed project extensions. */}

      {!canvasKind && <><div className="section-label" style={{ marginTop: 24 }}>Files</div><WorkspaceFilesPanel spaceId={spaceId} projectId={project.id} creds={creds} /></>}
    </>
  );
}
