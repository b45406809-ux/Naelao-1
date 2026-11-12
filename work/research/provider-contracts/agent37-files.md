> ## Documentation Index
> Fetch the complete documentation index at: https://www.agent37.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Files

> Browse, read, write, move, delete, and download whole folders on the instance's disk, straight from the instance URL.

Files live on the instance's disk. A file's absolute `path` is its identity: there are no file ids, so the path you list is the path you read, write, move, or delete. You write a file with one call, attach the returned `path` to [a message](https://www.agent37.com/docs/agents-api/chat.md), and download anything the agent produces by path.

These endpoints are served by the agent on an agent template such as `agent37-hermes`. A template with no agent, `agent37-base` included, does not have them: move files there with [`scp` over SSH](https://www.agent37.com/docs/agents-api/ssh).

The base URL is your instance URL, `https://{instanceId}.agent37.app`, with the same `sk_live_` key as every other call, sent as the `X-Agent37-Key` header. This page uses `https://ab12cd34ef.agent37.app`. The agent's workspace, where it reads and writes by default, is its home directory, `/home/node`, and that is the default directory for a list with no `path`.

These calls are not jailed to the workspace. The `sk_live_` key is the instance root: any path the key can reach on the instance's filesystem is fair game, with `~` expanding to the agent's home. Treat the key accordingly.

> [!NOTE]
>
> Every timestamp here is `modified`, the file's mtime in **epoch milliseconds**, following the Agent API convention (the Sandbox API uses seconds). It is a number, not an ISO string.

## The file entry

List responses and every write return the same `FileEntry` shape, so the `path` you get back from a write is ready to use on the next call.

**name** `string`

The basename, e.g. `leads.csv`.

**path** `string`

The resolved absolute path on the instance. This is the identity you pass to every other call and to `files` on [`POST /v1/responses`](https://www.agent37.com/docs/agents-api/chat).

**type** `string`

`file`, `directory`, `symlink`, or `other` (sockets, devices, FIFOs).

**size** `integer | null`

Size in bytes; `null` for directories.

**modified** `number`

Last-modified time (mtime) in epoch milliseconds.

**hidden** `boolean`

`true` when the name starts with `.`.

## List a directory

`GET /v1/files` lists one directory level. Omit `path` to list the agent's workspace; pass an absolute path or a `~/` path to list anywhere the key can reach. Entries are sorted directories first, then by name case-insensitively.

**path** `string`

The directory to list. Optional; defaults to the agent's workspace, `/home/node`. Accepts absolute and `~/` paths. A path that exists but is not a directory returns `400 not_a_directory`.

```bash curl wrap theme={null}
curl -X GET \
  https://ab12cd34ef.agent37.app/v1/files \
  --url-query "path=~/" \
  -H "X-Agent37-Key: sk_live_..."
```

```python Python wrap theme={null}
import requests

response = requests.get(
    "https://ab12cd34ef.agent37.app/v1/files",
    headers={
        "X-Agent37-Key": "sk_live_..."
    },
    params={
        "path": "~/"
    },
)
response.raise_for_status()
print(response.json())
```

```javascript Node wrap theme={null}
const query = new URLSearchParams({
  "path": "~/"
});

const response = await fetch(
  "https://ab12cd34ef.agent37.app/v1/files" + "?" + query,
  {
    method: "GET",
    headers: {
      "X-Agent37-Key": "sk_live_..."
    },
  },
);
if (!response.ok) {
  throw new Error(await response.text());
}
console.log(await response.json());
```

```json response wrap theme={null}
{
  "path": "/home/node",
  "parentPath": "/home",
  "entries": [
    {
      "name": ".hermes",
      "path": "/home/node/.hermes",
      "type": "directory",
      "size": null,
      "modified": 1781049500000,
      "hidden": true
    },
    {
      "name": "reports",
      "path": "/home/node/reports",
      "type": "directory",
      "size": null,
      "modified": 1781049600000,
      "hidden": false
    },
    {
      "name": "leads.csv",
      "path": "/home/node/leads.csv",
      "type": "file",
      "size": 18244,
      "modified": 1781049642000,
      "hidden": false
    }
  ],
  "truncated": false
}
```

**path** `string`

The resolved absolute path of the directory you listed.

**parentPath** `string | null`

The parent directory's absolute path, or `null` at the filesystem root.

**entries** `array`

The directory's immediate children as [`FileEntry`](#the-file-entry) objects. One level only; this never recurses.

**truncated** `boolean`

`true` when the directory holds more than 1000 entries; only the first 1000 (after sorting) are returned.

## Read, preview, or download a file

`GET /v1/files/content?path=…` streams a file off the instance, typically one the agent told you it wrote. Any size; the 512 KB [exec](https://www.agent37.com/docs/agents-api/exec.md) output cap does not apply here. The `Content-Type` is set from the file extension.

**path** `string` *required*

The file to read. Accepts absolute and `~/` paths. A missing or empty `path`, or a path that is not a regular file, returns `400 validation_error`; no file at the path returns `404 file_not_found`.

**disposition** `string` (default: attachment)

`attachment` sends `Content-Disposition: attachment` so a browser downloads the file. `inline` sends `Content-Disposition: inline` so a browser renders it (useful for previews).

```bash curl wrap theme={null}
curl -X GET \
  https://ab12cd34ef.agent37.app/v1/files/content \
  --url-query "path=~/reports/ev-makers-memo.md" \
  --url-query "disposition=attachment" \
  -H "X-Agent37-Key: sk_live_..." \
  -o ev-makers-memo.md
```

```python Python wrap theme={null}
import requests

response = requests.get(
    "https://ab12cd34ef.agent37.app/v1/files/content",
    headers={
        "X-Agent37-Key": "sk_live_..."
    },
    params={
        "path": "~/reports/ev-makers-memo.md",
        "disposition": "attachment"
    },
)
response.raise_for_status()
with open("ev-makers-memo.md", "wb") as output:
    output.write(response.content)
```

```javascript Node wrap theme={null}
import fs from "node:fs/promises";

const query = new URLSearchParams({
  "path": "~/reports/ev-makers-memo.md",
  "disposition": "attachment"
});

const response = await fetch(
  "https://ab12cd34ef.agent37.app/v1/files/content" + "?" + query,
  {
    method: "GET",
    headers: {
      "X-Agent37-Key": "sk_live_..."
    },
  },
);
if (!response.ok) {
  throw new Error(await response.text());
}
await fs.writeFile(
  "ev-makers-memo.md",
  Buffer.from(await response.arrayBuffer()),
);
```

> [!WARNING]
>
> Serving an agent-produced file `inline` runs it on **your** origin. HTML, SVG, and similar can execute scripts in the page that opens them, so an instance whose agent writes attacker-controlled content can run code against your users. Render untrusted files in a sandboxed frame (`<iframe sandbox>`) on an isolated origin, or force a download with `disposition=attachment`.

## Download a folder

`GET /v1/files/archive?path=…` streams a whole directory as a gzipped tar (`.tar.gz`), the one call to pull a tree instead of walking it file by file. The archive is built on the fly and streamed, so any size works and the 512 KB [exec](https://www.agent37.com/docs/agents-api/exec.md) output cap does not apply. It unpacks to a single top-level folder named after the directory you packed.

**path** `string`

The directory to archive. Optional; defaults to the agent's workspace, `/home/node`. Accepts absolute and `~/` paths. No directory at the path returns `404 file_not_found`; a path that exists but is not a directory returns `400 not_a_directory`.

The response is `Content-Type: application/gzip` and a `Content-Disposition: attachment` whose download filename is the packed directory's name plus `.tar.gz` (characters outside `A–Z a–z 0–9 . _ -` and space are stripped, and an empty result falls back to `archive`). Symlinks are stored as links, not followed, so the archive never inlines a link target's bytes.

```bash curl wrap theme={null}
curl -X GET \
  https://ab12cd34ef.agent37.app/v1/files/archive \
  --url-query "path=/home/node/reports" \
  -H "X-Agent37-Key: sk_live_..." \
  -o reports.tar.gz
```

```python Python wrap theme={null}
import requests

response = requests.get(
    "https://ab12cd34ef.agent37.app/v1/files/archive",
    headers={
        "X-Agent37-Key": "sk_live_..."
    },
    params={
        "path": "/home/node/reports"
    },
)
response.raise_for_status()
with open("reports.tar.gz", "wb") as output:
    output.write(response.content)
```

```javascript Node wrap theme={null}
import fs from "node:fs/promises";

const query = new URLSearchParams({
  "path": "/home/node/reports"
});

const response = await fetch(
  "https://ab12cd34ef.agent37.app/v1/files/archive" + "?" + query,
  {
    method: "GET",
    headers: {
      "X-Agent37-Key": "sk_live_..."
    },
  },
);
if (!response.ok) {
  throw new Error(await response.text());
}
await fs.writeFile(
  "reports.tar.gz",
  Buffer.from(await response.arrayBuffer()),
);
```

Expand it with `tar -xzf reports.tar.gz`. There is no folder-upload counterpart: to upload a tree, recreate it with per-file `PUT /v1/files/content` calls; each creates any missing parent directories (`mkdir -p`).

## Write a file

`PUT /v1/files/content?path=…` writes the **raw request body** to `path`. This is the one call for create, overwrite, edit, and upload. It is not multipart: the body is the file's exact bytes. Missing parent directories are created (`mkdir -p`). The response is the written file's [`FileEntry`](#the-file-entry).

**path** `string` *required*

Where to write. Accepts absolute and `~/` paths; parent directories are created as needed. A missing or empty `path` returns `400 validation_error`.

**overwrite** `boolean` (default: true)

`true` replaces an existing file. `false` makes the write fail with `409 file_exists` if a file is already at `path`.

**X-Expected-Mtime** `number`

Optional optimistic-concurrency guard, epoch milliseconds. Send the `modified` you read back exactly as returned, fractional part included: a rounded value never matches. When the file exists and its `modified` differs from this value, the write fails with `412 modified`, meaning someone changed it since you read it. Ignored when the file does not exist (the write is treated as a create).

Replace `1781049642000` with the exact `modified` value from the file you read. Omit `X-Expected-Mtime` for an unconditional write.

```bash curl wrap theme={null}
curl -X PUT \
  https://ab12cd34ef.agent37.app/v1/files/content \
  --url-query "path=/home/node/leads.csv" \
  --url-query "overwrite=true" \
  -H "X-Agent37-Key: sk_live_..." \
  -H "Content-Type: text/csv" \
  -H "X-Expected-Mtime: 1781049642000" \
  --data-binary @leads.csv
```

```python Python wrap theme={null}
import requests

response = requests.put(
    "https://ab12cd34ef.agent37.app/v1/files/content",
    headers={
        "X-Agent37-Key": "sk_live_...",
        "Content-Type": "text/csv",
        "X-Expected-Mtime": "1781049642000"
    },
    params={
        "path": "/home/node/leads.csv",
        "overwrite": "true"
    },
    data=open("leads.csv", "rb"),
)
response.raise_for_status()
print(response.json())
```

```javascript Node wrap theme={null}
import fs from "node:fs/promises";

const query = new URLSearchParams({
  "path": "/home/node/leads.csv",
  "overwrite": "true"
});

const response = await fetch(
  "https://ab12cd34ef.agent37.app/v1/files/content" + "?" + query,
  {
    method: "PUT",
    headers: {
      "X-Agent37-Key": "sk_live_...",
      "Content-Type": "text/csv",
      "X-Expected-Mtime": "1781049642000"
    },
    body: await fs.readFile("leads.csv"),
  },
);
if (!response.ok) {
  throw new Error(await response.text());
}
console.log(await response.json());
```

```json response wrap theme={null}
{
  "name": "leads.csv",
  "path": "/home/node/leads.csv",
  "type": "file",
  "size": 18244,
  "modified": 1781049642000,
  "hidden": false
}
```

> [!TIP]
>
> **Attach a file to a turn.** Write the bytes, then pass the returned `path` in the `files` array on [`POST /v1/responses`](https://www.agent37.com/docs/agents-api/chat):
>
> ```bash wrap theme={null}
> curl https://ab12cd34ef.agent37.app/v1/responses \
>   -H "X-Agent37-Key: sk_live_..." \
>   -H "Content-Type: application/json" \
>   -d '{
>     "input": "Summarize the attached spreadsheet.",
>     "files": ["/home/node/leads.csv"]
>   }'
> ```
>
> Each entry must name an existing file on the instance, or the call returns `400 validation_error`.

## Delete a file or directory

`DELETE /v1/files?path=…` removes the path recursively and by force, like `rm -rf`: a directory and everything under it goes in one call. There is no confirmation and no guard, so a wrong `path` is gone from the disk; the way back is [restoring a backup](https://www.agent37.com/docs/agents-api/instances/restore.md), which rolls the whole instance back to that point and drops everything written since. A symlink is removed itself, not followed. The response is `{ "ok": true }`.

**path** `string` *required*

The file or directory to delete. Accepts absolute and `~/` paths. A missing or empty `path` returns `400 validation_error`.

```bash curl wrap theme={null}
curl -X DELETE \
  https://ab12cd34ef.agent37.app/v1/files \
  --url-query "path=/home/node/reports" \
  -H "X-Agent37-Key: sk_live_..."
```

```python Python wrap theme={null}
import requests

response = requests.delete(
    "https://ab12cd34ef.agent37.app/v1/files",
    headers={
        "X-Agent37-Key": "sk_live_..."
    },
    params={
        "path": "/home/node/reports"
    },
)
response.raise_for_status()
print(response.json())
```

```javascript Node wrap theme={null}
const query = new URLSearchParams({
  "path": "/home/node/reports"
});

const response = await fetch(
  "https://ab12cd34ef.agent37.app/v1/files" + "?" + query,
  {
    method: "DELETE",
    headers: {
      "X-Agent37-Key": "sk_live_..."
    },
  },
);
if (!response.ok) {
  throw new Error(await response.text());
}
console.log(await response.json());
```

```json response wrap theme={null}
{ "ok": true }
```

> [!WARNING]
>
> Delete is recursive and unguarded. It removes whatever the key can reach, including directories full of files, and the only undo is [restoring a backup](https://www.agent37.com/docs/agents-api/instances/restore.md). Double-check `path` before you send it.

## Rename or move a file

`PATCH /v1/files` renames or moves a path with `fs.rename`, taking a body of `{ "from", "to" }`. The OS decides the edge cases (overwriting an existing `to`, moving into a directory, crossing devices), so behavior matches a shell `mv`. The response is the [`FileEntry`](#the-file-entry) of the new path.

**from** `string` *required*

The current path. Accepts absolute and `~/` paths. Empty returns `400 validation_error`.

**to** `string` *required*

The new path. Accepts absolute and `~/` paths. Empty returns `400 validation_error`.

```bash curl wrap theme={null}
curl -X PATCH \
  https://ab12cd34ef.agent37.app/v1/files \
  -H "X-Agent37-Key: sk_live_..." \
  -H "Content-Type: application/json" \
  -d '{
    "from": "/home/node/leads.csv",
    "to": "/home/node/archive/leads.csv"
  }'
```

```python Python wrap theme={null}
import requests

response = requests.patch(
    "https://ab12cd34ef.agent37.app/v1/files",
    headers={
        "X-Agent37-Key": "sk_live_...",
        "Content-Type": "application/json"
    },
    json={
        "from": "/home/node/leads.csv",
        "to": "/home/node/archive/leads.csv"
    },
)
response.raise_for_status()
print(response.json())
```

```javascript Node wrap theme={null}
const response = await fetch(
  "https://ab12cd34ef.agent37.app/v1/files",
  {
    method: "PATCH",
    headers: {
      "X-Agent37-Key": "sk_live_...",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      "from": "/home/node/leads.csv",
      "to": "/home/node/archive/leads.csv"
    }),
  },
);
if (!response.ok) {
  throw new Error(await response.text());
}
console.log(await response.json());
```

```json response wrap theme={null}
{
  "name": "leads.csv",
  "path": "/home/node/archive/leads.csv",
  "type": "file",
  "size": 18244,
  "modified": 1781049642000,
  "hidden": false
}
```

## Create a directory

`POST /v1/files/dir?path=…` creates a directory and any missing parents (`mkdir -p`). It is idempotent: a path that already exists returns its [`FileEntry`](#the-file-entry) rather than erroring.

**path** `string` *required*

The directory to create. Accepts absolute and `~/` paths; parents are created as needed. A missing or empty `path` returns `400 validation_error`.

```bash curl wrap theme={null}
curl -X POST \
  https://ab12cd34ef.agent37.app/v1/files/dir \
  --url-query "path=/home/node/archive" \
  -H "X-Agent37-Key: sk_live_..."
```

```python Python wrap theme={null}
import requests

response = requests.post(
    "https://ab12cd34ef.agent37.app/v1/files/dir",
    headers={
        "X-Agent37-Key": "sk_live_..."
    },
    params={
        "path": "/home/node/archive"
    },
)
response.raise_for_status()
print(response.json())
```

```javascript Node wrap theme={null}
const query = new URLSearchParams({
  "path": "/home/node/archive"
});

const response = await fetch(
  "https://ab12cd34ef.agent37.app/v1/files/dir" + "?" + query,
  {
    method: "POST",
    headers: {
      "X-Agent37-Key": "sk_live_..."
    },
  },
);
if (!response.ok) {
  throw new Error(await response.text());
}
console.log(await response.json());
```

```json response wrap theme={null}
{
  "name": "archive",
  "path": "/home/node/archive",
  "type": "directory",
  "size": null,
  "modified": 1781049600000,
  "hidden": false
}
```

## The loop

The common cycle is write, attach, fetch:

1. `PUT /v1/files/content?path=…` with the input bytes; keep the returned `path`.
2. `POST /v1/responses` with your `input` and that path in `files`.
3. When the agent replies that it wrote a file, `GET /v1/files/content?path=…` to fetch it, or `GET /v1/files` to browse what it left behind.


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.