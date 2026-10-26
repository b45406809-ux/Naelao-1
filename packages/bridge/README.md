# Named machine bridge

This is the Node 22.11+ reference CLI for Windows, Linux and macOS. It is an outbound
HTTPS/WSS client; it opens no inbound shell endpoint. Linux shell execution uses bubblewrap;
macOS and Windows shell adapters, native packaging and live-machine verification remain open.

1. A space owner/admin creates an expiring enrollment ticket at
   `POST /spaces/:spaceId/tunnels/enrollment`, with a unique name and explicit actor,
   project, folder, command and inference grants. Save the returned JSON privately.
2. Set `NAELAO_BRIDGE_KEY_PASSPHRASE` or pass a private `--passphrase-file`.
   Run the built CLI's `login --url https://AGENTS_ENDPOINT --name MACHINE
   --enrollment-file TICKET.json --allow-dir FOLDER`. Opt into individual commands
   with repeated `--allow-command`. The shell UI uses `--allow-dir-base64` and
   `--allow-command-base64` so special characters are passed literally across terminals.
   Sandboxed shell requires both the host grant and local
   `--allow-sandboxed-shell`; inference needs `--allow-inference`.
3. Run `connect --identity IDENTITY.json`. Encrypted Ed25519 credentials and a
   request journal persist beside the identity. Only one daemon can hold its lock.
   Never delete a lock until its recorded process has stopped.
4. `rotate --identity IDENTITY.json` rotates the signing key. An uncertain rotation
   retains an encrypted recovery candidate; use `recover-rotation` explicitly.
   `remove` revokes the device at the authority and retains the local encrypted record.

Operations require both server grants and local consent. The bridge keeps the computer's
filesystem independent from the Naelao workspace: it does not mount or synchronize the
workspace. Selected binary artifacts up to 12 KiB can be explicitly imported/exported; local
exports create a new file and do not overwrite. On Linux, shell commands run through bubblewrap with network disabled, system
runtime directories read-only, and only `--allow-dir` folders mounted read/write. An optional
working directory must be inside one of those folders. Files cross the boundary only through
explicit file or artifact operations. The Linux adapter fails closed if bubblewrap is absent.
The matching host grant further narrows those folders and makes read-only grants read-only
inside the sandbox; the bridge intersects that grant with local consent.
An explicitly granted sandboxed shell can run changing commands, but only within write-enabled
roots and with no network; exact-command grants remain available for narrower access.
macOS and Windows shell execution still fail closed until their native isolation adapters and
Windows ACL enforcement are implemented. This client transports authorized local model calls;
it is not a disconnected OS.

Service templates are examples to configure explicitly, not installation scripts.
SIGINT/SIGTERM cancel outstanding requests and close the socket. Reconnects
authenticate a fresh short session and reconcile saved outcomes, never resend
uncertain commands. Limit the process owner and protect identity/passphrase files
with Unix modes or Windows ACLs. Templates and platform shutdown still need live tests.

## Application inventory and scheduler consent

An administrator can add `externalUse: ["capability"]` or `["fallback"]` to a
machine grant, in addition to exact commands and folders. Existing grants do not
opt into scheduler selection. Fallback also requires host-confirmed absence of
managed compute bindings and current admission; it does not override policy or
quota denial.

`connect --inventory-file /absolute/path/apps.json` optionally reports an array of
metadata records: `[{"id":"blender","version":"4.5"}]`. A connection reference
may add `connectionId` and a measured `authenticatedAt` timestamp. These are
untrusted observations, not credentials or proof of account ownership. Do not
invent timestamps or include passwords, cookies or tokens; unknown fields are
rejected. A trusted app adapter must refresh authentication observations. This
option does not install apps, copy profiles, or grant account access.
