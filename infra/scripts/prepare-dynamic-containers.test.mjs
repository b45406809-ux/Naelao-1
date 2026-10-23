import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { prepareDynamicConfig } from './prepare-dynamic-containers.mjs';
const source = await readFile(new URL('../../workers/agents/wrangler.toml', import.meta.url), 'utf8');
const image = `registry.cloudflare.com/${'a'.repeat(32)}/tool@sha256:${'b'.repeat(64)}`;
const pin = { image, binding: 'TOOL_SANDBOX', schedulingPolicy: 'durable_object', networkPolicy: 'none', cpuCores: .5, memoryMb: 4096 };
test('publishes the reviewed registry and image map in one selected environment, idempotently', () => {
  for (const env of ['staging', 'production', 'default']) {
    const updated = prepareDynamicConfig(source, [pin], env);
    assert.equal(updated.split(`image = "${image}"`).length - 1, 1);
    assert.equal(updated.split('CONTAINER_IMAGE_REGISTRY = ').length - 1, 1);
    assert.equal(prepareDynamicConfig(updated, [pin], env), updated);
    assert.match(updated, /DYNAMIC_CONTAINERS_ENABLED = "false"/);
    const cleared = prepareDynamicConfig(updated, [], env);
    assert.ok(!cleared.includes(image));
  }
});
test('rejects mutable, foreign-registry and over-capacity image sets', () => {
  assert.throws(() => prepareDynamicConfig(source, [{ ...pin, image: 'docker.io/library/node:latest' }], 'staging'));
  assert.throws(() => prepareDynamicConfig(source, [pin, pin], 'staging'));
  assert.throws(() => prepareDynamicConfig(source, Array(100).fill(pin), 'staging'));
  assert.throws(() => prepareDynamicConfig(source, [{ ...pin, schedulingPolicy: 'default' }], 'staging'));
  assert.throws(() => prepareDynamicConfig(source, [pin], 'other'));
});
