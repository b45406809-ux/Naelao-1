# Naelao Local Agent (reference client)

Opt your own machine in as a grant-checked execution target for your space's agent
(spec gap G-3, "Local PC as a Container Target" — §A1.17 Phase M). This is the ONLY way
an agent can read/write files or run a command on hardware Naelao doesn't own; there is no
default access, and every request is checked against your space's `local_grants` on the server
before it ever reaches this client.

## Requirements

Node.js 22+ (needs the global `WebSocket`).

## 1. Grant access

As the space's owner/admin, create a grant — e.g. read/write under one project directory:

```
POST /spaces/:spaceId/local-grants
{ "grant_type": "readwrite", "directory": "/home/alice/my-project" }
```

or an exec allowlist:

```
POST /spaces/:spaceId/local-grants
{ "grant_type": "exec", "commands": ["npm test", "npm run build"] }
```

`user_id` is always taken from your own verified identity — you can only grant access to your
own machine, never someone else's. List grants with `GET /spaces/:spaceId/local-grants`; revoke
one with `DELETE /spaces/:spaceId/local-grants/:grantId` (takes effect on the next request, even
if this client is still connected — the check runs server-side, per call).

## 2. Mint a connect token

```
POST /spaces/:spaceId/local-tunnel/connect-token
→ { "token": "...", "space_id": "...", "user_id": "...", "connect_path": "/local-tunnel/connect", "expires_in_seconds": 300 }
```

The token expires in 5 minutes — run the client promptly after minting one.

## 3. Run the client

```
node naelao-local-agent.mjs \
  --url wss://<your-agents-worker-hostname> \
  --space <spaceId> --user <userId> --token <token> \
  --allow-dir /home/alice/my-project \
  --allow-command "npm test"
```

`--url` is your deployment's agents-worker public hostname — this is an operator/deployment
detail, not something the platform hardcodes for you.

`--allow-dir` / `--allow-command` are an OPTIONAL second, independent check that runs on THIS
machine, on top of the server-side grant check the agent's request already passed. They default
to "trust the server" (empty list = no extra restriction) — set them if you want this specific
client process to refuse even a server-approved request that falls outside a narrower local
policy (e.g. you trust the space with grants for two directories, but only want this particular
client run to touch one of them).

## Disconnecting / revoking

Ctrl-C the process, or delete the grant(s) server-side. On any disconnect this client exits
(rather than silently retrying with what is likely now a stale token) — mint a fresh token and
re-run to reconnect.

## Protocol (for anyone porting this to another runtime)

The server sends: `{"type":"request","request_id":"...","op":"read_file"|"write_file"|"exec","params":{...}}`

The client replies: `{"type":"response","request_id":"...","ok":true,"result":...}` or
`{"type":"response","request_id":"...","ok":false,"error":"..."}`
