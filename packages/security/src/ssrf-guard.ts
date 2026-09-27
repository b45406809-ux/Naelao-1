// Backwards-compatible entry point. New code should import `./ssrf.js`.
export { checkSsrf, isPrivateNetworkAddress, resolveHostnameIps } from "./ssrf.js";
export type { SsrfCheckResult } from "./ssrf.js";
