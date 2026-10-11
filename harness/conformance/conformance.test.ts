import { describe,expect,it } from "vitest";
import { assertAutonomousAstThreshold,executeIsolatedExpression,preciseTokenPatch,runConformance,serializeWorkflowStep,type ConformanceCase } from "./index.js";
import { planEnvironmentHandoff, routeRuntime, selectContainerBackend } from "../../packages/agent-sdk/src/launchpad-runtime.js";
const cases: ConformanceCase[]=[
 ...Array.from({length:10},(_,i)=>({id:`ast-${i}`,tier:1 as const,run:()=>preciseTokenPatch(`const value${i} = ${i};`,`value${i}`,`result${i}`).includes(`result${i}`)})),
 {id:"isolate",tier:2,run:async()=>await executeIsolatedExpression("a + b",{a:2,b:3})===5},
 {id:"workflow",tier:3,run:()=>serializeWorkflowStep({id:"s",input:{x:1}}).input.x===1},
 {id:"kitesurf-browser",tier:4,run:()=>{const route=routeRuntime({tool:"Browser"}); return route.tier===4&&route.engine==="kitesurf";}},
 {id:"chromium-browser",tier:5,run:()=>{const route=routeRuntime({tool:"Browser",needsScreenshot:true}); return route.tier===5&&route.engine==="chromium";}},
 {id:"container-backends",tier:6,run:()=>{const cloud=selectContainerBackend({native:true}); const browser=selectContainerBackend({browserAvailable:true}); const local=selectContainerBackend({gpu:true,localTunnelAuthorized:true}); let dependencyTransferDenied=false; try { planEnvironmentHandoff(browser,cloud,["package.json","package-lock.json","node_modules/ignored.js"]); } catch { dependencyTransferDenied=true; } const handoff=planEnvironmentHandoff(browser,cloud,["package.json","package-lock.json"]); return cloud==="cloudflare_container"&&browser==="webcontainer"&&local==="local_workstation"&&dependencyTransferDenied&&handoff.files.length===2; }},
];
describe("execution ladder conformance",()=>{
 it("benchmarks all six tiers and enforces >=90% AST accuracy",async()=>{const report=await runConformance(cases); for(const tier of [1,2,3,4,5,6] as const){expect(report.byTier[tier]?.total,`missing tier ${tier} coverage`).toBeGreaterThan(0); expect(report.byTier[tier]?.passed,`tier ${tier} case failed`).toBe(report.byTier[tier]?.total);} expect(()=>assertAutonomousAstThreshold(report)).not.toThrow();});
 it("rejects ambiguous AST patches",()=>expect(()=>preciseTokenPatch("x+x","x","y")).toThrow("ast_patch_requires_one_match"));
});
