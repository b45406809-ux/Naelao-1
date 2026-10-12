export interface ArtifactFieldRule {
  type: "string" | "number" | "boolean";
  required?: boolean;
  min?: number; max?: number;
  enum?: Array<string | number | boolean>;
}
export interface ArtifactLinterSpec { id: string; path: string; fields: Record<string, ArtifactFieldRule>; allowExtraFields?: boolean }
export interface ArtifactDiagnostic { ruleId: string; field: string; message: string }
export function parseArtifactLinters(value: unknown): ArtifactLinterSpec[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) throw new Error("invalid_artifact_linters");
  const ids = new Set<string>();
  for (const linter of value as ArtifactLinterSpec[]) {
    if (!linter || typeof linter.id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(linter.id) || ids.has(linter.id) || typeof linter.path !== "string" || !/^\/workspace\/(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+\.json$/.test(linter.path) || linter.path.split("/").some(p=>p===".."||p===".") || !linter.fields || typeof linter.fields !== "object" || Array.isArray(linter.fields) || Object.keys(linter.fields).length > 64 || Object.keys(linter).some(key=>!["id","path","fields","allowExtraFields"].includes(key))) throw new Error("invalid_artifact_linter");
    ids.add(linter.id);
    if (linter.allowExtraFields !== undefined && typeof linter.allowExtraFields !== "boolean") throw new Error("invalid_artifact_linter");
    for (const [field, rule] of Object.entries(linter.fields)) {
      if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(field) || ["constructor","prototype"].includes(field) || !rule || !["string","number","boolean"].includes(rule.type) || Object.keys(rule).some(key=>!["type","required","min","max","enum"].includes(key)) || (rule.required !== undefined && typeof rule.required !== "boolean") || [rule.min,rule.max].some(v=>v!==undefined && (typeof v!=="number"||!Number.isSafeInteger(v)||v<0)) || (rule.type === "boolean" && (rule.min !== undefined || rule.max !== undefined)) || (rule.min !== undefined && rule.max !== undefined && rule.min > rule.max) || (rule.enum !== undefined && (!Array.isArray(rule.enum)||rule.enum.length>64||rule.enum.some(v=>typeof v!==rule.type)))) throw new Error("invalid_artifact_field_rule");
    }
  }
  return structuredClone(value) as ArtifactLinterSpec[];
}

/** Structural JSON checks never interpret domain prose, run regex rules, or reveal field values. */
export function lintArtifact(path: string, content: string, linters: readonly ArtifactLinterSpec[]): ArtifactDiagnostic[] {
  const relevant = linters.filter(linter=>linter.path===path);
  if (!relevant.length) return [];
  let candidate: unknown;
  try { candidate=JSON.parse(content); } catch { return relevant.map(rule=>({ruleId:rule.id,field:"",message:"Valid JSON is required"})); }
  if (!candidate || typeof candidate!=="object" || Array.isArray(candidate)) return relevant.map(rule=>({ruleId:rule.id,field:"",message:"A JSON object is required"}));
  const data=candidate as Record<string,unknown>;const diagnostics: ArtifactDiagnostic[]=[];
  for (const rule of relevant) {
    for (const [field, spec] of Object.entries(rule.fields)) {
      const value=Object.hasOwn(data,field)?data[field]:undefined;
      const add=(message:string)=>diagnostics.push({ruleId:rule.id,field,message});
      if (value===undefined) { if(spec.required) add("Required field is missing");continue; }
      if(typeof value!==spec.type || typeof value==="number" && !Number.isFinite(value)) { add(`Expected ${spec.type}`);continue; }
      const measure=typeof value==="string"?value.length:typeof value==="number"?value:undefined;
      if(measure!==undefined && spec.min!==undefined && measure<spec.min) add("Below the structural minimum");
      if(measure!==undefined && spec.max!==undefined && measure>spec.max) add("Above the structural maximum");
      if(spec.enum && !spec.enum.includes(value as string|number|boolean)) add("Outside the allowed values");
    }
    if(!rule.allowExtraFields) for(const field of Object.keys(data)) if(!Object.hasOwn(rule.fields,field)) diagnostics.push({ruleId:rule.id,field,message:"Unexpected field"});
  }
  return diagnostics.slice(0,128);
}
