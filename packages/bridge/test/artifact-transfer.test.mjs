import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { MACHINE_ARTIFACT_STAGING_TTL_MS, readMachineArtifact, writeMachineArtifact } from "../src/artifact-transfer.mjs";

test("machine artifact handoff is binary-safe, bounded, and create-only when requested", async () => {
  const directory = await mkdtemp(join(tmpdir(), "naelao-artifact-test-"));
  try {
    const source = join(directory, "source.bin"), target = join(directory, "target.bin");
    const bytes = Buffer.from([0, 255, 13, 10, 128]);
    await writeFile(source, bytes);
    const transfer = await readMachineArtifact(source);
    assert.deepEqual(transfer, { encoding: "base64", content: bytes.toString("base64"), bytes: bytes.length });
    assert.deepEqual(await writeMachineArtifact(target, { content: transfer.content, create_only: true }), { written: true, bytes: bytes.length });
    assert.deepEqual(await readFile(target), bytes);
    await assert.rejects(writeMachineArtifact(target, { content: transfer.content, create_only: true }));
    await assert.rejects(writeMachineArtifact(join(directory, "bad"), { content: "AQI" } ), /bridge_file_result_limit/);
    await writeFile(source, Buffer.alloc(12 * 1024 + 1));
    await assert.rejects(readMachineArtifact(source), /bridge_file_result_limit/);
    const oversizedTarget = join(directory, "oversized-target.bin"), oversizedLink = join(directory, "oversized-link.bin");
    await writeFile(oversizedTarget, Buffer.alloc(12 * 1024 + 1));
    await symlink(oversizedTarget, oversizedLink);
    await assert.rejects(readMachineArtifact(oversizedLink));
    await assert.rejects(writeMachineArtifact(join(directory, "large"), { content: Buffer.alloc(12 * 1024 + 1).toString("base64") }), /bridge_file_result_limit/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("resumes bounded binary chunks and publishes only a complete verified file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "naelao-chunk-transfer-"));
  try {
    const source = join(directory, "large.bin"), target = join(directory, "restored.bin");
    const bytes = Buffer.from(Array.from({ length: 2 * 1024 * 1024 + 137 }, (_, index) => index % 251));
    await writeFile(source, bytes);
    const first = await readMachineArtifact(source, { offset: 0, length: 0 });
    const chunks = [];
    for (let offset = 0; offset < bytes.length; offset += 8192) {
      chunks.push(await readMachineArtifact(source, { offset, length: Math.min(8192, bytes.length - offset), fingerprint: first.fingerprint }));
    }
    assert.deepEqual(Buffer.concat(chunks.map(chunk => Buffer.from(chunk.content, "base64"))), bytes);

    const digest = createHash("sha256").update(bytes).digest("hex"), transferId = "a".repeat(64);
    for (let offset = 0; offset < bytes.length; offset += 8192) {
      const part = bytes.subarray(offset, Math.min(offset + 8192, bytes.length));
      const result = await writeMachineArtifact(target, { encoding: "base64", content: part.toString("base64"), transfer_id: transferId,
        offset, total_bytes: bytes.length, sha256: digest, finalize: offset + part.length === bytes.length });
      if (offset + part.length === bytes.length) assert.equal(result.finalized, true);
    }
    assert.deepEqual(await readFile(target), bytes);
    const lastOffset = Math.floor((bytes.length - 1) / 8192) * 8192;
    const last = bytes.subarray(lastOffset);
    assert.deepEqual(await writeMachineArtifact(target, { encoding: "base64", content: last.toString("base64"), transfer_id: transferId,
      offset: lastOffset, total_bytes: bytes.length, sha256: digest, finalize: true }),
    { written: true, bytes: last.length, total_bytes: bytes.length, sha256: digest, finalized: true, deduplicated: true });
    await assert.rejects(writeMachineArtifact(join(directory, "too-large"), { encoding: "base64", content: "AA==", transfer_id: "c".repeat(64),
      offset: 0, total_bytes: 16 * 1024 * 1024 + 1, sha256: digest, finalize: false }), /bridge_file_transfer_invalid/);
    await assert.rejects(writeMachineArtifact(target, { encoding: "base64", content: bytes.subarray(0, 10).toString("base64"), transfer_id: "b".repeat(64),
      offset: 0, total_bytes: 10, sha256: createHash("sha256").update(bytes.subarray(0, 10)).digest("hex"), finalize: true }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("expires abandoned transfer staging files after the retention window", async () => {
  const directory = await mkdtemp(join(tmpdir(), "naelao-staging-expiry-"));
  try {
    const stale = join(directory, `.naelao-${"d".repeat(64)}.part`), target = join(directory, "target.bin");
    await writeFile(stale, Buffer.from("partial"));
    const old = new Date(Date.now() - MACHINE_ARTIFACT_STAGING_TTL_MS - 1000);
    await utimes(stale, old, old);
    const bytes = Buffer.from("new transfer"), digest = createHash("sha256").update(bytes).digest("hex");
    await writeMachineArtifact(target, { content: bytes.toString("base64"), transfer_id: "e".repeat(64), offset: 0,
      total_bytes: bytes.length, sha256: digest, finalize: false });
    await assert.rejects(readFile(stale), { code: "ENOENT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
