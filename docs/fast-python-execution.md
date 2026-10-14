# Lightweight Python execution

`code.execute_python` runs pure Python computation in a fresh provider-owned
Python/Wasm Worker. Cloudflare documents that Python Workers use Pyodide within
a V8 isolate: [How Python Workers work](https://developers.cloudflare.com/workers/languages/python/how-python-workers-work/).
The installed Cloudflare Worker Loader types support `py` modules; the host
must also enable `DYNAMIC_PYTHON_ENABLED` and provide the Loader binding.

Pass `code`, optional `input` (available as `args` in Python), and an optional
positive `timeout` of at most 30 seconds. The result contains `stdout`, `stderr`,
and an optional Python variable named `result`. The runtime bounds source,
input, output, CPU and wall time. Fresh execution globals avoid carrying state
between tenants or invocations. The host sets `globalOutbound: null` and grants
no project filesystem, credentials, or tools to this pure-compute path.

This operation does not install pip packages or load Python from a remote CDN.
Unsupported imports, requested package installs, a missing runtime and timeouts
return errors. They do not silently allocate native compute. Use an explicitly
authorized container or local-machine command when native dependencies or
project files are needed. Placement, execution ceilings and egress rules still
apply; an internet tunnel is not a physically disconnected installation.

No startup-latency or cost guarantee is inferred from the transcript. Blocking
network access is not proof of a physical air gap. Google's internal sandbox
architecture was not established by the conversation; the proposed gVisor,
hot-pool and fixed-latency explanations are not implementation evidence.

Local tests execute the generated harness using CPython and a doubled Worker
transport, and exercise deadline/capacity/error behavior through the real
Naelao runner. They do not establish live Cloudflare Wasm, provider CPU limit,
or deployed egress enforcement.
