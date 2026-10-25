import test from 'node:test';
import assert from 'node:assert/strict';
import { benchmarkOptions } from '../src/benchmark.mjs';

test('benchmark arguments have fixed defaults and reject ambiguous or invalid values', () => {
  assert.deepEqual(benchmarkOptions([]), { duration_seconds: 180, warmup_scans: 5 });
  assert.deepEqual(benchmarkOptions(['--duration-seconds', '3', '--warmup-scans', '1']), { duration_seconds: 3, warmup_scans: 1 });
  for (const args of [['--duration-seconds'], ['--duration-seconds', '0'], ['--warmup-scans', '1.5'], ['--duration-seconds', '3', '--duration-seconds', '4'], ['--unknown', '1']]) assert.throws(() => benchmarkOptions(args));
});
