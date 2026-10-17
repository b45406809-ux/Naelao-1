import type tsTypes from "typescript";
import { loadTypeScriptCompiler } from "./typescript-runtime.js";

export interface CompiledCode { readonly digest: string; readonly javascript: string; readonly bytes: number }
const cache = new Map<string, CompiledCode>();
let cacheBytes = 0;
const MAX_CACHE_BYTES = 4 * 1024 * 1024;

export async function compileDynamicCode(source: string, language: "javascript" | "typescript" = "typescript"): Promise<CompiledCode> {
  const ts = await loadTypeScriptCompiler();
  if (new TextEncoder().encode(source).byteLength > 262_144) throw new Error("code_source_limit");
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`v1:${ts.version}:${language}:${source}`));
  const digest = Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, "0")).join("");
  const cached = cache.get(digest);
  if (cached) return cached;
  const file = ts.createSourceFile(language === "javascript" ? "guest.js" : "guest.ts", source, ts.ScriptTarget.ES2022, true,
    language === "javascript" ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  let hasRun = false;
  const visit = (node: tsTypes.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node) || ts.isExportDeclaration(node) && node.moduleSpecifier)
      throw new Error("code_dependency_not_declared: use a pinned capability/package artifact instead of ambient imports");
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && ["eval", "require", "Function"].includes(node.expression.text)))
      throw new Error("code_dynamic_import_forbidden");
    if (ts.isExportAssignment(node) || ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) throw new Error("code_default_export_forbidden");
    if (ts.isFunctionDeclaration(node) && node.name?.text === "run" && node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) hasRun = true;
    if (ts.isVariableStatement(node) && node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) && node.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === "run")) hasRun = true;
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!hasRun) throw new Error("code_run_export_required");
  const compiled = ts.transpileModule(source, { fileName: language === "javascript" ? "guest.js" : "guest.ts", reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, isolatedModules: true, sourceMap: false } });
  const errors = compiled.diagnostics?.filter((d) => d.category === ts.DiagnosticCategory.Error) ?? [];
  if (errors.length) throw new Error(`code_compile_error: ${errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, " ")).join("; ").slice(0, 2000)}`);
  const bytes = new TextEncoder().encode(compiled.outputText).byteLength;
  while (cacheBytes + bytes > MAX_CACHE_BYTES && cache.size) {
    const key = cache.keys().next().value!;
    cacheBytes -= cache.get(key)!.bytes; cache.delete(key);
  }
  const artifact = Object.freeze({ digest, javascript: compiled.outputText, bytes });
  cache.set(digest, artifact); cacheBytes += bytes;
  return artifact;
}

/** This module runs before guest module evaluation. References used by the trusted harness
 * are captured before guest code can modify globals. Network remains blocked by the provider. */
export const ISOLATE_POLICY_MODULE = `
export const encode = JSON.stringify.bind(JSON);
export const parse = JSON.parse.bind(JSON);
export const freeze = Object.freeze.bind(Object);
export const jsonResponse = Response.json.bind(Response);
const encoder = new TextEncoder();
const encodeBytes = encoder.encode.bind(encoder);
export const byteLength = (s) => encodeBytes(s).byteLength;
`;

export function buildGuestHarness(outputBytes: number): string {
  return `import { encode, freeze, jsonResponse, byteLength } from './policy.js';
import { run } from './guest.js';
export default {
  async fetch(request, env) {
    const { args } = await request.json();
    const rpc = env.__RPC__;
    const call = async (name, input) => {
      if (!rpc) throw new Error('code_capability_denied:' + name);
      return rpc.call(name, input == null ? null : input);
    };
    const ctx = freeze({
      rpc: call,
      storage: freeze({ read: (path) => call('storage.read', {path}), write: (path,content,expectedHash) => call('storage.write', {path,content,expectedHash}), list: () => call('storage.list', {}) }),
      tools: freeze({ call: (operation,params) => call('tool:' + operation, params || {}) }),
      proxy: freeze({ request: (input) => call('proxy.request', input) }),
      ...(env.__PROJECT_ID__ ? {project: freeze({id:env.__PROJECT_ID__})} : {space: freeze({id:env.__SPACE_ID__})})
    });
    try {
      const result = await run(args, ctx);
      const encoded = encode(result == null ? null : result);
      if (byteLength(encoded) > ${outputBytes}) throw new Error('code_output_limit');
      return jsonResponse({ok:true,result});
    } catch (error) { return jsonResponse({ok:false,error:String(error && error.message || error)}); }
  }
};`;
}

