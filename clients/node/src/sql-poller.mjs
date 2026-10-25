import { performance } from 'node:perf_hooks';
import { createRowAccumulator, fields, normalizeConfig, PollError, terminal } from './poller.mjs';

export const sqlFetchSize = 100;

export function sqlRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).length !== fields.length || fields.some(field => !Object.hasOwn(row, field.toUpperCase()))) throw new PollError('SCHEMA', 'Invalid SQL row');
  // SQL projects text explicitly; converting native Number/Date values would lose contract information.
  return Object.fromEntries(fields.map(field => [field, row[field.toUpperCase()]]));
}

export function normalizeSqlConfig(input) {
  if (!['hana', 'odbc'].includes(input.transport)) throw new PollError('CONFIG', 'Unknown SQL transport');
  if (typeof input.sql !== 'string' || !input.sql.trim() || input.sql.includes('\0')) throw new PollError('CONFIG', 'SQL query is required');
  const query = input.sql.trim().replace(/;$/, '').trimEnd();
  if (Buffer.byteLength(query, 'utf8') > 65536 || !/^SELECT[\t\n\v\f\r ]/i.test(query) || query.includes(';') || query.split(/[^A-Za-z0-9_]+/).some(word => ['INTO', 'INSERT', 'UPDATE', 'DELETE', 'UPSERT', 'CREATE', 'DROP', 'ALTER', 'CALL', 'MERGE'].includes(word.toUpperCase()))) throw new PollError('CONFIG', 'SQL must be one read-only SELECT');
  if (input.page_size !== undefined && input.page_size !== sqlFetchSize) throw new PollError('CONFIG', 'SQL fetch size is fixed at 100');
  return normalizeConfig({ ...input, service_root: 'http://sql.invalid/', page_size: sqlFetchSize });
}

