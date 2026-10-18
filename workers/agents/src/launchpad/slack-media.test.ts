import { describe, expect, it, vi } from "vitest";
import { downloadSlackAttachments, hasSlackFiles } from "./slack-media.js";
import { getAdapter } from "./channels.js";
import { buildPairing } from "./channel-pairing.js";

const raw = { user: "U123", channel: "D123", ts: "1.25", thread_ts: "1.20", files: [{ id: "F123", name: "../invoice.pdf" }] };

describe("Slack attachment ingress", () => {
  it("requests the least additional Slack scope needed for private file downloads", () => {
    const result = buildPairing({ SLACK_CLIENT_ID: "client-id", PUBLIC_AGENTS_URL: "https://agents.example" }, "slack", "cp_" + "a".repeat(32));
    expect(result.ok).toBe(true);
    if (result.ok) expect(new URL(result.url).searchParams.get("scope")?.split(",")).toContain("files:read");
  });

  it("allows media-only signed events and resolves the file via files.info", async () => {
    expect(hasSlackFiles(raw)).toBe(true);
    expect(getAdapter("slack")?.normalizeInbound(raw)).toMatchObject({ channel: "slack", channel_user_id: "U123", recipient_id: "D123", thread_id: "1.20", text: "", external_id: "1.25" });
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ok: true, file: { name: "../invoice.pdf", mimetype: "application/pdf", size: 4, url_private_download: "https://files.slack.com/files-pri/T1-F123/download/invoice.pdf" } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3, 4])));
    const files = await downloadSlackAttachments(raw, { botToken: "xoxb-private", fetcher });
    expect(files).toEqual([{ filename: "_invoice.pdf", mimeType: "application/pdf", bytes: new Uint8Array([1, 2, 3, 4]) }]);
    expect(String(fetcher.mock.calls[0]![0])).toBe("https://slack.com/api/files.info?file=F123");
    expect((fetcher.mock.calls[1]![1] as RequestInit).headers).toEqual({ authorization: "Bearer xoxb-private" });
    expect((fetcher.mock.calls[1]![1] as RequestInit).redirect).toBe("manual");
  });

  it("fails closed on missing scope, hostile URLs, and declared oversize files", async () => {
    await expect(downloadSlackAttachments(raw, {})).rejects.toThrow("slack_media_unavailable");
    const hostile = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true, file: { name: "a", size: 1, url_private_download: "https://attacker.example/file" } }));
    await expect(downloadSlackAttachments(raw, { botToken: "token", fetcher: hostile })).rejects.toThrow("slack_media_url_rejected");
    const large = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true, file: { name: "a", size: 5 * 1024 * 1024 + 1, url_private_download: "https://files.slack.com/file" } }));
    await expect(downloadSlackAttachments(raw, { botToken: "token", fetcher: large })).rejects.toThrow("slack_media_rejected");
  });
});
