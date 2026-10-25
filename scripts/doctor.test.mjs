import test from 'node:test';
import assert from 'node:assert/strict';
import { doctorOptions } from './doctor.mjs';
test('doctor defaults to offline prerequisites and live checks require an explicit flag', () => {
  assert.deepEqual(doctorOptions([]), { live: false });
  assert.deepEqual(doctorOptions(['--live']), { live: true });
  assert.throws(() => doctorOptions(['--live', '--live']));
  assert.throws(() => doctorOptions(['--print-secrets']));
});
