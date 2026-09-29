export type ConformanceTier = 1 | 2 | 3 | 4 | 5 | 6;
export interface ConformanceCase { id: string; tier: ConformanceTier; run(): boolean | Promise<boolean> }
export interface ConformanceReport { passed: number; total: number; accuracy: number; byTier: Partial<Record<ConformanceTier,{passed:number;total:number}>> }
export const AUTONOMOUS_AST_THRESHOLD = 0.9;

/** Replace exactly one syntactic token, refusing ambiguous text edits. */
export function preciseTokenPatch(source: string, before: string, after: string): string {
  const escaped = before.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
  const matches = [...source.matchAll(new RegExp(`\\b${escaped}\\b`,"g"))];
  if (matches.length !== 1) throw new Error(`ast_patch_requires_one_match:${matches.length}`);
  return source.slice(0,matches[0]!.index)+after+source.slice(matches[0]!.index!+before.length);
}
export async function executeIsolatedExpression(expression: string, args: Readonly<Record<string,number>>): Promise<unknown> {
  if (!/^[\w\s+*/%().,?<>=!&|:-]+$/.test(expression) || /(?:constructor|prototype|global|process|import|eval)/.test(expression)) throw new Error("unsafe_isolate_expression");
  return Function(...Object.keys(args), `"use strict"; return (${expression});`)(...Object.values(args));
}
export function serializeWorkflowStep<T>(step: T): T {
  const encoded=JSON.stringify(step); if(encoded===undefined) throw new Error("step_not_serializable");
  return JSON.parse(encoded) as T;
}
export async function runConformance(cases: readonly ConformanceCase[]): Promise<ConformanceReport> {
  const byTier: ConformanceReport["byTier"]={}; let passed=0;
  for(const c of cases){ let ok=false; try { ok=await c.run(); } catch { ok=false; } const bucket=byTier[c.tier]??{passed:0,total:0}; bucket.total++; if(ok){bucket.passed++;passed++;} byTier[c.tier]=bucket; }
  return {passed,total:cases.length,accuracy:cases.length?passed/cases.length:0,byTier};
}
export function assertAutonomousAstThreshold(report: ConformanceReport): void {
  const tier=report.byTier[1]; const accuracy=tier&&tier.total?tier.passed/tier.total:0;
  if(accuracy<AUTONOMOUS_AST_THRESHOLD) throw new Error(`ast_conformance_below_threshold:${accuracy.toFixed(3)}`);
}
