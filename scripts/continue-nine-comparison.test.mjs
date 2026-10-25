import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { continuationPlan, continueNineComparison } from './continue-nine-comparison.mjs';
import { fixtureInputs, fixtureBlock } from './benchmark-test-fixtures.mjs';

const inputs = fixtureInputs();
const blocks = Array.from({ length: 12 }, (_, index) => fixtureBlock(index + 1, { failed: index === 11 }));
const manifest = { status: 'failed', failure: 'NINE_BENCHMARK_CORRECTNESS_GATE_FAILED', schedule: inputs.schedule,
  blocks: blocks.map(block => ({ app_id: block.app_id, passed: block.exit_code === 0 })) };
const clone = value => structuredClone(value);

test('a failed parent adopts exactly 11 valid blocks and explicitly retries slot 12', () => {
  const plan = continuationPlan(manifest, inputs, blocks);
  assert.equal(plan.adopted_count, 11);
  assert.equal(plan.retry_block_index, 12);
  assert.equal(plan.remaining_app_ids.length, 16);
  assert.equal(plan.remaining_app_ids[0], 'node-cds');
  assert.equal(plan.failed_block.records.at(-1).measured_scans, 0);
});

test('does not adopt a corrupted earlier successful block', () => {
  const changed = clone(blocks); changed[0].records[0].digest = '0'.repeat(64);
  assert.throws(() => continuationPlan(manifest, inputs, changed), /PARENT_ADOPTED_BLOCK_INVALID/);
});

test('continuation refuses memory pressure before reading inputs or contacting SAP', async t => {
  t.mock.method(os, 'freemem', () => 1024 ** 3);
  await assert.rejects(continueNineComparison('results/not-a-real-run'), /HOST_MEMORY_PRESSURE_BELOW_2_GIB/);
});

test('continuation never adopts a successful block collected under memory pressure', () => {
  const changed = clone(blocks);
  changed[0].resource_samples = [{ host: { free_memory_bytes: 1024 ** 3 } }];
  assert.throws(() => continuationPlan(manifest, inputs, changed), /PARENT_ADOPTED_BLOCK_INVALID/);
});

test('does not discard measured data by retrying a failed measured block', () => {
  const changed = clone(blocks), record = clone(changed.at(-1).records[0]);
  record.phase = 'measured'; changed.at(-1).records.splice(1, 0, record);
  assert.throws(() => continuationPlan(manifest, inputs, changed), /ONLY_FAILED_WARMUP_CAN_BE_RETRIED/);
});

test('requires the exact original production protocol and schedule', () => {
  for (const change of [
    value => { value.configuration.duration_seconds = 30; },
    value => { value.configuration.warmup_scans = 1; },
    value => { value.configuration.retries = 1; },
    value => { value.schedule[0].reverse(); },
  ]) {
    const changed = clone(inputs); change(changed);
    assert.throws(() => continuationPlan(manifest, changed, blocks), /UNSUPPORTED_CONTINUATION_PARENT/);
  }
});

test('rejects changed slot identities and a parent that was not failed', () => {
  const changed = clone(blocks); changed[2].app_id = 'rust-http';
  assert.throws(() => continuationPlan(manifest, inputs, changed), /PARENT_BLOCK_SCHEDULE_MISMATCH/);
  assert.throws(() => continuationPlan({ ...manifest, status: 'complete' }, inputs, blocks), /UNSUPPORTED_CONTINUATION_PARENT/);
});

test('only a normalized failed warmup with bounded timing can be retried', () => {
  for (const mutate of [
    block => { block.records[0].outcome = 'ok'; },
    block => { block.records[0].digest = inputs.configuration.expected_digest; },
    block => { block.control_wall_ms = 500; },
    block => { block.records.at(-1).outcome = 'ok'; },
  ]) {
    const changed = clone(blocks); mutate(changed.at(-1));
    assert.throws(() => continuationPlan(manifest, inputs, changed), /ONLY_FAILED_WARMUP_CAN_BE_RETRIED/);
  }
});
