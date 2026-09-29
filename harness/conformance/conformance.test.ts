import { describe,expect,it } from "vitest";
import { assertAutonomousAstThreshold,executeIsolatedExpression,preciseTokenPatch,runConformance,serializeWorkflowStep,type ConformanceCase } from "./index.js";
const cases: ConformanceCase[]=[
 ...Array.from({length:10},(_,i)=>({id:`ast-${i}`,tier:1 as const,run:()=>preciseTokenPatch(`const value${i} = ${i};`,`value${i}`,`result${i}`).includes(`result${i}`)})),
 {id:"isolate",tier:2,run:async()=>await executeIsolatedExpression("a + b",{a:2,b:3})===5},
 {id:"workflow",tier:3,run:()=>serializeWorkflowStep({id:"s",input:{x:1}}).input.x===1},
];
describe("execution ladder conformance",()=>{
 it("benchmarks tiers 1-3 and enforces >=90% AST accuracy",async()=>{const report=await runConformance(cases); expect(report.byTier[2]?.passed).toBe(1); expect(report.byTier[3]?.passed).toBe(1); expect(()=>assertAutonomousAstThreshold(report)).not.toThrow();});
 it("rejects ambiguous AST patches",()=>expect(()=>preciseTokenPatch("x+x","x","y")).toThrow("ast_patch_requires_one_match"));
});
