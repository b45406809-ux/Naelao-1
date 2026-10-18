import { createMiddleware } from "hono/factory";

function appendVaryOrigin(headers: Headers): void {
  const vary = headers.get("Vary");
  const values =
    vary?.split(",").map((value) => value.trim().toLowerCase()) ?? [];
  if (!values.includes("origin")) {
    headers.set("Vary", vary ? `${vary}, Origin` : "Origin");
  }
}

export function cors(allowedOrigins: string[] = ["*"]) {
  return createMiddleware(async (c, next) => {
    const origin = c.req.header("origin") ?? "";
    const allowed =
      allowedOrigins.includes("*") || allowedOrigins.includes(origin)
        ? origin || "*"
        : "";

    if (c.req.method === "OPTIONS") {
      const headers = new Headers({
        "Access-Control-Allow-Origin": allowed,
        "Access-Control-Allow-Methods":
          "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers":
          "Content-Type, Authorization, X-Request-Id",
        "Access-Control-Max-Age": "86400",
      });
      appendVaryOrigin(headers);
      return new Response(null, {
        status: 204,
        headers,
      });
    }

    await next();
    const headers = new Headers(c.res.headers);
    appendVaryOrigin(headers);
    if (allowed) headers.set("Access-Control-Allow-Origin", allowed);
    c.res = new Response(c.res.body, {
      status: c.res.status,
      statusText: c.res.statusText,
      headers,
    });
    return;
  });
}
