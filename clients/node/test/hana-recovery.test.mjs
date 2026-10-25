import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PollError } from '../src/poller.mjs';
import { runSql, scanSql } from '../src/sql-poller.mjs';
import { createSqlSession } from '../src/sql-transport.mjs';

const { cases } = JSON.parse(await readFile(new URL('../../../contracts/fixtures.json', import.meta.url), 'utf8'));
const fixture = cases.find(item => item.id === 'two_rows');
const rows = JSON.parse(fixture.pages[0].body_json).value.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key.toUpperCase(), value])));
const config = { ...fixture.config, transport: 'hana', sql: 'SELECT frozen_fixture' };
const runtime = { HANA_SERVER: 'fixture:30015', HANA_DATABASE: 'FIXTURE', HANA_USER: 'fixture', HANA_PASSWORD: 'private-password' };

function recoveringDriver(failure) {
  let connections = 0, pendingFetch;
  const events = [];
  const driver = {
    createConnection() {
      const index = ++connections;
      let rowIndex = -1;
      events.push(`create:${index}`);
      const failed = stage => index === 1 && failure === stage;
      const cursor = {
        setAsArrayDefault() {},
        nextCanBlock: () => true,
        next(cb) {
          events.push(`fetch:${index}`);
          if (index === 1 && ['fetch', 'disconnect'].includes(failure)) return cb(new Error('private-fetch-error'));
          if (index === 1 && ['cancel', 'cancel-failure'].includes(failure)) { pendingFetch = cb; return; }
          cb(null, ++rowIndex < rows.length);
        },
        getValuesCanBlock: () => true,
        getValues(cb) {
          if (failed('values')) return cb(new Error('private-values-error'));
          if (failed('validation-timeout')) {
            const row = { ...rows[rowIndex] };
            Object.defineProperty(row, 'ORDERID', { enumerable: true, get() { throw new PollError('TIMEOUT', 'Fixture scan deadline'); } });
            return cb(null, row);
          }
          cb(null, rows[rowIndex]);
        },
        close(cb) { events.push(`cursor-close:${index}`); cb(failed('cursor-close') ? new Error('private-close-error') : null); },
      };
      const statement = {
        setTimeout() {},
        executeQuery(cb) { cb(failed('execute') ? new Error('private-execute-error') : null, cursor); },
        drop(cb) { events.push(`statement-drop:${index}`); cb(failed('statement-drop') ? new Error('private-drop-error') : null); },
      };
      return {
        connect(settings, cb) { events.push(`connect:${index}`); cb(failed('connect') ? new Error('private-connect-error') : null); },
        setAutoCommit() {}, setRowSetSize() {},
        prepare(sql, cb) {
          events.push(`prepare:${index}`);
          rowIndex = -1;
          cb(failed('prepare') ? new Error('private-prepare-error') : null, statement);
        },
        abort(cb) {
          events.push(`abort:${index}`);
          pendingFetch(new Error('private-cancelled-operation'));
          cb(failed('cancel-failure') ? new Error('private-abort-error') : null);
        },
        disconnect(cb) { events.push(`disconnect:${index}`); cb(failed('disconnect') ? new Error('private-disconnect-error') : null); },
      };
    },
  };
  return { driver, events };
}

for (const failure of ['connect', 'prepare', 'execute', 'fetch', 'values', 'cursor-close', 'statement-drop', 'disconnect', 'validation-timeout', 'cancel', 'cancel-failure']) {
  test(`HANA retires failed ${failure} connection before a subsequent successful scan`, async () => {
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
    assert.equal(events.filter(event => event.startsWith('create:')).length, 2);
    assert.equal(events.filter(event => event === 'disconnect:1').length, 1);
    assert.ok(events.indexOf('disconnect:1') < events.indexOf('create:2'));
    assert.equal(events.includes('disconnect:2'), false);
    await session.close();
    assert.equal(events.filter(event => event === 'disconnect:2').length, 1);
  });
}

test('HANA can retire a shared connection after its healthy cursor was already closed', async () => {
  const { driver, events } = recoveringDriver('none');
  const session = createSqlSession(runtime, async () => driver);
  const adapter = await session.createAdapter(config);
  await adapter.open();
  await adapter.fetch();
  await adapter.close();
  assert.equal(events.includes('disconnect:1'), false);
  adapter.invalidate();
  await adapter.close();
  await adapter.close();
  assert.equal(events.filter(event => event === 'cursor-close:1').length, 1);
  assert.equal(events.filter(event => event === 'statement-drop:1').length, 1);
  assert.equal(events.filter(event => event === 'disconnect:1').length, 1);
  assert.equal((await scanSql(config, session.createAdapter, 1)).outcome, 'ok');
  await session.close();
});

test('HANA scheduled run reconnects after transport failure and retains the failed run status', async () => {
  const { driver, events } = recoveringDriver('fetch');
  const session = createSqlSession(runtime, async () => driver);
  const records = [];
  const exit = await runSql({ ...config, scans: 2, interval_ms: 1 }, session.createAdapter, record => records.push(record));
  assert.equal(exit, 1);
  assert.deepEqual(records.map(record => record.outcome), ['error', 'ok']);
  assert.deepEqual(records.map(record => record.scan_index), [0, 1]);
  assert.equal(records[1].digest, config.expected_digest);
  assert.ok(events.indexOf('disconnect:1') < events.indexOf('connect:2'));
  await session.close();
});
