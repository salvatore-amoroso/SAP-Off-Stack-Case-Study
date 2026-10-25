import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PollError } from '../src/poller.mjs';
import { runSql, scanSql } from '../src/sql-poller.mjs';
import { createSqlSession } from '../src/sql-transport.mjs';

const { cases } = JSON.parse(await readFile(new URL('../../../contracts/fixtures.json', import.meta.url), 'utf8'));
const fixture = cases.find(item => item.id === 'two_rows');
const rows = JSON.parse(fixture.pages[0].body_json).value.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key.toUpperCase(), value])));
const config = { ...fixture.config, transport: 'odbc', sql: 'SELECT frozen_fixture' };
const runtime = { ABAP_ODBC_CONNECTION_STRING: 'private-fixture-connection' };

function recoveringDriver(failure) {
  let connections = 0, rejectFetch;
  const events = [];
  const driver = {
    async connect() {
      const index = ++connections;
      events.push(`connect:${index}`);
      if (failure === 'open' && index === 1) throw new Error('private-open-error');
      return {
        async query() {
          events.push(`query:${index}`);
          if (failure === 'query' && index === 1) throw new Error('private-query-error');
          return {
            get noData() {
              if (failure === 'no-data' && index === 1) throw new Error('private-cursor-error');
              return true;
            },
            async fetch() {
              events.push(`fetch:${index}`);
              if (['fetch', 'connection-close'].includes(failure) && index === 1) throw new Error('private-fetch-error');
              if (['cancel', 'cancel-failure'].includes(failure) && index === 1) return new Promise((_, reject) => { rejectFetch = reject; });
              if (failure === 'validation-timeout' && index === 1) {
                const row = { ...rows[0] };
                Object.defineProperty(row, 'ORDERID', { enumerable: true, get() { throw new PollError('TIMEOUT', 'Fixture scan deadline'); } });
                return [row];
              }
              return rows;
            },
            async close() {
              events.push(`cursor-close:${index}`);
              if (failure === 'cursor-close' && index === 1) throw new Error('private-cursor-close-error');
            },
          };
        },
        async cancel() {
          events.push(`cancel:${index}`);
          rejectFetch(new Error('private-cancelled-operation'));
          if (failure === 'cancel-failure') throw new Error('private-cancel-error');
        },
        async close() {
          events.push(`connection-close:${index}`);
          if (failure === 'connection-close' && index === 1) throw new Error('private-connection-close-error');
        },
      };
    },
  };
  return { driver, events };
}

for (const failure of ['open', 'query', 'fetch', 'no-data', 'cursor-close', 'connection-close', 'validation-timeout', 'cancel', 'cancel-failure']) {
  test(`ODBC retires failed ${failure} connection before a subsequent successful scan`, async () => {
    const { driver, events } = recoveringDriver(failure);
    const session = createSqlSession(runtime, async () => driver);
    const input = { ...config, request_timeout_seconds: 1 };
    const failed = await scanSql(input, session.createAdapter);
    assert.equal(failed.outcome, 'error');
    assert.equal(failed.error.code, ['validation-timeout', 'cancel', 'cancel-failure'].includes(failure) ? 'TIMEOUT' : 'TRANSPORT');
    assert.equal(failed.digest, null);
    assert.equal(JSON.stringify(failed).includes('private-'), false);
    const recovered = await scanSql(input, session.createAdapter, 1);
    assert.equal(recovered.outcome, 'ok');
    assert.equal(recovered.digest, config.expected_digest);
    assert.equal(events.filter(event => event.startsWith('connect:')).length, 2);
    if (failure !== 'open') {
      assert.equal(events.filter(event => event === 'connection-close:1').length, 1);
      assert.ok(events.indexOf('connection-close:1') < events.indexOf('connect:2'));
    }
    assert.equal(events.includes('connection-close:2'), false);
    await session.close();
    assert.equal(events.filter(event => event === 'connection-close:2').length, 1);
  });
}

test('ODBC can retire a connection after its healthy cursor was already closed', async () => {
  const { driver, events } = recoveringDriver('none');
  const session = createSqlSession(runtime, async () => driver);
  const adapter = await session.createAdapter(config);
  await adapter.open();
  await adapter.fetch();
  await adapter.close();
  assert.equal(events.includes('connection-close:1'), false);
  adapter.invalidate();
  await adapter.close();
  await adapter.close();
  assert.equal(events.filter(event => event === 'cursor-close:1').length, 1);
  assert.equal(events.filter(event => event === 'connection-close:1').length, 1);
  const recovered = await scanSql(config, session.createAdapter, 1);
  assert.equal(recovered.outcome, 'ok');
  assert.ok(events.indexOf('connection-close:1') < events.indexOf('connect:2'));
  await session.close();
});

test('ODBC scheduled run reconnects after transport failure and retains the failed run status', async () => {
  const { driver, events } = recoveringDriver('fetch');
  const session = createSqlSession(runtime, async () => driver);
  const records = [];
  const exit = await runSql({ ...config, scans: 2, interval_ms: 1 }, session.createAdapter, record => records.push(record));
  assert.equal(exit, 1);
  assert.deepEqual(records.map(record => record.outcome), ['error', 'ok']);
  assert.deepEqual(records.map(record => record.scan_index), [0, 1]);
  assert.equal(records[1].digest, config.expected_digest);
  assert.ok(events.indexOf('connection-close:1') < events.indexOf('connect:2'));
  await session.close();
});
