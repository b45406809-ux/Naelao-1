> ## Documentation Index
> Fetch the complete documentation index at: https://www.agent37.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Run commands

> Run any shell command inside an instance from your backend, the escape hatch for anything the API does not wrap.

Run a shell command on your instance and read its output.

```bash curl wrap theme={null}
curl -X POST \
  https://sandbox.agent37.app/v1/instances/ab12cd34ef/exec \
  -H "X-Agent37-Key: sk_live_..." \
  -H "Content-Type: application/json" \
  -d '{
    "command": "node --version",
    "user": "root"
  }'
```

```python Python wrap theme={null}
import requests

response = requests.post(
    "https://sandbox.agent37.app/v1/instances/ab12cd34ef/exec",
    headers={
        "X-Agent37-Key": "sk_live_...",
        "Content-Type": "application/json"
    },
    json={
        "command": "node --version",
        "user": "root"
    },
)
response.raise_for_status()
print(response.json())
```

```javascript Node wrap theme={null}
const response = await fetch(
  "https://sandbox.agent37.app/v1/instances/ab12cd34ef/exec",
  {
    method: "POST",
    headers: {
      "X-Agent37-Key": "sk_live_...",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      "command": "node --version",
      "user": "root"
    }),
  },
);
if (!response.ok) {
  throw new Error(await response.text());
}
console.log(await response.json());
```

```json 200 wrap theme={null}
{
  "exit_code": 0,
  "stdout": "v24.2.0\n",
  "stderr": "",
  "truncated": false
}
```

`POST /v1/instances/{id}/exec` runs a shell command inside the instance, straight from your backend. It is the escape hatch for anything the API does not wrap as its own call.

The command runs through `sh -c` as the image's default user (or as `root`, with `user`), on the same box the agent works on, so it sees the agent's files, tools, and credentials.

## Where to call it

