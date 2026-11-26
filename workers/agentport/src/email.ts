// Address and URL validators for AgentPort's /email/accounts routes. Sending, inbound mail, inboxes and webhook
// delivery live in Naelao Email (workers/email); see naelao-email.ts. MS-35 removed the native in-worker
// implementation (MR-EM-8: moved, not duplicated).

export function validEmailAddress(value: string) {
  return value.length <= 254 && /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i.test(value);
}

export function validInboundWebhookUrl(value: string) {
  if (value.length > 2048) return false;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return url.protocol === "https:" && !url.username && !url.password && !url.hash && (!url.port || url.port === "443") &&
      !hostname.includes(":") && !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) && hostname.includes(".") &&
      !["localhost", "local", "internal", "test", "invalid", "example"].some(suffix => hostname === suffix || hostname.endsWith(`.${suffix}`));
  } catch { return false; }
}