/** Public channel handlers receive no RPC bindings, scope IDs, storage, tools, or proxy. Replies
 * are captured in memory and returned to the trusted host, which performs the provider send. */
export function buildChannelGuestHarness(outputBytes: number): string {
  return `import { encode, parse, freeze, jsonResponse, byteLength } from './policy.js';
import { run } from './guest.js';
export default {
  async fetch(request) {
    const { args, channel } = await request.json();
    const replies = [];
    const answerRequests = [];
    const sessionUpdates = [];
    const channelSession = channel.session ? freeze({
      get: async()=>parse(encode(channel.session.state)),
      set: async(value)=>{
        if (sessionUpdates.length >= 1) throw new Error('channel_session_write_limit');
        if (value !== null && (value === undefined || typeof value === 'function' || typeof value === 'symbol')) throw new Error('channel_session_value_invalid');
        const encoded = encode(value);
        if (byteLength(encoded) > channel.session.maxBytes) throw new Error('channel_session_size_limit');
        sessionUpdates.push(value);
        return freeze({saved:true});
      }
    }) : undefined;
    const ctx = freeze({channel:freeze({
      provider:channel.provider,
      event:freeze(channel.event),
      conversation:freeze({id:channel.conversation.id}),
      ...(channelSession ? {session:channelSession} : {}),
      answer:async(input)=>{
        if (!input || typeof input.question !== 'string' || !input.question.trim() || input.question.length > 2000) throw new Error('channel_answer_invalid');
        if (answerRequests.length >= 1) throw new Error('channel_answer_limit');
        answerRequests.push(input.question.trim());
        return freeze({answerId:'queued'});
      },
      reply:async(message)=>{
        if (!message || typeof message.text !== 'string' || !message.text.trim() || message.text.length > 2000) throw new Error('channel_reply_invalid');
        if (replies.length >= 1) throw new Error('channel_reply_limit');
        replies.push(message.text.trim());
        return freeze({messageId:'queued'});
      }
    })});
    try {
      const result = await run(args, ctx);
      const body = {ok:true,result:result == null ? null : result,replies,answerRequests,...(sessionUpdates.length ? {sessionUpdate:sessionUpdates[0]} : {})};
      const encoded = encode(body);
      if (byteLength(encoded) > ${outputBytes}) throw new Error('code_output_limit');
      return jsonResponse(body);
    } catch (error) { return jsonResponse({ok:false,error:String(error && error.message || error)}); }
  }
};`;
}

/** Python is a provider-owned Wasm runtime. No remote Pyodide/CDN bootstrap, warm interpreter
 * state, host Python process, or source-string native heuristic is used. */
export function buildPythonHarness(outputBytes: number): string {
  return `from workers import WorkerEntrypoint, Response
import io, json, traceback, contextlib

class Default(WorkerEntrypoint):
    async def fetch(self, request):
        payload = await request.json()
        args = payload.to_py() if hasattr(payload, 'to_py') else dict(payload)
        params = args.get('args', {})
        class BoundedOutput(io.StringIO):
            def write(self, value):
                if len((self.getvalue() + value).encode('utf-8')) > ${outputBytes}:
                    raise RuntimeError('code_output_limit')
                return super().write(value)
        stdout, stderr = BoundedOutput(), BoundedOutput()
        namespace = {'__name__': '__guest__', 'args': params.get('input', {})}
        try:
            code = compile(str(params.get('code', '')), '<guest>', 'exec')
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                exec(code, namespace, namespace)
                result = namespace.get('result', None)
            body = {'ok': True, 'result': {'stdout': stdout.getvalue(), 'stderr': stderr.getvalue(), 'result': result}}
            encoded = json.dumps(body)
            if len(encoded.encode('utf-8')) > ${outputBytes}: raise RuntimeError('code_output_limit')
            return Response(encoded, headers={'content-type': 'application/json'})
        except (ImportError, ModuleNotFoundError) as error:
            return Response(json.dumps({'ok': False, 'error': 'code_dependency_unavailable', 'capability_error': {'code': 'unsupported_dependency', 'capability': str(getattr(error, 'name', None) or 'python-package'), 'required_tier': 6}}), headers={'content-type': 'application/json'})
        except Exception as error:
            return Response(json.dumps({'ok': False, 'error': str(error)[:2000]}), headers={'content-type': 'application/json'})
`;
}
