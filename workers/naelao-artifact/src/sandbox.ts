export type ArtifactType = 'html' | 'react' | 'json' | 'markdown' | 'csv';

const SECURITY_HEADERS: Record<string, string> = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
};

export const ARTIFACT_SECURITY_HEADERS = SECURITY_HEADERS;

export function wrapHtmlArtifact(code: string, _title?: string): string {
  const escaped = code
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0"><iframe sandbox="allow-scripts" srcdoc="${escaped}" style="width:100%;height:100%;border:0;"></iframe></body></html>`;
}

export function wrapReactArtifact(r2Url: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
<script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
</head><body><div id="root"></div>
<script type="module">
  const mod = await import(${JSON.stringify(r2Url)});
  const App = mod.default;
  const root = ReactDOM.createRoot(document.getElementById('root'));
  root.render(React.createElement(App));
</script></body></html>`;
}

export function scanCodeForVulnerabilities(code: string): { safe: boolean; reason?: string } {
  const dangerousPatterns: Array<[RegExp, string]> = [
    [/\bprocess\.env\b/g, 'process.env access'],
    [/require\(['"]child_process['"]\)/g, 'child_process require'],
    [/\beval\s*\(/g, 'eval() usage'],
    [/new\s+Function\s*\(/g, 'new Function() usage'],
    [/__proto__/g, 'prototype pollution'],
    [/constructor\s*\[/g, 'constructor bracket access'],
  ];

  for (const [re, reason] of dangerousPatterns) {
    if (re.test(code)) return { safe: false, reason };
  }
  return { safe: true };
}