export async function scanSql(input, createAdapter, scanIndex = 0, diagnostics = {}) {
  const started = performance.now();
  const profile = diagnostics.profile ? { database_ms: 0, db_open_ms: 0, db_fetch_ms: 0, validation_ms: 0, hashing_ms: 0, cleanup_ms: 0, residual_ms: 0, total_ms: 0 } : null;
  const result = { schema_version: 1, scan_index: scanIndex, outcome: 'error', rows: 0, pages: 0, digest: null, error: null, metrics: { elapsed_ms: 0, body_bytes: 0, missed_slots: 0 } };
  let adapter, pageIndex = 0, closed = false;
  try {
    const config = normalizeSqlConfig(input);
    const deadline = started + config.scan_timeout_seconds * 1000;
    const checkDeadline = () => { if (performance.now() >= deadline) throw new PollError('TIMEOUT', 'SQL scan deadline exceeded'); };
    const accumulator = diagnostics.drain ? null : createRowAccumulator(profile);
    const adapterStarted = profile ? performance.now() : 0;
    adapter = await createAdapter(config);
    if (profile) profile.db_open_ms += performance.now() - adapterStarted;
    async function operation(action) {
      checkDeadline();
      const operationDeadline = Math.min(deadline, performance.now() + config.request_timeout_seconds * 1000);
      let expired = false, cancellation;
      const timer = setTimeout(() => {
        expired = true;
        cancellation = Promise.resolve().then(() => adapter.cancel()).catch(() => {});
      }, Math.max(1, operationDeadline - performance.now()));
      try {
        const value = await action();
        if (expired || performance.now() >= operationDeadline) throw new PollError('TIMEOUT', 'SQL operation deadline exceeded');
        return value;
      } catch (error) {
        if (expired || performance.now() >= operationDeadline) throw new PollError('TIMEOUT', 'SQL operation deadline exceeded');
        throw error;
      } finally {
        clearTimeout(timer);
        if (cancellation) await cancellation;
      }
    }
    async function stage(name, action) {
      const stageStarted = profile ? performance.now() : 0;
      try { return await action(); }
      finally { if (profile) profile[name] += performance.now() - stageStarted; }
    }
    await stage('db_open_ms', () => operation(() => adapter.open()));
    while (true) {
      pageIndex = result.pages + 1;
      checkDeadline();
      if (result.pages >= config.max_pages) throw new PollError('LIMIT', 'SQL fetch limit exceeded');
      result.pages++;
      const batch = await stage('db_fetch_ms', () => operation(() => adapter.fetch()));
      if (!batch || !Array.isArray(batch.rows) || batch.rows.length > sqlFetchSize || typeof batch.done !== 'boolean') throw new PollError('SCHEMA', 'Invalid SQL cursor batch');
      for (const row of batch.rows) {
        checkDeadline();
        if (!diagnostics.drain) {
          if (profile) accumulator.add(row, sqlRow);
          else accumulator.add(sqlRow(row));
        }
        if (diagnostics.capture) diagnostics.capture.push(row);
        result.rows++;
      }
      checkDeadline();
      if (batch.done) break;
    }
    if (profile && adapter.statistics) result.metrics.driver_statistics = adapter.statistics();
    await stage('cleanup_ms', () => operation(() => adapter.close()));
    closed = true;
    checkDeadline();
    if (diagnostics.drain && result.rows !== config.expected_rows) throw new PollError('COUNT', 'Final row count differs from manifest');
    const digest = diagnostics.drain ? null : accumulator.finish(config.expected_rows, config.expected_digest, checkDeadline);
    result.outcome = 'ok';
    result.digest = digest;
  } catch (error) {
    const timeoutStates = new Set(['HYT00', 'HYT01']);
    const driverTimeout = error?.code === 613 || error?.code === '613' || timeoutStates.has(error?.sqlState) || (Array.isArray(error?.odbcErrors) && error.odbcErrors.some(detail => timeoutStates.has(detail?.state)));
    const truncated = error?.sqlState === '01004' || (Array.isArray(error?.odbcErrors) && error.odbcErrors.some(detail => detail?.state === '01004'));
    const code = error instanceof PollError ? error.code : driverTimeout ? 'TIMEOUT' : truncated ? 'SCHEMA' : 'TRANSPORT';
    if (['TIMEOUT', 'TRANSPORT'].includes(code) && adapter?.invalidate) { adapter.invalidate(); closed = false; }
    result.error = { code, page_index: pageIndex, http_status: null };
  } finally {
    if (adapter && !closed) {
      const cleanupStarted = profile ? performance.now() : 0;
      await adapter.close().catch(() => {});
      if (profile) profile.cleanup_ms += performance.now() - cleanupStarted;
    }
  }
  result.metrics.elapsed_ms = performance.now() - started;
  if (profile) {
    profile.database_ms = profile.db_open_ms + profile.db_fetch_ms;
    profile.total_ms = result.metrics.elapsed_ms;
    profile.residual_ms = profile.total_ms - profile.database_ms - profile.validation_ms - profile.hashing_ms - profile.cleanup_ms;
    result.metrics.profile = profile;
  }
  return result;
}

export async function runSql(input, createAdapter, emit = result => process.stdout.write(`${JSON.stringify(result)}\n`)) {
  let config;
  try { config = normalizeSqlConfig(input); } catch {
    emit(await scanSql(input, createAdapter));
    return 2;
  }
  const origin = performance.now();
  let slot = 0, exitCode = 0;
  for (let index = 0; index < config.scans; index++) {
    const result = await scanSql(config, createAdapter, index);
    const nextSlot = Math.max(slot + 1, Math.floor((performance.now() - origin) / config.interval_ms) + 1);
    result.metrics.missed_slots = nextSlot - slot - 1;
    emit(result);
    if (result.outcome !== 'ok') exitCode = result.error.code === 'CONFIG' ? 2 : 1;
    if (terminal(result) || index + 1 === config.scans) break;
    slot = nextSlot;
    const delay = origin + slot * config.interval_ms - performance.now();
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
  }
  return exitCode;
}
