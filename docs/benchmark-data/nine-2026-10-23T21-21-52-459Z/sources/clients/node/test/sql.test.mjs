import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fields } from '../src/poller.mjs';
import { normalizeSqlConfig, runSql, scanSql } from '../src/sql-poller.mjs';
import { createSqlAdapter, createSqlSession } from '../src/sql-transport.mjs';
import { benchmarkSql } from '../src/sql-benchmark.mjs';

const { cases } = JSON.parse(await readFile(new URL('../../../contracts/fixtures.json', import.meta.url), 'utf8'));
const manifest = JSON.parse(await readFile(new URL('../../../contracts/seed-manifest.json', import.meta.url), 'utf8'));
const config = { ...cases[0].config, transport: 'hana', sql: 'SELECT frozen_fixture' };
const sqlRow = row => row && typeof row === 'object' && !Array.isArray(row) ? Object.fromEntries(Object.entries(row).map(([name, value]) => [name.toUpperCase(), value])) : row;
const rowCases = cases.filter(fixture => ['two_rows', 'empty', 'decimal_normalization', 'leap_day', 'order_duplicate', 'order_descending', 'order_across_pages', 'count_mismatch', 'digest_mismatch'].includes(fixture.id) || (fixture.id.startsWith('schema_') && !['schema_envelope', 'schema_json'].includes(fixture.id)));

for (const fixture of rowCases) {
  test(`SQL uses shared row/hash fixture: ${fixture.id}`, async () => {
    let index = 0, closed = 0;
    const actual = await scanSql({ ...fixture.config, transport: 'hana', sql: config.sql }, async () => ({
      async open() {},
      async fetch() {
        const rows = JSON.parse(fixture.pages[index++].body_json).value.map(sqlRow);
        return { rows, done: index === fixture.pages.length };
      },
      async close() { closed++; },
    }));
    const { schema_version, scan_index, metrics, ...functional } = actual;
    const expected = { ...fixture.expected, error: fixture.expected.error ? { ...fixture.expected.error, http_status: null } : null };
    assert.deepEqual(functional, expected);
    assert.equal(metrics.body_bytes, 0);
    assert.equal(closed, 1);
  });
}

function seedRow(index) {
  const order = Math.floor(index / 5) + 1, position = index % 5 + 1;
  return sqlRow({ OrderId: String(order).padStart(20, '0'), PositionNumber: String(position * 10).padStart(6, '0'), CustomerId: `C${String(order).padStart(9, '0')}`, OrderDate: '2026-01-01', MaterialId: `M${String(position).padStart(17, '0')}`, Quantity: `${position}.000`, Unit: 'EA', NetAmount: `${order + position}.00`, Currency: 'CHF' });
}

const runtime = { HANA_SERVER: 'fixture:30015', HANA_DATABASE: 'FIXTURE', HANA_USER: 'fixture', HANA_PASSWORD: 'private-password', ABAP_ODBC_CONNECTION_STRING: 'private-connection-string' };

function fakeDriver(transport, observed) {
  let index = -1;
  if (transport === 'hana') {
    const cursor = {
      nextCanBlock: () => false, next: () => ++index < manifest.expected_rows,
      getValuesCanBlock: () => false, getValues: () => seedRow(index),
      setAsArrayDefault: value => { observed.asArray = value; },
      close: cb => { observed.closed.push('cursor'); cb(null); },
    };
    const statement = {
      setTimeout: seconds => { observed.statementTimeout = seconds; },
      executeQuery: cb => { observed.queries++; cb(null, cursor); },
      drop: cb => { observed.closed.push('statement'); cb(null); },
    };
    return { createConnection: () => ({
      connect: (settings, cb) => { observed.connection = settings; observed.connections = (observed.connections ?? 0) + 1; cb(null); },
      setRowSetSize: size => { observed.fetchSize = size; },
      setAutoCommit: value => { observed.autoCommit = value; },
      prepare: (sql, cb) => { index = -1; observed.sql = sql; cb(null, statement); },
      disconnect: cb => { observed.closed.push('connection'); cb(null); },
    }) };
  }
  const cursor = {
    noData: false,
    async fetch() {
      const rows = [];
      while (rows.length < observed.fetchSize && index + 1 < manifest.expected_rows) rows.push(seedRow(++index));
      this.noData = rows.length < observed.fetchSize;
      return rows;
    },
    async close() { observed.closed.push('cursor'); },
  };
  return { async connect(settings) {
    observed.connection = settings;
    observed.connections = (observed.connections ?? 0) + 1;
    return {
      async query(sql, options) { index = -1; cursor.noData = false; observed.sql = sql; observed.fetchSize = options.fetchSize; observed.queries++; assert.equal(options.cursor, true); return cursor; },
      async close() { observed.closed.push('connection'); },
    };
  } };
}

