import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { profileOptions, profileSql, validateCapture } from '../src/sql-profile.mjs';
import { scanSql } from '../src/sql-poller.mjs';
import { createSqlSession } from '../src/sql-transport.mjs';

const { cases } = JSON.parse(await readFile(new URL('../../../contracts/fixtures.json', import.meta.url), 'utf8'));
const fixture = cases.find(item => item.id === 'two_rows');
const rows = JSON.parse(fixture.pages[0].body_json).value.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key.toUpperCase(), value])));
const config = { ...fixture.config, transport: 'hana', sql: 'SELECT frozen_fixture' };
const capture = { schema_version: 1, rows, expected_rows: config.expected_rows, expected_digest: config.expected_digest, query_sha256: createHash('sha256').update(config.sql).digest('hex') };
const options = { mode: 'full', scans: 2, duration_seconds: 20, warmup_scans: 1, profile: true };
const adapter = async () => ({ async open() {}, async fetch() { return { rows, done: true }; }, async close() {} });

function assertProfile(result) {
  const profile = result.metrics.profile;
  for (const name of ['database_ms', 'validation_ms', 'hashing_ms', 'cleanup_ms', 'residual_ms', 'total_ms']) assert.ok(Number.isFinite(profile[name]) && profile[name] >= 0, name);
  assert.equal(profile.total_ms, result.metrics.elapsed_ms);
  assert.ok(Math.abs(profile.database_ms + profile.validation_ms + profile.hashing_ms + profile.cleanup_ms + profile.residual_ms - profile.total_ms) < 1e-9);
}

test('opt-in phase timings preserve SQL result and absent diagnostics preserve output schema', async () => {
  const control = await scanSql(config, adapter);
  const measured = await scanSql(config, adapter, 0, { profile: true });
  assert.equal(Object.hasOwn(control.metrics, 'profile'), false);
  assert.deepEqual({ ...measured, metrics: null }, { ...control, metrics: null });
  assertProfile(measured);
  assert.ok(measured.metrics.profile.database_ms >= measured.metrics.profile.db_open_ms);
});

test('profile capture/replay validates shared rows and isolates validation/hash controls', async () => {
  assert.equal(validateCapture(capture, config), rows);
  assert.throws(() => validateCapture({ ...capture, query_sha256: '0'.repeat(64) }, config));
  assert.throws(() => validateCapture({ ...capture, rows: [...rows].reverse() }, config));
  const captured = await profileSql(config, { ...options, mode: 'capture' }, adapter);
  assert.equal(captured.exit_code, 0);
  assert.deepEqual(captured.records.find(record => record.kind === 'capture').rows, rows);
  for (const mode of ['replay', 'validation-only', 'hash-only']) {
    const result = await profileSql(config, { ...options, mode }, undefined, capture);
    assert.equal(result.exit_code, 0);
    const scans = result.records.filter(record => record.kind === 'scan');
    assert.equal(scans.length, 3);
    assert.ok(scans.every(scan => scan.rows === 2 && scan.outcome === 'ok'));
    for (const scan of scans) {
      assertProfile(scan);
      assert.equal(scan.digest, mode === 'validation-only' ? null : config.expected_digest);
      assert.equal(scan.metrics.profile.database_ms, 0);
      if (mode === 'hash-only') assert.equal(scan.metrics.profile.validation_ms, 0);
      if (mode === 'validation-only') assert.equal(scan.metrics.profile.hashing_ms, 0);
    }
    const disabled = await profileSql(config, { ...options, mode, profile: false }, undefined, capture);
    assert.equal(disabled.exit_code, 0);
    assert.equal(Object.hasOwn(disabled.records[0].metrics, 'profile'), false);
  }
});

test('DB-only drain explicitly omits row validation and digest while counting all driver rows', async () => {
  const result = await profileSql(config, { ...options, mode: 'db-only' }, adapter);
  const scan = result.records.find(record => record.kind === 'scan');
  assert.equal(scan.outcome, 'ok');
  assert.equal(scan.rows, 2);
  assert.equal(scan.digest, null);
  assert.equal(scan.metrics.profile.validation_ms, 0);
  assert.equal(scan.metrics.profile.hashing_ms, 0);
  assertProfile(scan);
});

test('diagnostic arguments reject bad modes, repeated switches and unbound replay', () => {
  assert.equal(profileOptions(['--mode', 'full', '--profile', 'false', '--duration-seconds', '20']).options.profile, false);
  assert.equal(profileOptions(['--mode', 'replay', '--capture-file', '/capture.json']).options.capture_file, '/capture.json');
  for (const args of [['--mode', 'bad'], ['--mode', 'replay'], ['--scans', '-1'], ['--profile', 'yes'], ['--scans', '1', '--scans', '2'], ['--unknown', '1']]) assert.throws(() => profileOptions(args));
});

test('optional HANA diagnostics count API crossings and separate statement/fetch server reports', async () => {
  let index = -1, executed = false;
  const cursor = {
    setAsArrayDefault() {}, nextCanBlock: () => index === 1,
    next(callback) { const value = ++index < rows.length; if (callback) callback(null, value); else return value; },
    getValuesCanBlock: () => index === 1,
    getValues(callback) { if (callback) callback(null, rows[index]); else return rows[index]; },
    getServerCPUTime: () => 7, getServerProcessingTime: () => 8,
    close: callback => callback(null),
  };
  const statement = {
    setTimeout() {}, executeQuery(callback) { executed = true; callback(null, cursor); },
    getServerCPUTime: () => executed ? 5 : 3, getServerProcessingTime: () => executed ? 6 : 4,
    drop: callback => callback(null),
  };
  const driver = { createConnection: () => ({
    connect: (settings, callback) => callback(null), setAutoCommit() {}, setRowSetSize() {},
    prepare: (sql, callback) => callback(null, statement), disconnect: callback => callback(null),
  }) };
  const session = createSqlSession({ HANA_SERVER: 'fixture', HANA_DATABASE: 'fixture', HANA_USER: 'fixture', HANA_PASSWORD: 'fixture' }, async () => driver, { statistics: true });
  const result = await scanSql(config, session.createAdapter, 0, { profile: true });
  await session.close();
  assert.equal(result.outcome, 'ok');
  const { driver_calls: calls, server } = result.metrics.driver_statistics;
  assert.deepEqual(calls, { prepare: 1, execute_query: 1, logical_fetch: 1, next_can_block: 3, next_sync: 2, next_async: 1, get_values_can_block: 2, get_values_sync: 1, get_values_async: 1 });
  assert.deepEqual(server.prepare, { cpu_us: 3, processing_us: 4 });
  assert.deepEqual(server.execute, { cpu_us: 5, processing_us: 6 });
  assert.deepEqual(server.fetch, { cpu_us: 7, processing_us: 8 });
  assert.equal(server.units, 'microseconds');
});
