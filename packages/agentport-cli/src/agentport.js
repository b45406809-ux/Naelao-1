#!/usr/bin/env node
const baseUrl = (process.env.AGENTPORT_API_URL || "https://agentport.naelao.com").replace(/\/$/, "");
const apiKey = process.env.AGENTPORT_API_KEY;
function usage() {
  console.error(`AgentPort CLI

Usage: agentport auth <register|login|password> --json '{"email":"...","password":"..."}'
       agentport keys create --json '{"scopes":["agentport:read","agentport:write"]}'
       agentport <services|agents|accounts|channels|threads|messages|events|activity|keys> <command> [--flag value]

Set AGENTPORT_API_URL to override the host. Auth returns a short-lived user token; export it as AGENTPORT_USER_TOKEN to create your first API key. Store AGENTPORT_API_KEY in your secret manager.`);
  process.exit(2);
}
function argsOf(values) {
  const out = {};
  for (let i=0;i<values.length;i++) if (values[i].startsWith("--")) out[values[i].slice(2)] = values[++i];
  return out;
}
async function request(method, path, data, token = apiKey) {
  const response = await fetch(`${baseUrl}/v1${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(data === undefined ? {} : { "content-type": "application/json" }) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const text = await response.text(); let result;
  try { result = text ? JSON.parse(text) : {}; } catch { result = { message: text }; }
  if (!response.ok) { console.error(JSON.stringify(result, null, 2)); process.exit(1); }
  console.log(JSON.stringify(result, null, 2));
  return result;
}
const [resource, command, ...rest] = process.argv.slice(2);
const flags = argsOf(rest);
const input = flags.json ? JSON.parse(flags.json) : undefined;
if (resource === "auth" && ["register", "login"].includes(command) && input) {
  const response = await fetch(`${baseUrl}/v1/auth/${command}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(input) });
  const result = await response.json();
  if (!response.ok) { console.error(JSON.stringify(result, null, 2)); process.exit(1); }
  console.log(JSON.stringify(result, null, 2));
  if (result.data?.token) console.error("Export the returned data.token as AGENTPORT_USER_TOKEN, then create a scoped API key.");
} else if (resource === "auth" && command === "password" && input) {
  const userToken = process.env.AGENTPORT_USER_TOKEN;
  if (!userToken) { console.error("Set AGENTPORT_USER_TOKEN from auth login/register."); process.exit(2); }
  await request("POST", "/auth/password", input, userToken);
} else if (resource === "keys" && command === "create" && input) {
  const userToken = process.env.AGENTPORT_USER_TOKEN || apiKey;
  if (!userToken) { console.error("Set AGENTPORT_USER_TOKEN from auth login/register, or use an admin API key."); process.exit(2); }
  await request("POST", "/keys", input, userToken);
} else if (!apiKey) { console.error("Set AGENTPORT_API_KEY first."); process.exit(2); }
else if (resource === "services" && command === "list") await request("GET", "/services");
else if (resource === "services" && command === "register" && input) await request("POST", "/services", input);
else if (resource === "agents" && command === "register") await request("POST", "/agents", input || { hostPlatform: flags.host || "external", runtime: flags.runtime });
else if (resource === "accounts" && command === "create" && input) await request("POST", "/accounts", input);
else if (resource === "accounts" && command === "grant" && flags.account && input) await request("POST", `/accounts/${encodeURIComponent(flags.account)}/grants`, input);
else if (resource === "channels" && command === "list") await request("GET", `/channels${flags.agent ? `?agentId=${encodeURIComponent(flags.agent)}` : ""}`);
else if (resource === "channels" && command === "register" && input) await request("POST", "/channels", input);
else if (resource === "threads" && command === "create" && flags.channel && input) await request("POST", `/channels/${encodeURIComponent(flags.channel)}/threads`, input);
else if (resource === "threads" && command === "list" && flags.channel) await request("GET", `/channels/${encodeURIComponent(flags.channel)}/threads${flags.agent ? `?agentId=${encodeURIComponent(flags.agent)}` : ""}`);
else if (resource === "messages" && command === "references" && flags.thread && flags.agent) await request("GET", `/threads/${encodeURIComponent(flags.thread)}/message-references?agentId=${encodeURIComponent(flags.agent)}`);
else if (resource === "events" && command === "subscribe" && input) await request("POST", "/events/subscriptions", input);
else if (resource === "events" && command === "pending" && flags.agent) await request("GET", `/events/pending?agentId=${encodeURIComponent(flags.agent)}`);
else if (resource === "events" && command === "claim" && flags.id && input) await request("POST", `/events/${encodeURIComponent(flags.id)}/claim`, input);
else if (resource === "events" && command === "ack" && flags.id && input) await request("POST", `/events/${encodeURIComponent(flags.id)}/ack`, input);
else if (resource === "activity" && command === "acquire" && input) await request("POST", "/activity/leases", input);
else if (resource === "activity" && command === "renew" && flags.id && input) await request("POST", `/activity/leases/${encodeURIComponent(flags.id)}/renew`, input);
else if (resource === "activity" && command === "release" && flags.id) await request("DELETE", `/activity/leases/${encodeURIComponent(flags.id)}`);
else if (resource === "keys" && command === "list") await request("GET", "/keys");
else if (resource === "keys" && command === "revoke" && flags.id) await request("DELETE", `/keys/${encodeURIComponent(flags.id)}`);
else if (resource === "account" && command === "delete") await request("DELETE", "/account");
else usage();