for (const transport of ['hana', 'odbc']) {
  test(`${transport} cursor processes frozen seed with one query and bounded 100-row batches`, async () => {
    const observed = { queries: 0, closed: [], sizes: [] };
    const input = { ...config, ...manifest, transport };
    const result = await scanSql(input, async settings => {
      const adapter = await createSqlAdapter(settings, runtime, async name => {
        assert.equal(name, transport === 'hana' ? '@sap/hana-client' : 'odbc');
        return fakeDriver(transport, observed);
      });
      const fetch = adapter.fetch;
      adapter.fetch = async () => { const batch = await fetch(); observed.sizes.push(batch.rows.length); return batch; };
      return adapter;
    });
    assert.equal(result.outcome, 'ok');
    assert.equal(result.rows, manifest.expected_rows);
    assert.equal(result.digest, manifest.expected_digest);
    assert.equal(result.pages, 51);
    assert.deepEqual(observed.sizes, [...Array(50).fill(100), 0]);
    assert.equal(observed.queries, 1);
    assert.equal(observed.sql, config.sql);
    assert.equal(observed.fetchSize, 100);
    assert.deepEqual(observed.closed, transport === 'hana' ? ['cursor', 'statement', 'connection'] : ['cursor', 'connection']);
    if (transport === 'hana') {
      assert.equal(observed.connection.prefetch, false);
      assert.equal(observed.connection.resultSetRowSetLimitKB, 128);
      assert.equal(observed.connection.reconnect, false);
      assert.equal(observed.connection.allowReconnectOnSelect, false);
      assert.equal(observed.connection.pooling, false);
      assert.equal(observed.autoCommit, true);
      assert.equal(observed.asArray, false);
    }
    assert.equal(JSON.stringify(result).includes('private-'), false);
  });
  test(`${transport} persistent session reuses its connection and closes scan cursors`, async () => {
    const observed = { queries: 0, closed: [] };
    let loads = 0;
    const session = createSqlSession(runtime, async () => { loads++; return fakeDriver(transport, observed); });
    for (let index = 0; index < 2; index++) {
      const result = await scanSql({ ...config, ...manifest, transport }, session.createAdapter, index);
      assert.equal(result.outcome, 'ok');
    }
    assert.equal(loads, 1);
    assert.equal(observed.connections, 1);
    assert.equal(observed.queries, 2);
    assert.equal(observed.closed.filter(name => name === 'cursor').length, 2);
    assert.equal(observed.closed.includes('connection'), false);
    await session.close();
    await session.close();
    assert.equal(observed.closed.filter(name => name === 'connection').length, 1);
  });
}

