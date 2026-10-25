const runtimeEnvironment = ['SAP_SERVICE_ROOT', 'SAP_CLIENT', 'SAP_USERNAME', 'SAP_PASSWORD', 'EXPECTED_ROWS', 'EXPECTED_DIGEST', 'SAP_TLS_INSECURE', 'PAGE_SIZE', 'REQUEST_TIMEOUT_SECONDS', 'SCAN_TIMEOUT_SECONDS', 'MAX_BODY_BYTES', 'MAX_PAGES'];

export function benchmarkCommand(implementation, { durationSeconds = 180, warmupScans = 5, name } = {}) {
  if (!['node', 'rust'].includes(implementation)) throw new Error('Unknown benchmark implementation');
  const args = ['run', '--rm', '--cpus', '1', '--memory', '256m', '--memory-swap', '256m', '--network', 'sap-local-ports'];
  if (name) args.push('--name', name);
  for (const key of runtimeEnvironment) args.push('--env', key);
  if (implementation === 'node') args.push('--env', 'UV_THREADPOOL_SIZE=1', '--entrypoint', 'node');
  args.push(`sap-polling-${implementation}:benchmark`);
  if (implementation === 'node') args.push('--v8-pool-size=1', '/app/src/benchmark.mjs');
  else args.push('--benchmark');
  args.push('--duration-seconds', String(durationSeconds), '--warmup-scans', String(warmupScans));
  return { program: process.env.DOCKER_EXE || 'docker', args };
}
