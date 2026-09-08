import React from 'react';
import { AVOS_PROJECT_KINDS } from '../../../../packages/events/src/business-feature-kinds';

// Fallback/Mock Canvas Components for the Registry
const CodeWorkspaceCanvas = ({ projectId, ladderTier, domainPrompt }: any) => (
  <div className="p-4 bg-slate-900 text-slate-100 rounded border border-slate-700">
    <h3 className="font-semibold text-lg text-emerald-400">Code Workspace Canvas</h3>
    <p className="text-sm text-slate-400 mb-2">Project: <span className="font-mono text-white">{projectId}</span></p>
    <div className="bg-slate-950 p-2 rounded font-mono text-xs mb-3">
      Allowed Ladder Tiers: {ladderTier.join(', ')}
    </div>
    <div className="text-xs text-slate-300 bg-slate-800 p-2 rounded max-h-24 overflow-y-auto">
      <strong>System Prompt:</strong> {domainPrompt}
    </div>
  </div>
);

const DocumentRedlineCanvas = ({ projectId, ladderTier, domainPrompt }: any) => (
  <div className="p-4 bg-stone-900 text-stone-100 rounded border border-stone-700">
    <h3 className="font-semibold text-lg text-amber-400">Document Redline Canvas</h3>
    <p className="text-sm text-stone-400 mb-2">Project ID: <span className="font-mono text-white">{projectId}</span></p>
    <div className="text-xs text-stone-300 bg-stone-850 p-2 rounded mb-3">
      <strong>System Prompt:</strong> {domainPrompt}
    </div>
  </div>
);

const VoiceAgentCanvas = ({ projectId, ladderTier, domainPrompt }: any) => (
  <div className="p-4 bg-zinc-900 text-zinc-100 rounded border border-zinc-700">
    <h3 className="font-semibold text-lg text-cyan-400">Voice Phone Desk Canvas</h3>
    <p className="text-sm text-zinc-400 mb-2">Continuous Mode • Project ID: <span className="font-mono text-white">{projectId}</span></p>
    <div className="text-xs text-zinc-300 bg-zinc-850 p-2 rounded mb-3">
      <strong>System Prompt:</strong> {domainPrompt}
    </div>
  </div>
);

const ModelStudioCanvas = ({ projectId, ladderTier, domainPrompt }: any) => (
  <div className="p-4 bg-purple-950 text-purple-100 rounded border border-purple-800">
    <h3 className="font-semibold text-lg text-purple-400">Model Customization Canvas</h3>
    <p className="text-sm text-purple-300 mb-2">Project ID: <span className="font-mono text-white">{projectId}</span></p>
    <div className="text-xs text-purple-200 bg-purple-900 p-2 rounded mb-3">
      <strong>System Prompt:</strong> {domainPrompt}
    </div>
  </div>
);

const CustomerBotCanvas = ({ projectId, ladderTier, domainPrompt }: any) => (
  <div className="p-4 bg-indigo-950 text-indigo-100 rounded border border-indigo-800">
    <h3 className="font-semibold text-lg text-indigo-400">Customer Support Desk Canvas</h3>
    <p className="text-sm text-indigo-300 mb-2">Continuous Mode • Project ID: <span className="font-mono text-white">{projectId}</span></p>
    <div className="text-xs text-indigo-200 bg-indigo-900 p-2 rounded mb-3">
      <strong>System Prompt:</strong> {domainPrompt}
    </div>
  </div>
);

const GrowthEngineCanvas = ({ projectId, ladderTier, domainPrompt }: any) => (
  <div className="p-4 bg-teal-950 text-teal-100 rounded border border-teal-800">
    <h3 className="font-semibold text-lg text-teal-400">Growth & Marketing Canvas</h3>
    <p className="text-sm text-teal-300 mb-2">Project ID: <span className="font-mono text-white">{projectId}</span></p>
    <div className="text-xs text-teal-200 bg-teal-900 p-2 rounded mb-3">
      <strong>System Prompt:</strong> {domainPrompt}
    </div>
  </div>
);