test('SQL rejects incompatible fetch sizes, native values, oversized batches and unavailable drivers', async () => {
  assert.throws(() => normalizeSqlConfig({ ...config, page_size: 500 }), error => error.code === 'CONFIG');
  assert.throws(() => normalizeSqlConfig({ ...config, transport: 'invalid' }), error => error.code === 'CONFIG');
  for (const sql of ['DELETE FROM V', 'SELECT A FROM V; DROP TABLE V', 'SELECT A INTO V FROM X', 'SELECTOR', 'SELECT A FROM V;;', `SELECT ${'A'.repeat(65537)}`]) assert.throws(() => normalizeSqlConfig({ ...config, sql }), error => error.code === 'CONFIG');
  assert.doesNotThrow(() => normalizeSqlConfig({ ...config, sql: 'SELECT A FROM V ORDER BY A;\n' }));
  for (const override of [{ QUANTITY: 1 }, { ORDERDATE: new Date('2026-01-01') }, { POSITIONNUMBER: 10 }, { EXTRA: 'value' }]) {
    const result = await scanSql({ ...config, expected_rows: 1 }, async () => ({
      async open() {}, async fetch() { return { rows: [{ ...seedRow(0), ...override }], done: true }; }, async close() {},
    }));
    assert.equal(result.error.code, 'SCHEMA');
    assert.equal(result.rows, 0);
  }
  const oversized = await scanSql(config, async () => ({ async open() {}, async fetch() { return { rows: Array(101).fill(seedRow(0)), done: true }; }, async close() {} }));
  assert.equal(oversized.error.code, 'SCHEMA');
  await assert.rejects(createSqlAdapter(config, {}, async () => { throw new Error('must not load'); }), error => error.code === 'CONFIG');
  await assert.rejects(createSqlAdapter(config, runtime, async () => { throw new Error('private-password'); }), error => error.code === 'CONFIG' && !error.message.includes('private-'));
  assert.equal(fields.length, 9);
});

test('SQL bounds fetch attempts and sanitizes driver failures while closing resources', async () => {
  let closed = 0;
  const adapter = { async open() {}, async fetch() { return { rows: [], done: false }; }, async close() { closed++; } };
  const limited = await scanSql({ ...config, max_pages: 1 }, async () => adapter);
  assert.deepEqual(limited.error, { code: 'LIMIT', page_index: 2, http_status: null });
  assert.equal(limited.pages, 1);
  assert.equal(closed, 1);
  const failed = await scanSql(config, async () => ({ ...adapter, async open() { throw new Error(runtime.ABAP_ODBC_CONNECTION_STRING); } }));
  assert.deepEqual(failed.error, { code: 'TRANSPORT', page_index: 0, http_status: null });
  assert.equal(JSON.stringify(failed).includes('private-'), false);
  assert.equal(closed, 2);
  for (const error of [{ code: 613 }, { sqlState: 'HYT00' }, { odbcErrors: [{ state: 'HYT01' }] }]) {
    const timedOut = await scanSql(config, async () => ({ ...adapter, async open() { throw error; } }));
    assert.deepEqual(timedOut.error, { code: 'TIMEOUT', page_index: 0, http_status: null });
  }
  const truncated = await scanSql(config, async () => ({ ...adapter, async open() { throw { odbcErrors: [{ state: '01004' }] }; } }));
  assert.deepEqual(truncated.error, { code: 'SCHEMA', page_index: 0, http_status: null });
});

test('SQL deadline requests cancellation and awaits resource cleanup', async () => {
  let cancelled = 0, closed = 0, rejectFetch;
  const result = await scanSql({ ...config, request_timeout_seconds: 1 }, async () => ({
    async open() {}, fetch: () => new Promise((_, reject) => { rejectFetch = reject; }),
    async cancel() { cancelled++; rejectFetch(new Error('private-password')); },
    async close() { closed++; },
  }));
  assert.deepEqual(result.error, { code: 'TIMEOUT', page_index: 1, http_status: null });
  assert.equal(cancelled, 1);
  assert.equal(closed, 1);
});

test('SQL finite and continuous runners invalidate failed scans', async () => {
  const source = JSON.parse(cases[0].pages[0].body_json).value.map(sqlRow);
  let scans = 0;
  const createAdapter = async () => { scans++; return { async open() {}, async fetch() { return { rows: source, done: true }; }, async close() {} }; };
  const records = [];
  assert.equal(await runSql({ ...config, scans: 2, interval_ms: 1 }, createAdapter, record => records.push(record)), 0);
  assert.equal(scans, 2);
  assert.deepEqual(records.map(record => record.scan_index), [0, 1]);
  const failed = await benchmarkSql({ ...config, expected_rows: 3 }, { warmup_scans: 5, duration_seconds: 180 }, createAdapter);
  assert.equal(failed.exit_code, 1);
  assert.equal(failed.records.length, 2);
  assert.equal(failed.records[0].error.code, 'COUNT');
  assert.equal(failed.records[1].measured_scans, 0);
  assert.equal(failed.records[1].client_policy, 'persistent');
});
