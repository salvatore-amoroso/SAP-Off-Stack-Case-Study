import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { liveConfig } from './config.mjs';
import { normalizeConfig, scan } from './poller.mjs';
import { createLiveFetcher } from './transport.mjs';

export function benchmarkOptions(args) {
  const options = { duration_seconds: 180, warmup_scans: 5 };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (!['--duration-seconds', '--warmup-scans'].includes(flag) || seen.has(flag) || typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error('Invalid benchmark arguments');
    seen.add(flag);
    const field = flag === '--duration-seconds' ? 'duration_seconds' : 'warmup_scans';
    options[field] = Number(value);
    if (!Number.isSafeInteger(options[field]) || options[field] < 1 || options[field] > (field === 'duration_seconds' ? 3600 : 1000)) throw new Error('Benchmark argument outside bounds');
  }
  return options;
}

export async function benchmark(config, options, username, password) {
  const records = [];
  let index = 0, warmupCount = 0, measuredCount = 0, measuredWall = 0, failed = false;
  async function one(phase) {
    const started = performance.now();
    const transport = await createLiveFetcher(config, username, password);
    let result;
    try { result = await scan(config, transport.fetch, index++); }
    finally { await transport.close(); }
    result.metrics.elapsed_ms = performance.now() - started;
    records.push({ kind: 'scan', phase, ...result });
    failed ||= result.outcome !== 'ok';
  }
  for (; warmupCount < options.warmup_scans; warmupCount++) {
    await one('warmup');
    if (failed) { warmupCount++; break; }
  }
  if (!failed) {
    const started = performance.now();
    while (performance.now() - started < options.duration_seconds * 1000) {
      await one('measured');
      measuredCount++;
      if (failed) break;
    }
    measuredWall = performance.now() - started;
  }
  records.push({ kind: 'summary', schema_version: 1, outcome: failed ? 'error' : 'ok', measured_wall_ms: measuredWall, measured_scans: measuredCount, warmup_scans: warmupCount, transport: 'socket', client_policy: 'fresh_per_scan' });
  return { records, exit_code: failed ? 1 : 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = benchmarkOptions(process.argv.slice(2));
    const config = normalizeConfig(liveConfig());
    const result = await benchmark(config, options, process.env.SAP_USERNAME, process.env.SAP_PASSWORD);
    process.stdout.write(result.records.map(record => JSON.stringify(record)).join('\n') + '\n');
    process.exitCode = result.exit_code;
  } catch {
    const result = await scan({});
    process.stdout.write(JSON.stringify({ kind: 'scan', phase: 'warmup', ...result }) + '\n');
    process.stderr.write('Unable to configure or execute the benchmark adapter.\n');
    process.exitCode = 2;
  }
}
