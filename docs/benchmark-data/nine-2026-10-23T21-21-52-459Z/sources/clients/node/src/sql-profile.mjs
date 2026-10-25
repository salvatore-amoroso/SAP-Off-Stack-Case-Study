import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { createRowAccumulator, fields, normalizeRow, PollError } from './poller.mjs';
import { sqlConfig } from './sql-config.mjs';
import { normalizeSqlConfig, scanSql, sqlFetchSize, sqlRow } from './sql-poller.mjs';
import { createSqlSession } from './sql-transport.mjs';

const modes = ['full', 'db-only', 'capture', 'replay', 'validation-only', 'hash-only'];
const phases = () => ({ database_ms: 0, validation_ms: 0, hashing_ms: 0, cleanup_ms: 0, residual_ms: 0, total_ms: 0 });

export function profileOptions(args) {
  const options = { mode: 'full', scans: 0, duration_seconds: 20, warmup_scans: 5, profile: true };
  const sqlArgs = [], seen = new Set();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (typeof value !== 'string' || value.startsWith('--') || seen.has(flag)) throw new Error('Invalid diagnostic arguments');
    seen.add(flag);
    if (['--transport', '--config'].includes(flag)) { sqlArgs.push(flag, value); continue; }
    const key = flag?.slice(2).replaceAll('-', '_');
    if (!['mode', 'scans', 'duration_seconds', 'warmup_scans', 'profile', 'capture_file'].includes(key)) throw new Error('Unknown diagnostic argument');
    if (['scans', 'duration_seconds', 'warmup_scans'].includes(key)) {
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 1000000) throw new Error('Invalid diagnostic count');
      options[key] = Number(value);
    } else if (key === 'profile') {
      if (!['true', 'false'].includes(value)) throw new Error('Invalid diagnostic profile switch');
      options.profile = value === 'true';
    } else options[key] = value;
  }
  if (!modes.includes(options.mode) || options.duration_seconds < 1 || options.duration_seconds > 3600 || options.warmup_scans > 1000) throw new Error('Invalid diagnostic settings');
  if (['replay', 'validation-only', 'hash-only'].includes(options.mode) && !options.capture_file) throw new Error('Captured dataset is required');
  return { options, sqlArgs };
}

export function validateCapture(capture, config) {
  if (!capture || capture.schema_version !== 1 || capture.expected_rows !== config.expected_rows || capture.expected_digest !== config.expected_digest || capture.query_sha256 !== createHash('sha256').update(config.sql).digest('hex') || !Array.isArray(capture.rows) || capture.rows.length !== config.expected_rows) throw new Error('Captured dataset does not match the fixed query and manifest');
  const accumulator = createRowAccumulator();
  for (const row of capture.rows) accumulator.add(sqlRow(row));
  accumulator.finish(config.expected_rows, config.expected_digest);
  return capture.rows;
}

export function replaySql(config, rows, options, scanIndex = 0, canonicalRows) {
  const started = performance.now(), profile = options.profile ? phases() : null;
  const result = { schema_version: 1, scan_index: scanIndex, outcome: 'error', rows: 0, pages: 0, digest: null, error: null, metrics: { elapsed_ms: 0, body_bytes: 0, missed_slots: 0 } };
  const deadline = started + config.scan_timeout_seconds * 1000;
  const checkDeadline = () => { if (performance.now() >= deadline) throw new PollError('TIMEOUT', 'Replay deadline exceeded'); };
  try {
    if (options.mode === 'hash-only') {
      const hashStarted = profile ? performance.now() : 0;
      const hash = createHash('sha256').update('sap-polling-lab\t1\n', 'utf8');
      for (const normalized of canonicalRows) hash.update(`${normalized.join('\t')}\n`, 'utf8');
      result.digest = hash.digest('hex');
      if (profile) profile.hashing_ms = performance.now() - hashStarted;
      result.rows = canonicalRows.length;
      result.pages = Math.floor(result.rows / sqlFetchSize) + 1;
      if (result.rows !== config.expected_rows) throw new PollError('COUNT', 'Replay count differs');
      if (result.digest !== config.expected_digest) throw new PollError('DIGEST', 'Replay digest differs');
      checkDeadline();
    } else {
      const accumulator = createRowAccumulator(profile, { hashing: options.mode !== 'validation-only' });
      for (let offset = 0; offset <= rows.length; offset += sqlFetchSize) {
        checkDeadline();
        result.pages++;
        for (const row of rows.slice(offset, offset + sqlFetchSize)) {
          checkDeadline();
          if (profile) accumulator.add(row, sqlRow);
          else accumulator.add(sqlRow(row));
          result.rows++;
        }
        checkDeadline();
        if (offset + sqlFetchSize > rows.length) break;
      }
      result.digest = accumulator.finish(config.expected_rows, config.expected_digest, checkDeadline);
    }
    result.outcome = 'ok';
  } catch (error) {
    result.digest = null;
    result.error = { code: error instanceof PollError ? error.code : 'SCHEMA', page_index: result.pages, http_status: null };
  }
  result.metrics.elapsed_ms = performance.now() - started;
  if (profile) {
    profile.total_ms = result.metrics.elapsed_ms;
    profile.residual_ms = profile.total_ms - profile.database_ms - profile.validation_ms - profile.hashing_ms - profile.cleanup_ms;
    result.metrics.profile = profile;
  }
  return result;
}

