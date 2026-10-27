import { describe, expect, it, vi } from "vitest";
import { getAdapter } from "./channels.js";
import {
  downloadTelegramAttachments,
  hasTelegramMedia,
} from "./telegram-media.js";

const update = {
  update_id: 3,
  message: {
    message_id: 2,
    date: 100,
    chat: { id: 4 },
    from: { id: 4 },
    document: {
      file_id: "file-id",
      file_unique_id: "unique",
      file_name: "../invoice.pdf",
      mime_type: "application/pdf",
      file_size: 4,
    },
  },
};

describe("Telegram attachment ingress", () => {
  it("rejects more than five attachments before making provider requests", async () => {
    const multiFile = { message: { document: { file_id: "1" }, audio: { file_id: "2" }, voice: { file_id: "3" }, video: { file_id: "4" }, animation: { file_id: "5" }, sticker: { file_id: "6" } } };
    const fetcher = vi.fn<typeof fetch>();
    await expect(downloadTelegramAttachments(multiFile, { botToken: "token", fetcher })).rejects.toThrow("telegram_media_rejected");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("accepts media-only updates and downloads bounded Bot API files", async () => {
    expect(hasTelegramMedia(update)).toBe(true);
    expect(getAdapter("telegram")?.normalizeInbound(update)).toMatchObject({
      channel: "telegram",
      text: "",
      external_id: "4:2",
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          result: { file_path: "documents/file_1.pdf", file_size: 4 },
        })
      )
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3, 4])));
    const files = await downloadTelegramAttachments(update, {
      botToken: "bot-token",
      fetcher,
    });
    expect(files).toEqual([
      {
        filename: "_invoice.pdf",
        mimeType: "application/pdf",
        bytes: new Uint8Array([1, 2, 3, 4]),
      },
    ]);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain(
      "getFile?file_id=file-id"
    );
    expect(String(fetcher.mock.calls[1]?.[0])).toBe(
      "https://api.telegram.org/file/botbot-token/documents/file_1.pdf"
    );
    expect((fetcher.mock.calls[1]?.[1] as RequestInit).redirect).toBe("manual");
  });

  it("rejects provider path traversal, missing credentials, and oversized metadata", async () => {
    const traversal = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        ok: true,
        result: { file_path: "../outside", file_size: 1 },
      })
    );
    await expect(
      downloadTelegramAttachments(update, {
        botToken: "token",
        fetcher: traversal,
      })
    ).rejects.toThrow("telegram_media_rejected");
    await expect(downloadTelegramAttachments(update, {})).rejects.toThrow(
      "telegram_media_unavailable"
    );
    const oversized = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        ok: true,
        result: { file_path: "large.bin", file_size: 5 * 1024 * 1024 + 1 },
      })
    );
    await expect(
      downloadTelegramAttachments(update, {
        botToken: "token",
        fetcher: oversized,
      })
    ).rejects.toThrow("telegram_media_rejected");
  });

  it("enforces the shared 15 MiB aggregate before downloading the next file", async () => {
    const fiveMiB = 5 * 1024 * 1024;
    const multiFile = {
      message: {
        document: { file_id: "doc" },
        audio: { file_id: "audio" },
        voice: { file_id: "voice" },
        video: { file_id: "video" },
        animation: { file_id: "animation" },
      },
    };
    const replies: Response[] = [];
    for (const filePath of ["doc", "audio", "voice", "video"]) {
      replies.push(
        Response.json({
          ok: true,
          result: { file_path: `${filePath}.bin`, file_size: fiveMiB },
        })
      );
      if (filePath !== "video")
        replies.push(new Response(new Uint8Array(fiveMiB)));
    }
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      const response = replies.shift();
      if (!response) throw new Error("unexpected_telegram_test_fetch");
      return response;
    });
    await expect(
      downloadTelegramAttachments(multiFile, { botToken: "token", fetcher })
    ).rejects.toThrow("telegram_media_rejected");
    expect(fetcher).toHaveBeenCalledTimes(7);
  });

  it("rejects unknown-size media when the aggregate budget is already exhausted", async () => {
    const fiveMiB = 5 * 1024 * 1024;
    const multiFile = {
      message: {
        document: { file_id: "doc" },
        audio: { file_id: "audio" },
        voice: { file_id: "voice" },
        video: { file_id: "video" },
      },
    };
    const replies: Response[] = [];
    for (const filePath of ["doc", "audio", "voice"]) {
      replies.push(
        Response.json({
          ok: true,
          result: { file_path: `${filePath}.bin`, file_size: fiveMiB },
        }),
        new Response(new Uint8Array(fiveMiB))
      );
    }
    replies.push(
      Response.json({ ok: true, result: { file_path: "video.bin" } })
    );
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      const response = replies.shift();
      if (!response) throw new Error("unexpected_telegram_test_fetch");
      return response;
    });

    await expect(
      downloadTelegramAttachments(multiFile, { botToken: "token", fetcher })
    ).rejects.toThrow("telegram_media_rejected");
    expect(fetcher).toHaveBeenCalledTimes(7);
  });
});
