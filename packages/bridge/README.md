# Named machine bridge

This is the Node 22.11+ reference CLI for Windows, Linux and macOS. It is an outbound
HTTPS/WSS client; it opens no inbound shell endpoint. Linux shell execution uses bubblewrap;
macOS and Windows can opt into a digest-pinned, preloaded Docker Desktop sandbox.

1. A space owner/admin creates an expiring enrollment ticket at
   `POST /spaces/:spaceId/tunnels/enrollment`, with a unique name and explicit actor,
   project, folder, command and inference grants. Save the returned JSON privately.
2. Set `NAELAO_BRIDGE_KEY_PASSPHRASE` or pass a private `--passphrase-file`.
   Run the built CLI's `login --url https://AGENTS_ENDPOINT --name MACHINE
   --enrollment-file TICKET.json --allow-dir FOLDER`. Opt into individual commands
   with repeated `--allow-command`. The shell UI uses `--allow-dir-base64` and
   `--allow-command-base64` so special characters are passed literally across terminals.
   Sandboxed shell requires both the host grant and local `--allow-sandboxed-shell`. On
   macOS/Windows also pass `--container-image registry/name@sha256:<64-hex>`; inference needs
   `--allow-inference`.
3. Run `connect --identity IDENTITY.json`. Encrypted Ed25519 credentials and a
   request journal persist beside the identity. Only one daemon can hold its lock.
   Never delete a lock until its recorded process has stopped.
4. `rotate --identity IDENTITY.json` rotates the signing key. An uncertain rotation
   retains an encrypted recovery candidate; use `recover-rotation` explicitly.
   `remove` revokes the device at the authority and retains the local encrypted record.

Operations require both server grants and local consent. The bridge keeps the computer's
filesystem independent from the Naelao workspace: it does not mount or synchronize the
workspace. Selected binary artifacts up to 16 MiB can be explicitly imported/exported in
resumable 8 KiB chunks; local
exports create a new file and do not overwrite. On Linux, shell commands run through bubblewrap with network disabled, system
runtime directories read-only, and only `--allow-dir` folders mounted read/write. An optional
working directory must be inside one of those folders. Files cross the boundary only through
explicit file or artifact operations. The Linux adapter fails closed if bubblewrap is absent.
The matching host grant further narrows those folders and makes read-only grants read-only
inside the sandbox; the bridge intersects that grant with local consent.
An explicitly granted sandboxed shell can run changing commands, but only within write-enabled
roots and with no network; exact-command grants remain available for narrower access. On
macOS/Windows, Docker Desktop runs the image with `--pull=never`, a read-only root filesystem,
network disabled, dropped capabilities, an unprivileged user, fixed process/CPU/memory limits,
and only consented host folders mounted under `/mnt/naelao/<index>`. Commands use that guest path
for file access. The container does not inherit the host application's login profile or browser
cookies. This is Linux-container isolation hosted by Docker Desktop, not native macOS sandboxing
or Windows ACL enforcement; without the pinned local image and explicit opt-in, shell execution
fails closed. This client transports authorized local model calls;
it is not a disconnected OS.

The same outbound bridge can run on a user's computer, a VM, or a container host such as Modal,
provided it can run the supported Node client and maintain outbound WSS. Naelao treats each as an
external machine with its own filesystem and installed applications; it does not provision or
stop that provider's containers. For hosted machines, configure the provider's persistent volume
and lifecycle separately if local files or logged-in application state must survive restarts.
Managed Naelao containers remain a separate, workspace-backed execution target. A connected
machine is eligible as a last resort only when the host finds no available managed target matching
the task and the owner granted fallback use; a worker cannot assert that managed runtimes are down.

Service templates are examples to configure explicitly, not installation scripts.
SIGINT/SIGTERM cancel outstanding requests and close the socket. Reconnects
authenticate a fresh short session and reconcile saved outcomes, never resend
uncertain commands. Limit the process owner and protect identity/passphrase files
with Unix modes or Windows ACLs. Templates and platform shutdown still need live tests.

## Application inventory and scheduler consent

An administrator can add `externalUse: ["capability"]` or `["fallback"]` to a
machine grant, in addition to exact commands and folders. Existing grants do not
opt into scheduler selection. Fallback also requires host-confirmed absence of a compatible
managed target (or a managed provider outage) and current admission; it does not override policy
or quota denial.

`connect --inventory-file /absolute/path/apps.json` optionally reports an array of
metadata records: `[{"id":"blender","version":"4.5"}]`. A connection reference
may add `connectionId` and a measured `authenticatedAt` timestamp. These are
untrusted observations, not credentials or proof of account ownership. Do not
invent timestamps or include passwords, cookies or tokens; unknown fields are
rejected. A trusted app adapter must refresh authentication observations. This
option does not install apps, copy profiles, or grant account access.