Call exec on `https://sandbox.agent37.app`, with the same `sk_live_` key sent as the `X-Agent37-Key` header, the same way you call [chat](https://www.agent37.com/docs/agents-api/chat.md) and [files](https://www.agent37.com/docs/agents-api/files.md) on your instance URL. The request goes to the machine your instance runs on, so a command typically answers in a couple of hundred milliseconds instead of a couple of seconds.

```bash curl wrap theme={null}
curl -X POST https://sandbox.agent37.app/v1/instances/ab12cd34ef/exec \
  -H "X-Agent37-Key: sk_live_..." \
  -H "Content-Type: application/json" \
  -d '{ "command": "node --version" }'
```

The original address, `https://api.agent37.com/v1/instances/{id}/exec` with `Authorization: Bearer`, keeps working and returns the same result, so existing code needs no change. It forwards your call to the address above, which costs it a hop, so new code should use `sandbox.agent37.app`. One thing differs there: a request turned away before it reaches the instance (a bad key, an instance that is not yours, a failed wake) gets a flat [transport error](https://www.agent37.com/docs/agents-api/errors.md#transport-errors) such as `{"error": "not_found"}` instead of the `{"error": {"code": ...}}` envelope, so check whether `error` is a string before reading `code`. If your workspace has a [custom domain](https://www.agent37.com/docs/agents-api/domains.md), `https://sandbox.{yourdomain}` serves the same endpoint.

A [signed URL](https://www.agent37.com/docs/agents-api/urls.md) cannot authorize exec: it is API-key-only, on both addresses.

## Request

**command** `string` *required*

The shell command to run inside the instance. It is passed to `sh -c`, so pipes, redirects, and `&&` chains all work. It must not contain a null byte, which no shell can carry: one returns `400 invalid_request`. The whole request body is capped at 1 MB, and a larger one returns `413 invalid_request`: to move a bigger file into the instance, use [`scp` over SSH](https://www.agent37.com/docs/agents-api/ssh).

**user** `string`

Who runs the command. Omit it to run as the image's default user; pass `"root"` to run as root, for example to install system packages with `apt-get`. Any other value returns `400 invalid_request`.

**name** `string`

A label for this run, 1 to 128 characters, that makes a resend safe. If your connection drops before the answer arrives, send the identical request again with the same `name`: you get that run's result, waiting for it if it is still running, and the command does not run a second time. A name is remembered while its command runs and for 5 minutes after it finishes; the same name with a different command in that time returns `400 invalid_request`. Leave it out and every call runs. Calls to `api.agent37.com` do this for you.

> [!NOTE]
>
> A `running` instance runs the command right away. A `sleeping` instance is woken first, the same way a request to one of its URLs or an explicit [start](https://www.agent37.com/docs/agents-api/instances/start.md) wakes it. The command runs after the wake completes. If the wake has to rebuild the instance, it boots fresh: files on disk are kept, processes and in-memory state are not. See [Auto-sleep](https://www.agent37.com/docs/agents-api/instance-auto-sleep.md). The wake can fail the way a start can: `409 try_again` means a sleep checkpoint was being written (tens of seconds on a large instance, retry with backoff), `502 provisioning_failed` means the wake failed, `409 capacity_unavailable` means a rebuild found no host with room, and `402 insufficient_balance` means the instance is suspended for non-payment. Those are the codes on `api.agent37.com`; on `sandbox.agent37.app` a wake that fails answers `503 wake_failed` or `503 wake_timeout`, both safe to retry, and a suspended instance answers `402 instance_suspended`. Exec does not wait for a wake another request started: an instance that is already `waking` returns `400 invalid_request`, as does any other status that is not `running` or `sleeping` (a deleted instance returns `404 not_found`). If the platform cannot reach the instance at all, you get `502 provisioning_failed`. Every exec counts as [activity](https://www.agent37.com/docs/agents-api/instance-auto-sleep.md), so an instance you drive only through exec stays up while commands keep coming. One instance runs up to 48 commands at a time; past that you get `503 try_again`, which is safe to retry with backoff because the refused command never started. A `503 try_again` also appears for up to a minute after an instance changes hosts, which a resize can do: retry and it resolves itself.

## Response

A command that runs but exits nonzero is a normal result: you get `200` with its `exit_code`, `stdout`, and `stderr`. Errors are reserved for the platform, not your command.

**exit\_code** `integer`

The command's exit code. Nonzero is still a `200`; read this to branch.

**stdout** `string`

Standard output, capped at 512 KB. See `truncated`.

**stderr** `string`

Standard error, with its own separate 512 KB cap.

**truncated** `boolean`

`true` when either stream spilled past its 512 KB cap. The middle of the output is cut and a truncation marker is left in its place.

> [!NOTE]
>
> `exit_code` values 125, 126, and 127 may come from the container runtime rather than your command, for example 127 when the binary is not found. On `sandbox.agent37.app` the call waits up to 15 minutes (900 seconds) for the command, then answers `504 try_again`; on `api.agent37.com` it waits 13 minutes (780 seconds), a wake from sleep included, then fails with `502 provisioning_failed`. The command itself is not stopped by either: it keeps running inside the instance, so a blind retry starts a second copy. For longer jobs, start the command in the background with its output sent to a file, `nohup ./job.sh > job.log 2>&1 &`, and poll with a second exec. The redirect is required: a background command that still writes to the call's own output holds the call open until it exits.

> [!WARNING]
>
> A command that runs for minutes sends nothing back until it finishes, and some HTTP clients quietly give up on a connection that goes quiet, or have it closed under them. `curl` is fine as shipped. Node's `http`/`https` and `fetch` are not: enable TCP keepalive on the socket (`req.on("socket", (s) => s.setKeepAlive(true, 15000))`), and prefer `http.request` over `fetch`, whose 300-second limit on waiting for a response cannot be raised. Measured on a real 330-second command: reset at 108 seconds without keepalive, clean with it. Backgrounding the command, as below, avoids the question entirely.

## Build on exec

Anything the API does not wrap as its own endpoint, you build on `exec`. For moving files, use [`scp` over SSH](https://www.agent37.com/docs/agents-api/ssh), which works on every template, or on an agent template the instance's own [files endpoints](https://www.agent37.com/docs/agents-api/files.md) (`PUT /v1/files/content` to upload, `GET /v1/files/content` to download). A quick text read works over exec too. A "Download the report" button in your product can be one exec call that reads the file the agent wrote:

```bash curl wrap theme={null}
curl -X POST https://sandbox.agent37.app/v1/instances/ab12cd34ef/exec \
  -H "X-Agent37-Key: sk_live_..." \
  -H "Content-Type: application/json" \
  -d '{ "command": "cat ~/reports/ev-makers-memo.md" }'
```

Pushing a file in is the same trick in reverse. Encode it on your side and decode it inside the instance:

```bash curl wrap theme={null}
curl -X POST https://sandbox.agent37.app/v1/instances/ab12cd34ef/exec \
  -H "X-Agent37-Key: sk_live_..." \
  -H "Content-Type: application/json" \
  -d '{ "command": "mkdir -p ~/data && echo aGVsbG8sd29ybGQK | base64 -d > ~/data/ev-prices.csv" }'
```

For binary or large files, use the [files endpoints](https://www.agent37.com/docs/agents-api/files.md) on the instance URL instead, where `GET /v1/files/content` streams a download of any size with no 512 KB cap, or stage them at a URL your backend controls and `curl` them down from inside the instance.


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.