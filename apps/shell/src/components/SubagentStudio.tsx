"use client";

import * as React from "react";
import { compileNoCodeSubagent, type NoCodeCreatorClaims, type NoCodeSubagentManifest } from "@naelao/agent-sdk";

export interface StudioResource { id: string; label: string; minimumRoleRank: number }
export interface SubagentStudioProps {
  creatorClaims: NoCodeCreatorClaims;
  tools: StudioResource[];
  knowledgeBases: StudioResource[];
  onCompile(manifest: Readonly<NoCodeSubagentManifest>): void | Promise<void>;
}

/** Accessible no-code editor; unavailable capabilities remain visible but hardware-disabled. */
export function SubagentStudio({ creatorClaims, tools, knowledgeBases, onCompile }: SubagentStudioProps) {
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [selectedTools, setSelectedTools] = React.useState<string[]>([]);
  const [selectedKnowledge, setSelectedKnowledge] = React.useState<string[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const toggle = (value: string, values: string[], setter: React.Dispatch<React.SetStateAction<string[]>>) => setter(values.includes(value) ? values.filter(item => item !== value) : [...values, value]);
  const resources = (items: StudioResource[], selected: string[], setter: React.Dispatch<React.SetStateAction<string[]>>) => items.map(item => {
    const cleared = creatorClaims.roleRank >= item.minimumRoleRank && (items === tools ? creatorClaims.allowedTools : creatorClaims.knowledgeBaseIds).includes(item.id);
    return <label key={item.id} className="flex items-center gap-2 py-1"><input type="checkbox" checked={selected.includes(item.id)} disabled={!cleared} onChange={() => toggle(item.id, selected, setter)} /><span>{item.label}</span>{!cleared && <span className="text-xs text-neutral-500">Requires elevated clearance</span>}</label>;
  });
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setError(null);
    try {
      const id = `subagent_${name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")}`;
      await onCompile(compileNoCodeSubagent({ id, name, description, creatorRoleRank: creatorClaims.roleRank, allowedTools: selectedTools, knowledgeBaseIds: selectedKnowledge, triggers: [{ type: "manual" }] }, creatorClaims));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to compile subagent"); }
  };
  return <form onSubmit={submit} className="space-y-5" aria-label="Subagent studio">
    <div><label className="block text-sm font-medium" htmlFor="subagent-name">Name</label><input id="subagent-name" required value={name} onChange={event => setName(event.target.value)} className="w-full rounded border p-2" /></div>
    <div><label className="block text-sm font-medium" htmlFor="subagent-description">Description</label><textarea id="subagent-description" required value={description} onChange={event => setDescription(event.target.value)} className="w-full rounded border p-2" /></div>
    <fieldset><legend className="font-medium">Tools</legend>{resources(tools, selectedTools, setSelectedTools)}</fieldset>
    <fieldset><legend className="font-medium">Knowledge bases</legend>{resources(knowledgeBases, selectedKnowledge, setSelectedKnowledge)}</fieldset>
    {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    <button type="submit" className="rounded bg-black px-4 py-2 text-white">Compile subagent</button>
  </form>;
}
