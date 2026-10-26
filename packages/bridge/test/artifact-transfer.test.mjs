import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMachineArtifact, writeMachineArtifact } from "../src/artifact-transfer.mjs";

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