const AppStudioCanvas = ({ projectId, ladderTier, domainPrompt }: any) => (
  <div className="p-4 bg-blue-950 text-blue-100 rounded border border-blue-800">
    <h3 className="font-semibold text-lg text-blue-400">No-Code Application Canvas</h3>
    <p className="text-sm text-blue-300 mb-2">Project ID: <span className="font-mono text-white">{projectId}</span></p>
    <div className="text-xs text-blue-200 bg-blue-900 p-2 rounded mb-3">
      <strong>System Prompt:</strong> {domainPrompt}
    </div>
  </div>
);

// Fallback registry matching viewportComponent names to React components
export const ViewportRegistry: Record<string, React.ComponentType<any>> = {
  CodeWorkspaceCanvas,
  DocumentRedlineCanvas,
  VoiceAgentCanvas,
  ModelStudioCanvas,
  CustomerBotCanvas,
  GrowthEngineCanvas,
  AppStudioCanvas
};

export function ProjectKindPanel({ project }: { project: any }) {
  if (!project) {
    return <div className="p-4 text-rose-500">No active project selected.</div>;
  }

  const kindKey = project.kind || "product_dev";
  const kind = AVOS_PROJECT_KINDS[kindKey];

  if (!kind) {
    return (
      <div className="p-4 bg-red-950 text-red-200 rounded border border-red-800">
        <h3 className="font-bold">Error: Unsupported Project Kind</h3>
        <p className="text-sm text-red-300">The project kind &apos;{kindKey}&apos; is not registered in the system.</p>
      </div>
    );
  }

  // Resolve the dynamic component
  const Viewport = ViewportRegistry[kind.viewportComponent] || CodeWorkspaceCanvas;

  return (
    <div className="viewport-container border border-slate-700 bg-slate-900/50 rounded-xl overflow-hidden p-6 shadow-xl space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800 pb-4">
        <div>
          <span className="text-xs uppercase font-semibold tracking-wider text-indigo-400 bg-indigo-950 px-2.5 py-1 rounded-full border border-indigo-900">
            {kind.lifecycle} Lifecycle
          </span>
          <h2 className="text-2xl font-bold text-white mt-2">{kind.label}</h2>
          <p className="text-slate-400 text-sm mt-1">{kind.description}</p>
        </div>
        
        <div className="flex flex-col items-end gap-1.5">
          <span className="text-xs text-slate-400">Execution Ladder Ceiling:</span>
          <div className="flex gap-1">
            {[1, 2, 3, 4, 5, 6].map((tier) => {
              const isAllowed = kind.allowedLadderTiers.includes(tier);
              return (
                <span
                  key={tier}
                  className={`text-xs font-bold w-6 h-6 flex items-center justify-center rounded-full transition-all duration-200 ${
                    isAllowed 
                      ? "bg-emerald-500 text-slate-950 ring-2 ring-emerald-400/30" 
                      : "bg-slate-800 text-slate-600 line-through"
                  }`}
                  title={isAllowed ? `Tier T${tier} Authorized` : `Tier T${tier} Forbidden`}
                >
                  T{tier}
                </span>
              );
            })}
          </div>
        </div>
      </div>

      {/* Main Viewport Content Block */}
      <div className="my-4">
        <Viewport 
          projectId={project.id}
          ladderTier={kind.allowedLadderTiers} 
          domainPrompt={kind.domainSystemPrompt}
        />
      </div>

      {/* Meta Specs Panel */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs bg-slate-950/60 p-4 rounded-lg border border-slate-800/80">
        <div>
          <h4 className="font-semibold text-slate-300 uppercase tracking-wider mb-2">System Linter Rules</h4>
          {kind.linterRules.length > 0 ? (
            <ul className="list-disc list-inside text-slate-400 space-y-1">
              {kind.linterRules.map((rule) => (
                <li key={rule} className="font-mono text-amber-400/90">{rule}</li>
              ))}
            </ul>
          ) : (
            <p className="text-slate-500 italic">No static analyses rules enforced for this kind.</p>
          )}
        </div>
        <div>
          <h4 className="font-semibold text-slate-300 uppercase tracking-wider mb-2">Default Runtime Casing</h4>
          <p className="text-slate-400 font-mono">
            {kind.defaultContainer || "serverless_edge_v8"}
          </p>
        </div>
      </div>
    </div>
  );
}
