import type {
  DocumentPartitionResult,
  DocumentProcessingGateway,
} from "@naelao/agent-sdk";
import {
  extractPartitionableDocument,
  partitionDocumentText,
} from "../../shared/document-files.js";
import { workspacePrefix } from "../types.js";
import { assertWorkspaceFileAllowed } from "../workspace-paths.js";
import type { PrebuiltOpContext, PrebuiltScript } from "./index.js";

function assertHostedDocumentProcessingAllowed(ctx: PrebuiltOpContext): void {
  if (ctx.env.airGappedOnly || ctx.env.localModelMachine)
    throw new Error("private_document_cloud_processing_denied");
}
function gateway(ctx: PrebuiltOpContext): DocumentProcessingGateway {
  assertHostedDocumentProcessingAllowed(ctx);
  if (!ctx.env.documentProcessor)
    throw new Error("document_processing_unavailable");
  return ctx.env.documentProcessor;
}

async function source(
  args: Record<string, unknown>,
  ctx: PrebuiltOpContext
): Promise<Record<string, unknown>> {
  if (args.path === undefined) return args;
  if (typeof args.path !== "string" || args.text !== undefined)
    throw new Error("document_source_requires_text_or_workspace_path");
  const path = assertWorkspaceFileAllowed(
    ctx.env.workspaceFileScope,
    args.path
  );
  if (!path || path.startsWith("branches/"))
    throw new Error("document_workspace_path_invalid");
  const object = await (ctx.env.workspaceBucket ?? ctx.env.scriptsBucket).get(
    `${workspacePrefix(ctx.env)}${path}`
  );
  if (!object || object.size > 2 * 1024 * 1024)
    throw new Error("document_workspace_text_missing_or_too_large");
  const bytes = await object.arrayBuffer();
  const text = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: false,
  }).decode(bytes);
  if (text.startsWith("%PDF-") || text.includes("\0"))
    throw new Error("document_binary_requires_authorized_text_extraction");
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return { ...args, text, sourceId: `workspace:${path}#sha256:${hash}` };
}

async function execute<K extends keyof DocumentProcessingGateway>(
  operation: K,
  args: Record<string, unknown>,
  ctx: PrebuiltOpContext
) {
  const processor = gateway(ctx); // placement checks run before opening any bytes
  const input = await source(args, ctx);
  return processor[operation](input as never);
}

async function partition(
  args: Record<string, unknown>,
  ctx: PrebuiltOpContext
): Promise<DocumentPartitionResult> {
  assertHostedDocumentProcessingAllowed(ctx); // fail closed before reading a source file
  if (typeof args.path !== "string")
    throw new Error("document_workspace_path_required");
  const path = assertWorkspaceFileAllowed(
    ctx.env.workspaceFileScope,
    args.path
  );
  if (!path || path.startsWith("branches/"))
    throw new Error("document_workspace_path_invalid");
  const object = await (ctx.env.workspaceBucket ?? ctx.env.scriptsBucket).get(
    `${workspacePrefix(ctx.env)}${path}`
  );
  if (!object || object.size > 10 * 1024 * 1024)
    throw new Error("document_workspace_source_missing_or_too_large");
  const bytes = new Uint8Array(await object.arrayBuffer());
  const mimeType =
    object.httpMetadata?.contentType ??
    (path.toLowerCase().endsWith(".pdf") ? "application/pdf" : "text/plain");
  const extracted = await extractPartitionableDocument({
    bytes,
    mimeType,
    filename: path.split("/").at(-1) ?? path,
  });
  const sourceHash = [
    ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const sourceId = `workspace:${path}#sha256:${sourceHash}`;
  return {
    sourceId,
    sourceHash,
    mimeType: extracted.mimeType,
    sourceBytes: extracted.sourceBytes,
    extractedTextBytes: new TextEncoder().encode(extracted.text).byteLength,
    ...(extracted.pages ? { pages: extracted.pages.length } : {}),
    chunks: partitionDocumentText({
      text: extracted.text,
      ...(extracted.pages ? { pages: extracted.pages } : {}),
      maxChunks: 24,
    }),
  };
}

export const documentProcessing: PrebuiltScript = {
  name: "document-processing",
  domain: "knowledge",
  requires_tier: 2,
  description:
    "Partition authorized text/PDF workspace files into durable workflow chunks, summarize, extract source-verified entity spans, or compress supporting context. Host controls provider, policy and billing. Scanned PDFs require the separately owner-enabled OCR path.",
  paramHints: {
    "document.partition":
      "{path}. Reads only a project/branch/grant-authorized workspace file up to 10 MiB; extracts bounded UTF-8/PDF text up to 2 MiB and returns SHA-256 source identity, page-aware 64k-character chunks, and offsets. Use in a durable workflow before processing large files.",
    "document.summarize":
      "{text OR path, sourceId?, instructions?, maxOutputTokens?:16..4000}; Bash: document summarize --path /workspace/report.txt. Preserve originals; summaries are derived text, never exact evidence or authorization.",
    "document.extract":
      "{text OR path, sourceId?, entities:{field:'description'}, threshold?:0..1}; Bash: document extract --path /workspace/report.txt --entities '{\"vendor\":\"vendor name\"}'. Returns source-matched spans; validate business rules separately.",
    "document.compress":
      "{text, query, sourceId?, rate?:'auto'|number} — native provider must be configured. Compress context only; preserve policies, prompts, receipts, and original citations.",
  },
  operations: {
    "document.partition": partition,
    "document.summarize": (args, ctx) => execute("summarize", args, ctx),
    "document.extract": (args, ctx) => execute("extract", args, ctx),
    "document.compress": (args, ctx) => execute("compress", args, ctx),
  },
};
