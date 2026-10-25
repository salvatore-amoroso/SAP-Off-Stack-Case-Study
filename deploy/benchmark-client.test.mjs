import test from 'node:test';
import assert from 'node:assert/strict';
import { benchmarkCommand } from './benchmark-client.mjs';

test('both benchmark commands share limits and pass credentials through environment names only', () => {
  for (const implementation of ['node', 'rust']) {
    const { args } = benchmarkCommand(implementation, { durationSeconds: 3, warmupScans: 1, name: `bench-${implementation}` });
    assert.deepEqual(args.slice(0, 11), ['run', '--rm', '--cpus', '1', '--memory', '256m', '--memory-swap', '256m', '--network', 'sap-local-ports', '--name']);
    assert.ok(args.includes('SAP_USERNAME'));
    assert.ok(args.includes('SAP_PASSWORD'));
    assert.ok(args.includes(`sap-polling-${implementation}:benchmark`));
    assert.deepEqual(args.slice(-4), ['--duration-seconds', '3', '--warmup-scans', '1']);
  }
  assert.throws(() => benchmarkCommand('unknown'));
});
