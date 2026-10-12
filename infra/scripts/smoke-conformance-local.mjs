// Real local workerd + Worker Loader + isolated SQLite. No cloud credentials or resources.
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

const repository = resolve(import.meta.dirname, "../..");
const temporary = await mkdtemp(join(tmpdir(), "naelao-conformance-"));
const port = await new Promise((resolvePort, reject) => {
  const server = createServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => {
    const port = server.address().port; server.close(() => resolvePort(port));
  });
});
const entry = `import { ConformanceSandboxDO, ConformanceState } from ${JSON.stringify(join(repository,"workers/spaces/src/conformance-state.ts"))};
import { runStateDeltaSuite } from ${JSON.stringify(join(repository,"workers/spaces/src/state-delta-conformance.ts"))};
import { SpaceDO } from ${JSON.stringify(join(repository,"workers/spaces/src/do/SpaceDO.ts"))};
import { virtualFsRead } from ${JSON.stringify(join(repository,"workers/agents/src/script-engine/r2-workspace.ts"))};
export { ConformanceSandboxDO, ConformanceState, SpaceDO };
export default { async fetch(request,env,ctx) {
 if(new URL(request.url).pathname==='/health') return new Response('ready');
 const {blueprint,suite}=await request.json();
 if(new URL(request.url).pathname==='/seed-and-read') {
  const id=env.SPACE_DO.idFromName('hydration-test');const stub=env.SPACE_DO.get(id);
  const installed=await stub.fetch('http://space/blueprints/instantiate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({blueprint,target_space_id:'hydration-test'})});
  const result=await installed.json();if(!installed.ok)return Response.json(result,{status:installed.status});
  const content=await virtualFsRead({scriptsBucket:env.SCRIPTS_R2,spaceId:'hydration-test',projectId:result.projectIds[0]},'/workspace/worker.ts');
  return Response.json({content});
 }
 return Response.json(await runStateDeltaSuite(env,ctx.exports.ConformanceState,blueprint,suite));
} };`;
await writeFile(join(temporary, "entry.ts"), entry);
await writeFile(join(temporary, "wrangler.jsonc"), JSON.stringify({ name: "naelao-local-conformance-smoke", main: "entry.ts", compatibility_date: "2026-10-01", compatibility_flags: ["nodejs_compat"], worker_loaders: [{ binding: "LOADER" }], r2_buckets:[{binding:"SCRIPTS_R2",bucket_name:"local-conformance-fixtures"}], durable_objects: { bindings: [{ name: "CONFORMANCE_SANDBOX_DO", class_name: "ConformanceSandboxDO" },{name:"SPACE_DO",class_name:"SpaceDO"}] }, migrations: [{ tag: "v1", new_sqlite_classes: ["ConformanceSandboxDO","SpaceDO"] }] }));
const child = spawn("corepack", ["pnpm@9.12.0", "exec", "wrangler", "dev", "--local", "--config", join(temporary,"wrangler.jsonc"), "--port", String(port), "--inspector-port", "0"], { cwd: repository, env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, stdio: ["ignore","pipe","pipe"], detached: true });
let logs = ""; child.stdout.on("data", data => { logs = (logs + data).slice(-12000); }); child.stderr.on("data", data => { logs = (logs + data).slice(-12000); });
let exited = false; child.on("exit", () => { exited = true; });
function blueprint(source) { return { id:"bp-local", schemaVersion:"2.0", metadata:{}, templateCategory:"venture", requiredExtensions:[], requiredCredentials:[], projects:[{name:"Test",kind:"workspace",templateMode:"cowork_studio",viewports:{},systemPrompt:"Test",initialTasks:[],configuration:{conformance_entry:"/workspace/worker.ts"},starterFiles:[{path:"/workspace/worker.ts",content:source}]}]}; }
function suite() { return { fixtures: Array.from({length:50},(_,index)=>({id:`fixture-${index}`,projectIndex:0,input:{amount:index},seed:{schema:["CREATE TABLE accounts (id TEXT PRIMARY KEY, balance INTEGER NOT NULL)"],statements:[{sql:"INSERT INTO accounts VALUES (?,?)",args:["account",100]}],files:{}},assertions:[{sql:"SELECT balance FROM accounts WHERE id = ?",args:["account"],rows:[{balance:100-index}]}],expectedFiles:{"/workspace/receipt.txt":String(index)}})) }; }
async function run(source, cases = suite()) {
  const response = await fetch(`http://127.0.0.1:${port}/run`, {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({blueprint:blueprint(source),suite:cases}),signal:AbortSignal.timeout(120000)});
  const report = await response.json(); if(!response.ok) throw new Error(`Worker HTTP ${response.status}: ${JSON.stringify(report)}`); return report;
}
try {
  let ready = false;
  for(let attempt=0;attempt<120;attempt++) {
    if(exited) throw new Error("Local Worker exited before readiness");
    try { const response=await fetch(`http://127.0.0.1:${port}/health`, {signal:AbortSignal.timeout(1000)}); if(response.ok){ready=true;break;} } catch {}
    await delay(250);
  }
  if(!ready) throw new Error("Local Worker readiness timed out");
  const source = "export async function run(ctx) { await ctx.sql.exec('UPDATE accounts SET balance = balance - ? WHERE id = ?',ctx.input.amount,'account'); await ctx.files.write('/workspace/receipt.txt',String(ctx.input.amount)); }";
  const seeded=await fetch(`http://127.0.0.1:${port}/seed-and-read`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({blueprint:blueprint(source)}),signal:AbortSignal.timeout(15000)});
  const sample=await seeded.json();if(!seeded.ok || sample.content!==source)throw new Error(`Actual R2 hydration/VFS mismatch: ${JSON.stringify(sample)}`);
  console.log(JSON.stringify({check:"real-r2-hydration",readable:true}));
  const report = await run(source); console.log(JSON.stringify({check:"real-state-delta",report}));
  if(report.passed!==50) throw new Error("Actual worker SQL/file conformance did not pass all fixtures");
  const regressions=suite(); regressions.fixtures[0].assertions[0].rows=[{balance:999}];
  const failed=await run(source,regressions); console.log(JSON.stringify({check:"regression-blocked",passed:failed.passed,total:failed.total,diagnostics:failed.diagnostics}));
  if(failed.passed!==49 || failed.diagnostics[0]?.error!=="state_delta_mismatch") throw new Error("Host oracle did not detect regression");
  const malicious=await run("export async function run(ctx) { try { await ctx.sql.exec('DELETE FROM __oracle_files'); } catch {} await ctx.sql.exec('UPDATE accounts SET balance = balance - ? WHERE id = ?',ctx.input.amount,'account'); await ctx.files.write('/workspace/receipt.txt',String(ctx.input.amount)); }");
  console.log(JSON.stringify({check:"caught-capability-abuse",passed:malicious.passed,total:malicious.total,firstError:malicious.diagnostics[0]}));
  if(malicious.passed!==0 || malicious.diagnostics[0]?.error!=="fixture_capability_violation") throw new Error("Caught guest errors bypassed the oracle");
} catch (error) {
  console.error(logs); throw error;
} finally {
  try { process.kill(-child.pid, "SIGTERM"); } catch {}
  await Promise.race([new Promise(resolveExit=>child.once("exit",resolveExit)),delay(3000)]);
  if(!exited) try { process.kill(-child.pid,"SIGKILL"); } catch {}
  await rm(temporary,{recursive:true,force:true});
}
