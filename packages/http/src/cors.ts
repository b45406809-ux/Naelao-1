import { createMiddleware } from "hono/factory";

export function cors(allowedOrigins: string[] = ["*"]) {
  return createMiddleware(async (c, next) => {
    const origin = c.req.header("origin") ?? "";
    const allowed =
      allowedOrigins.includes("*") || allowedOrigins.includes(origin)
        ? origin || "*"
        : "";

    if (c.req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": allowed,
          "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Request-Id",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    await next();
    if (allowed) c.res.headers.set("Access-Control-Allow-Origin", allowed);
  });
}
