import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, requestJson } from "../../apps/shell/src/lib/request";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("interactive API requests", () => {
  it("does not replay a create request whose response was lost", async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError("Connection reset"));
    vi.stubGlobal("fetch", fetch);
    await expect(requestJson("http://local/projects", { method: "POST" }, { retries: 10 })).rejects.toThrow("Refresh to check whether it saved");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("retries a transient read but never an authorization failure", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValueOnce(new Response("{}", { status: 503 })).mockResolvedValueOnce(Response.json({ data: [1] }));
    vi.stubGlobal("fetch", fetch);
    const result = requestJson("http://local/projects");
    await vi.runAllTimersAsync();
    expect(await result).toEqual({ data: [1] });
    fetch.mockClear().mockResolvedValue(new Response('{"message":"Sign in again"}', { status: 401 }));
    await expect(requestJson("http://local/projects")).rejects.toMatchObject({ status: 401, message: "Sign in again" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("releases a stalled request so the page can show Retry", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)))));
    const result = expect(requestJson("http://local/projects", {}, { retries: 0, timeoutMs: 20 })).rejects.toBeInstanceOf(ApiError);
    await vi.runAllTimersAsync();
    await result;
  });
  it("does not retry a request cancelled when a workspace changes", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("Cancelled", "AbortError"));
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(requestJson("http://local/projects", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
