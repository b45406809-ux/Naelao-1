// Keep Desk-Drop cookies on the shell's own origin, including deployments on separate domains.
export const runtime = "edge";
async function proxy(request: Request, { params }: { params: { path: string[] } }) {
  const path = params.path;
  if (path[0] !== "v1" || path.some(segment => segment === ".." || segment === "." || segment.includes("/")) || path[1] === "internal") return new Response("Not found", { status: 404 });
  const base = process.env.NAELAO_API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";
  const upstream = new URL(base);
  if (upstream.protocol !== "https:" && !(upstream.protocol === "http:" && ["localhost", "127.0.0.1"].includes(upstream.hostname))) return new Response("API configuration requires HTTPS", { status: 503 });
  upstream.pathname = `/${path.map(encodeURIComponent).join("/")}`;
  upstream.search = new URL(request.url).search;
  const headers = new Headers(request.headers);
  for (const header of ["host", "connection", "content-length", "transfer-encoding", "x-forwarded-host", "x-forwarded-proto"]) headers.delete(header);
  const response = await fetch(upstream, { method: request.method, headers, redirect: "manual", ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: await request.arrayBuffer() }), signal: AbortSignal.timeout(30000) });
  return new Response(response.body, { status: response.status, headers: response.headers });
}
export { proxy as GET, proxy as POST, proxy as PUT, proxy as PATCH, proxy as DELETE, proxy as HEAD };
