import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { benchmarkOptions } from './benchmark.mjs';
import { sqlConfig } from './sql-config.mjs';
import { scanSql } from './sql-poller.mjs';
import { createSqlSession } from './sql-transport.mjs';

export async function benchmarkSql(config, options, createAdapter) {
  const session = createAdapter ? null : createSqlSession();
  createAdapter ??= session.createAdapter;
  const records = [];
  let index = 0, warmupCount = 0, measuredCount = 0, measuredWall = 0, failed = false;
  async function one(phase) {
    const result = await scanSql(config, createAdapter, index++);
    records.push({ kind: 'scan', phase, ...result });
    failed ||= result.outcome !== 'ok';
  }
  try {
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
  } finally {
    if (session) await session.close().catch(() => { failed = true; });
  }
  records.push({ kind: 'summary', schema_version: 1, outcome: failed ? 'error' : 'ok', measured_wall_ms: measuredWall, measured_scans: measuredCount, warmup_scans: warmupCount, transport: config.transport, client_policy: 'persistent', fetch_size: 100 });
  return { records, exit_code: failed ? 1 : 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2), sqlArgs = [], benchmarkArgs = [];
    for (let index = 0; index < args.length; index += 2) {
      (['--transport', '--config'].includes(args[index]) ? sqlArgs : benchmarkArgs).push(args[index], args[index + 1]);
    }
    const options = benchmarkOptions(benchmarkArgs);
    const result = await benchmarkSql(await sqlConfig(sqlArgs), options);
    process.stdout.write(result.records.map(record => JSON.stringify(record)).join('\n') + '\n');
    process.exitCode = result.exit_code;
  } catch {
    process.stdout.write(`${JSON.stringify({ kind: 'scan', phase: 'warmup', ...await scanSql({}) })}\n`);
    process.stderr.write('Unable to configure or execute the SQL benchmark adapter.\n');
    process.exitCode = 2;
  }
}
