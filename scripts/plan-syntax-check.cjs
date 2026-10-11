// Syntax diagnostics only. This deliberately does not execute tests or install packages.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('../workers/agents/node_modules/typescript');
let failed = false;
for (const input of process.argv.slice(2)) {
  const filename = path.resolve(input);
  const source = fs.readFileSync(filename, 'utf8');
  const result = ts.transpileModule(source, {
    fileName: filename,
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
  });
  for (const diagnostic of result.diagnostics || []) {
    if (diagnostic.category !== ts.DiagnosticCategory.Error) continue;
    failed = true;
    const position = diagnostic.file && diagnostic.start !== undefined
      ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start) : undefined;
    process.stderr.write(`${input}${position ? ':' + (position.line + 1) : ''}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}\n`);
  }
}
if (failed) process.exitCode = 1;
else process.stdout.write(`Syntax OK: ${process.argv.length - 2} file(s)\n`);
