import test from 'node:test';
import assert from 'node:assert/strict';
import { assertHostMemory, hostMemorySamplesValid, minimumHostFreeMemoryBytes } from './benchmark-memory.mjs';

test('official memory policy rejects missing, invalid and below-threshold samples', () => {
  assert.doesNotThrow(() => assertHostMemory(minimumHostFreeMemoryBytes));
  assert.equal(hostMemorySamplesValid([{ host: { free_memory_bytes: minimumHostFreeMemoryBytes } }]), true);
  for (const bytes of [undefined, NaN, Infinity, -1, 0, minimumHostFreeMemoryBytes - 1]) {
    assert.throws(() => assertHostMemory(bytes), /HOST_MEMORY_PRESSURE/);
    assert.equal(hostMemorySamplesValid([{ host: { free_memory_bytes: bytes } }]), false);
  }
  assert.equal(hostMemorySamplesValid(undefined), false);
  assert.equal(hostMemorySamplesValid([{}]), false);
  assert.equal(hostMemorySamplesValid([]), true);
});
