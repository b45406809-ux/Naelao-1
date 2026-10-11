import ts from "typescript";

/** Compile the developer execute(step, ctx) ABI for a Dynamic Workflow isolate. */
export function compileWorkflowEntrypoint(scriptSource: string): { className: string; source: string } {
  if (new TextEncoder().encode(scriptSource).byteLength > 262_144) throw new Error("workflow_source_limit");
  const tree = ts.createSourceFile("workflow.ts", scriptSource, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  let execute = false;
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node) || ts.isExportAssignment(node)
      || ts.isExportDeclaration(node) && node.moduleSpecifier) throw new Error("workflow_ambient_import_forbidden");
    if (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) throw new Error("workflow_default_export_forbidden");
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && ["eval", "require", "Function"].includes(node.expression.text))) throw new Error("workflow_dynamic_import_forbidden");
    if (ts.isFunctionDeclaration(node) && node.name?.text === "execute" && node.parameters.length === 2
      && node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) execute = true;
    ts.forEachChild(node, visit);
  };
  visit(tree);
  if (!execute) throw new Error("Workflow source must export execute(step, ctx)");
  const compiled = ts.transpileModule(scriptSource, { fileName: "workflow.ts", reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, sourceMap: false } });
  const errors = compiled.diagnostics?.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error) ?? [];
  if (errors.length) throw new Error("workflow_compile_error: " + errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, " ")).join("; ").slice(0, 2000));
  const trusted = [
    'import { WorkflowEntrypoint } from "cloudflare:workers";',
    'export class CompiledWorkflow extends WorkflowEntrypoint {',
    ' async run(event, nativeStep) {',
    '  const control = this.env.CONTROL, runId=event.payload.runId;',
    '  if (!control || !runId) throw new Error("workflow_control_unavailable");',
    '  const identity = await control.authorize(runId);',
    '  const ctx = Object.freeze({identity:Object.freeze({...identity}), params:await control.input(runId),',
    '   tools:Object.freeze({call:(stepKey,operation,params)=>control.effect(identity.runId,stepKey,operation,params)}),',
    '   storage:Object.freeze({putArtifact:(value)=>control.putArtifact(identity.runId,value),readArtifact:(pointer)=>control.readArtifact(identity.runId,pointer)})});',
    '  const step = Object.freeze({',
    '   do:async(name,optionsOrCallback,maybeCallback)=>{',
    '    const callback=typeof optionsOrCallback==="function"?optionsOrCallback:maybeCallback;',
    '    if(!callback) throw new Error("workflow_step_callback_required");',
    '    await control.authorize(identity.runId);',
    '    const pointer=await nativeStep.do(name,{retries:{limit:0,delay:0}},async()=>{',
    '     await control.authorize(identity.runId);return control.putArtifact(identity.runId,await callback());});',
    '    await control.authorize(identity.runId);return control.readArtifact(identity.runId,pointer);},',
    '   sleep:async(name,duration)=>{await control.state(runId,"sleeping");await nativeStep.sleep(name,duration);await control.state(runId,"running");},',
    '   sleepUntil:async(name,date)=>{await control.state(runId,"sleeping");await nativeStep.sleepUntil(name,date);await control.state(runId,"running");},',
    '   waitForEvent:async(name,options)=>{await control.state(runId,"waiting");const event=await nativeStep.waitForEvent(name,options);await control.state(runId,"running");return control.readArtifact(runId,event.payload);}});',
    '  try {await control.state(runId,"running");const result=await execute(step,ctx);',
    '   const pointer=await control.putArtifact(identity.runId,result==null?null:result);',
    '   await nativeStep.do("__naelao_terminal_success",async()=>{await control.finish(identity.runId,"succeeded",pointer);return {ok:true};});return pointer;',
    '  } catch(error) {await nativeStep.do("__naelao_terminal_failure",async()=>{',
    '   await control.finish(identity.runId,"failed",String(error&&error.message||error).slice(0,2000));return {ok:true};});throw error;}',
    ' }',
    '}',
  ];
  // Each developer step persists an immutable R2 pointer. No single outer execution step.
  return { className: "CompiledWorkflow", source: trusted.join("\n") + "\n" + compiled.outputText };
}
