import React from "react";
import { GadgetViewportHost } from "./viewports/GadgetViewportHost";

interface Project {
  id: string;
  name: string;
  kind: string;
  viewportUrl?: string;
  description?: string;
}

interface Session {
  gatekeeperToken: string;
  user?: {
    name?: string;
    email?: string;
  };
}

interface ProjectKindPanelProps {
  project: Project;
  session: Session;
}

export function ProjectKindPanel({ project, session }: ProjectKindPanelProps) {
  // If the project has a Tier 2 Gadget assigned, use the Pluggable Host
  if (project.viewportUrl) {
    return (
      <GadgetViewportHost 
        src={project.viewportUrl} 
        projectId={project.id}
        token={session.gatekeeperToken} 
      />
    );
  }

  // Fallback to standard File Explorer / Readme if no Gadget is installed
  return <DefaultWorkspaceView project={project} />;
}

function DefaultWorkspaceView({ project }: { project: Project }) {
  return (
    <div className="flex flex-col h-full bg-slate-900 border border-slate-800 rounded-lg overflow-hidden text-slate-100">
      {/* Header */}
      <div className="px-6 py-4 border-b border-slate-800 bg-slate-950 flex justify-between items-center">
        <div>
          <h2 className="text-lg font-semibold text-white">{project.name}</h2>
          <p className="text-xs text-slate-400 font-mono mt-0.5">Project ID: {project.id}</p>
        </div>
        <span className="px-2.5 py-1 text-xs font-semibold bg-slate-800 border border-slate-700 text-slate-300 rounded-full font-mono uppercase">
          {project.kind}
        </span>
      </div>

      {/* Content Area */}
      <div className="flex-1 p-6 overflow-y-auto space-y-6">
        <div className="bg-slate-950 border border-slate-800 rounded-lg p-5">
          <h3 className="text-sm font-semibold text-slate-200 mb-2">Workspace Information</h3>
          <p className="text-sm text-slate-400 leading-relaxed">
            {project.description || "Welcome to your default project workspace. No viewport plugin is currently configured. You can interact with this project via the terminal, files panel, or register a custom pluggable viewport."}
          </p>
        </div>

        {/* Mock File Explorer Fallback */}
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-slate-300">Default File Explorer</h3>
          <div className="bg-slate-950 border border-slate-800 rounded-lg divide-y divide-slate-800/60 font-mono text-xs">
            <div className="flex items-center justify-between p-3 hover:bg-slate-900/50 transition">
              <div className="flex items-center gap-2">
                <svg className="h-4 w-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                <span>README.md</span>
              </div>
              <span className="text-slate-500">1.2 KB</span>
            </div>
            <div className="flex items-center justify-between p-3 hover:bg-slate-900/50 transition">
              <div className="flex items-center gap-2">
                <svg className="h-4 w-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                <span>project.config.json</span>
              </div>
              <span className="text-slate-500">420 B</span>
            </div>
          </div>
        </div>

        {/* Integration Instructions */}
        <div className="bg-indigo-950/20 border border-indigo-900/50 rounded-lg p-5">
          <div className="flex gap-3">
            <svg className="h-5 w-5 text-indigo-400 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div>
              <h4 className="text-sm font-semibold text-indigo-300">Custom Viewport Plugin Dev Tip</h4>
              <p className="text-xs text-indigo-200/70 mt-1 leading-relaxed">
                To link a visual editor to this workspace, register a Tier 2 Gadget instance with the SpaceDO database. The pluggable viewport engine will automatically pick up the gadget and load its custom dashboard layout.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
