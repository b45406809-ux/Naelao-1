import { describe, expect, it, vi } from "vitest";
import { getAdapter } from "./channels.js";
import { DISCORD_ATTACHMENT_LIMITS } from "./channel-media-capabilities.js";
import { downloadDiscordAttachments, hasDiscordAttachments } from "./discord-media.js";

const raw = { id: "M123", author: { id: "U123" }, attachments: [{ id: "A123", filename: "../scan.pdf", content_type: "application/pdf", size: 3, ephemeral: true, url: "https://cdn.discordapp.com/attachments/1/2/scan.pdf?ex=123&hm=abc" }] };

describe("Discord attachment ingress", () => {
  it("rejects more than five attachments before requesting any CDN file", async () => {
    expect(DISCORD_ATTACHMENT_LIMITS).toEqual({ maxFiles: 5, maxFileBytes: 5 * 1024 * 1024,
      maxTotalBytes: 15 * 1024 * 1024, retentionDays: 30 });
    const tooMany = { attachments: Array.from({ length: 6 }, (_, index) => ({ ...raw.attachments[0], id: `A${index}` })) };
    const fetcher = vi.fn<typeof fetch>();
    await expect(downloadDiscordAttachments(tooMany, { fetcher })).rejects.toThrow("discord_media_rejected");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("validates all privacy and declared-size limits before downloading any file", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const mixed = { attachments: [raw.attachments[0], { ...raw.attachments[0], id: "private", ephemeral: false }] };
    await expect(downloadDiscordAttachments(mixed, { fetcher })).rejects.toThrow("discord_non_ephemeral_media_unavailable_from_workers");
    const overAggregate = { attachments: Array.from({ length: 4 }, (_, index) => ({ ...raw.attachments[0],
      id: `large-${index}`, size: DISCORD_ATTACHMENT_LIMITS.maxFileBytes })) };
    await expect(downloadDiscordAttachments(overAggregate, { fetcher })).rejects.toThrow("discord_media_rejected");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("accepts media-only events and ingests bounded ephemeral CDN files", async () => {
    expect(hasDiscordAttachments(raw)).toBe(true);
    expect(getAdapter("discord")?.normalizeInbound(raw)).toMatchObject({ channel: "discord", text: "", external_id: "M123" });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
    await expect(downloadDiscordAttachments(raw, { fetcher })).resolves.toEqual([
      { filename: "_scan.pdf", mimeType: "application/pdf", bytes: new Uint8Array([1, 2, 3]) },
    ]);
    expect((fetcher.mock.calls[0]![1] as RequestInit).redirect).toBe("manual");
  });

  it("infers known filename types when Discord metadata is absent or generic", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
    await expect(downloadDiscordAttachments({ attachments: [{ ...raw.attachments[0], content_type: "application/octet-stream" }] }, { fetcher }))
      .resolves.toMatchObject([{ filename: "_scan.pdf", mimeType: "application/pdf" }]);
    const opaque = { attachments: [{ ...raw.attachments[0], filename: "scan.unknown", content_type: undefined }] };
    const opaqueFetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
    await expect(downloadDiscordAttachments(opaque, { fetcher: opaqueFetcher })).resolves.toMatchObject([{ mimeType: "application/octet-stream" }]);
  });

  it("rejects non-ephemeral attachments, non-CDN URLs, and size mismatches", async () => {
    await expect(downloadDiscordAttachments({ attachments: [{ ...raw.attachments[0], ephemeral: false }] })).rejects.toThrow("discord_non_ephemeral_media_unavailable_from_workers");
    const hostile = { attachments: [{ ...raw.attachments[0], url: "https://attacker.example/file" }] };
    await expect(downloadDiscordAttachments(hostile)).rejects.toThrow("discord_media_url_rejected");
    const alternatePortFetcher = vi.fn<typeof fetch>();
    const alternatePort = { attachments: [{ ...raw.attachments[0], url: "https://cdn.discordapp.com:8443/attachments/1/2/scan.pdf" }] };
    await expect(downloadDiscordAttachments(alternatePort, { fetcher: alternatePortFetcher })).rejects.toThrow("discord_media_url_rejected");
    expect(alternatePortFetcher).not.toHaveBeenCalled();
    const short = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array([1, 2])));
    await expect(downloadDiscordAttachments(raw, { fetcher: short })).rejects.toThrow("discord_media_size_mismatch");
  });
});
