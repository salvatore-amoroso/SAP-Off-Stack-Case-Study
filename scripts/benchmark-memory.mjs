export const minimumHostFreeMemoryBytes = 2 * 1024 ** 3;

export function assertHostMemory(bytes) {
  if (!Number.isFinite(bytes) || bytes < minimumHostFreeMemoryBytes) throw new Error('HOST_MEMORY_PRESSURE_BELOW_2_GIB');
}

export function hostMemorySamplesValid(samples) {
  return Array.isArray(samples) && samples.every(sample => Number.isFinite(sample?.host?.free_memory_bytes) && sample.host.free_memory_bytes >= minimumHostFreeMemoryBytes);
}
