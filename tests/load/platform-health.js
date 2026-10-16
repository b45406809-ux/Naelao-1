import { check, sleep } from "k6";
import http from "k6/http";

const target = __ENV.TARGET_URL;
if (!target) throw new Error("Set TARGET_URL to a non-production router URL");
const targetUrl = new URL(target);
if (
  !/^https?:$/.test(targetUrl.protocol) ||
  targetUrl.username ||
  targetUrl.password
) {
  throw new Error(
    "TARGET_URL must be an HTTP(S) URL without embedded credentials"
  );
}
const host = targetUrl.hostname.toLowerCase();
const local =
  host === "localhost" ||
  host === "127.0.0.1" ||
  host === "::1" ||
  host === "[::1]" ||
  host.endsWith(".test");
if (!local && __ENV.CONFIRM_NON_PRODUCTION !== "yes") {
  throw new Error(
    "Refusing remote load: set CONFIRM_NON_PRODUCTION=yes only for a staging/test target"
  );
}
if (/prod|production/i.test(host))
  throw new Error("Refusing a production hostname");
if (!local && !/(stage|staging|test|dev|preview)/i.test(host)) {
  throw new Error(
    "Remote target hostname must clearly identify a development, preview, test, or staging environment"
  );
}

export const options = {
  stages: [
    { duration: "15s", target: 5 },
    { duration: "30s", target: 20 },
    { duration: "15s", target: 0 },
  ],
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<750"],
  },
};

export default function () {
  const response = http.get(
    `${target.replace(/\/+$/, "")}/health/dependencies`,
    {
      headers: { "x-synthetic-check": "true" },
      timeout: "5s",
    }
  );
  check(response, {
    "dependency probe responds successfully": (res) => res.status === 200,
    "dependency probe does not disclose response internals": (res) =>
      !/secret|token|password|authorization/i.test(res.body),
  });
  sleep(1);
}