export async function profileSql(input, options, createAdapter, captured) {
  const config = normalizeSqlConfig(input);
  const replay = ['replay', 'validation-only', 'hash-only'].includes(options.mode);
  // Capture validation and canonical hash-only preparation happen before any scan timers.
  const rows = replay ? validateCapture(captured, config) : null;
  const canonicalRows = options.mode === 'hash-only' ? rows.map(row => normalizeRow(sqlRow(row))) : null;
  const session = !createAdapter && !replay ? createSqlSession(process.env, undefined, { statistics: options.profile }) : null;
  createAdapter ??= session?.createAdapter;
  const records = [], captureRows = [];
  let scanIndex = 0, measuredScans = 0, warmupScans = 0, failed = false, measuredWall = 0;
  async function one(phase) {
    const result = replay ? replaySql(config, rows, options, scanIndex++, canonicalRows) : await scanSql(config, createAdapter, scanIndex++, {
      profile: options.profile, drain: options.mode === 'db-only', capture: options.mode === 'capture' && phase === 'measured' ? captureRows : null,
    });
    records.push({ kind: 'scan', phase, diagnostic_mode: options.mode, profile_enabled: options.profile, ...result });
    failed ||= result.outcome !== 'ok';
  }
  try {
    for (; warmupScans < options.warmup_scans; warmupScans++) {
      await one('warmup');
      if (failed) { warmupScans++; break; }
    }
    if (!failed) {
      const started = performance.now();
      while (options.mode === 'capture' ? measuredScans === 0 : options.scans ? measuredScans < options.scans : performance.now() - started < options.duration_seconds * 1000) {
        await one('measured');
        measuredScans++;
        if (failed) break;
      }
      measuredWall = performance.now() - started;
    }
  } finally {
    if (session) await session.close().catch(() => { failed = true; });
  }
  if (options.mode === 'capture' && !failed) records.push({ kind: 'capture', schema_version: 1, rows: captureRows, expected_rows: config.expected_rows, expected_digest: config.expected_digest, query_sha256: createHash('sha256').update(config.sql).digest('hex') });
  records.push({ kind: 'summary', schema_version: 1, outcome: failed ? 'error' : 'ok', diagnostic_mode: options.mode, profile_enabled: options.profile, measured_wall_ms: measuredWall, measured_scans: measuredScans, warmup_scans: warmupScans, transport: replay ? 'captured_native_rows' : config.transport, client_policy: replay ? 'in_memory_replay' : 'persistent', fetch_size: sqlFetchSize });
  return { records, exit_code: failed ? 1 : 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { options, sqlArgs } = profileOptions(process.argv.slice(2));
    const captured = options.capture_file ? JSON.parse(await readFile(options.capture_file, 'utf8')) : null;
    const result = await profileSql(await sqlConfig(sqlArgs), options, undefined, captured);
    process.stdout.write(result.records.map(record => JSON.stringify(record)).join('\n') + '\n');
    process.exitCode = result.exit_code;
  } catch {
    process.stderr.write('Unable to configure or execute native SQL diagnostics.\n');
    process.exitCode = 2;
  }
}
