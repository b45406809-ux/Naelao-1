const MIB = 1024 * 1024;
export const CHANNEL_ATTACHMENT_RETENTION_DAYS = 30;

export const DISCORD_ATTACHMENT_LIMITS = Object.freeze({
  maxFiles: 5,
  maxFileBytes: 5 * MIB,
  maxTotalBytes: 15 * MIB,
  retentionDays: CHANNEL_ATTACHMENT_RETENTION_DAYS,
});

/** Public, versioned description of the host's current inbound-media contract. These are
 * Naelao processing and retention limits, not Discord's general upload limits. */
export const CHANNEL_MEDIA_CAPABILITIES = Object.freeze({
  schema_version: 1,
  channels: {
    discord: {
      inbound_attachments: {
        supported: true,
        retrieval: "ephemeral_cdn_reference_only",
        ordinary_server_attachments_supported: false,
        max_files: DISCORD_ATTACHMENT_LIMITS.maxFiles,
        max_file_bytes: DISCORD_ATTACHMENT_LIMITS.maxFileBytes,
        max_total_bytes: DISCORD_ATTACHMENT_LIMITS.maxTotalBytes,
        retained_up_to_days: DISCORD_ATTACHMENT_LIMITS.retentionDays,
        content_type_behavior: "Valid provider MIME is preserved; known file extensions are inferred; unknown types remain application/octet-stream. Owner-approved installed channel handlers may receive exact-message handles: bounded text extraction or at most one PNG, JPEG or WebP image up to 480 KiB.",
        extension_file_handles: true,
      },
    },
  },
});

export type ChannelMediaCapabilities = typeof CHANNEL_MEDIA_CAPABILITIES;
