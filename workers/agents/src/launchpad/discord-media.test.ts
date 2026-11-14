import { describe, expect, it, vi } from "vitest";
import { getAdapter } from "./channels.js";
import { DISCORD_ATTACHMENT_LIMITS } from "./channel-media-capabilities.js";
import { downloadDiscordAttachments, hasDiscordAttachments } from "./discord-media.js";

const NOW = Date.UTC(2026, 10, 14, 12);
const CHANNEL_ID = "123456789012345678";
const ATTACHMENT_ID = "234567890123456789";
function attachmentUrl(overrides: { channelId?: string; attachmentId?: string; expiresAt?: number; issuedAt?: number; signature?: string } = {}) {
  const issuedAt = overrides.issuedAt ?? Math.floor(NOW / 1_000);
  const expiresAt = overrides.expiresAt ?? issuedAt + 60;
  return `https://cdn.discordapp.com/attachments/${overrides.channelId ?? CHANNEL_ID}/${overrides.attachmentId ?? ATTACHMENT_ID}/scan.pdf`
    + `?ex=${expiresAt.toString(16)}&is=${issuedAt.toString(16)}&hm=${overrides.signature ?? "a".repeat(64)}`;
}
const raw = { id: "345678901234567890", channel_id: CHANNEL_ID, author: { id: "U123" }, attachments: [{ id: ATTACHMENT_ID, filename: "../scan.pdf", content_type: "application/pdf", size: 3, ephemeral: true, url: attachmentUrl() }] };
const download = (event: Record<string, unknown>, input: { fetcher?: typeof fetch; now?: number } = {}) =>
  downloadDiscordAttachments(event, { now: NOW, ...input });

describe("Discord attachment ingress", () => {
  it("rejects more than five attachments before requesting any CDN file", async () => {
    expect(DISCORD_ATTACHMENT_LIMITS).toEqual({ maxFiles: 5, maxFileBytes: 5 * 1024 * 1024,
      maxTotalBytes: 15 * 1024 * 1024, retentionDays: 30 });
    const tooMany = { attachments: Array.from({ length: 6 }, (_, index) => ({ ...raw.attachments[0], id: `A${index}` })) };
    const fetcher = vi.fn<typeof fetch>();
    await expect(download(tooMany, { fetcher })).rejects.toThrow("discord_media_rejected");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("validates all privacy and declared-size limits before downloading any file", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const mixed = { ...raw, attachments: [raw.attachments[0], { ...raw.attachments[0], id: ATTACHMENT_ID, ephemeral: false }] };
    await expect(download(mixed, { fetcher })).rejects.toThrow("discord_non_ephemeral_media_unavailable_from_workers");
    const overAggregate = { attachments: Array.from({ length: 4 }, (_, index) => ({ ...raw.attachments[0],
      id: `large-${index}`, size: DISCORD_ATTACHMENT_LIMITS.maxFileBytes })) };
    await expect(download(overAggregate, { fetcher })).rejects.toThrow("discord_media_rejected");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("accepts media-only events and ingests bounded ephemeral CDN files", async () => {
    expect(hasDiscordAttachments(raw)).toBe(true);
    expect(getAdapter("discord")?.normalizeInbound(raw)).toMatchObject({ channel: "discord", text: "", external_id: raw.id });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
    await expect(download(raw, { fetcher })).resolves.toEqual([
      { filename: "_scan.pdf", mimeType: "application/pdf", bytes: new Uint8Array([1, 2, 3]) },
    ]);
    expect((fetcher.mock.calls[0]![1] as RequestInit).redirect).toBe("manual");
  });

  it("infers known filename types when Discord metadata is absent or generic", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
    await expect(download({ ...raw, attachments: [{ ...raw.attachments[0], content_type: "application/octet-stream" }] }, { fetcher }))
      .resolves.toMatchObject([{ filename: "_scan.pdf", mimeType: "application/pdf" }]);
    const opaque = { ...raw, attachments: [{ ...raw.attachments[0], filename: "scan.unknown", content_type: undefined }] };
    const opaqueFetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
    await expect(download(opaque, { fetcher: opaqueFetcher })).resolves.toMatchObject([{ mimeType: "application/octet-stream" }]);
  });

  it("rejects non-ephemeral attachments, non-CDN URLs, mismatched message paths, and size mismatches", async () => {
    await expect(download({ ...raw, attachments: [{ ...raw.attachments[0], ephemeral: false }] })).rejects.toThrow("discord_non_ephemeral_media_unavailable_from_workers");
    const hostile = { ...raw, attachments: [{ ...raw.attachments[0], url: "https://attacker.example/file" }] };
    await expect(download(hostile)).rejects.toThrow("discord_media_url_rejected");
    const alternatePortFetcher = vi.fn<typeof fetch>();
    const alternatePort = { ...raw, attachments: [{ ...raw.attachments[0], url: "https://cdn.discordapp.com:8443/attachments/1/2/scan.pdf" }] };
    await expect(download(alternatePort, { fetcher: alternatePortFetcher })).rejects.toThrow("discord_media_url_rejected");
    expect(alternatePortFetcher).not.toHaveBeenCalled();
    const short = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array([1, 2])));
    await expect(download(raw, { fetcher: short })).rejects.toThrow("discord_media_size_mismatch");
    const mismatchedAttachment = { ...raw, attachments: [{ ...raw.attachments[0], url: attachmentUrl({ attachmentId: "999999999999999999" }) }] };
    await expect(download(mismatchedAttachment, { fetcher: alternatePortFetcher })).rejects.toThrow("discord_media_url_rejected");
    const mismatchedChannel = { ...raw, attachments: [{ ...raw.attachments[0], url: attachmentUrl({ channelId: "999999999999999999" }) }] };
    await expect(download(mismatchedChannel, { fetcher: alternatePortFetcher })).rejects.toThrow("discord_media_url_rejected");
    expect(alternatePortFetcher).not.toHaveBeenCalled();
  });

  it("requires a current, signed CDN URL before making a request", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const expired = { ...raw, attachments: [{ ...raw.attachments[0], url: attachmentUrl({ expiresAt: Math.floor(NOW / 1_000) }) }] };
    await expect(download(expired, { fetcher })).rejects.toThrow("discord_media_url_expired");
    const unsigned = { ...raw, attachments: [{ ...raw.attachments[0], url: `https://cdn.discordapp.com/attachments/${CHANNEL_ID}/${ATTACHMENT_ID}/scan.pdf?ex=ffffffff&is=eeeeeeee` }] };
    await expect(download(unsigned, { fetcher })).rejects.toThrow("discord_media_url_rejected");
    const futureIssued = { ...raw, attachments: [{ ...raw.attachments[0], url: attachmentUrl({ issuedAt: Math.floor(NOW / 1_000) + 301 }) }] };
    await expect(download(futureIssued, { fetcher })).rejects.toThrow("discord_media_url_expired");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects provider-declared response lengths above the download cap before reading bytes", async () => {
    const response = new Response(new Uint8Array([1, 2, 3]), { headers: { "content-length": String(DISCORD_ATTACHMENT_LIMITS.maxFileBytes + 1) } });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
    await expect(download(raw, { fetcher })).rejects.toThrow("discord_media_too_large");
  });
});
