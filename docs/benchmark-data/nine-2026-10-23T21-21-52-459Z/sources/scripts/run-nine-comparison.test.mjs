import test from 'node:test';
import assert from 'node:assert/strict';
import { applications, nineSchedule, nineCommand, validateNineRecords, assertHostMemory, nineImageTag } from './run-nine-comparison.mjs';
import { benchmarkServiceRoot } from './benchmark-control.mjs';

const seed = { expected_rows: 5000, expected_digest: 'a'.repeat(64) };
const options = { durationSeconds: 1, warmupScans: 1, seed };

test('official trials reject host memory pressure rather than continue a contaminated comparison', () => {
  assert.doesNotThrow(() => assertHostMemory(2 * 1024 ** 3));
  for (const bytes of [0, 554168320, 2 * 1024 ** 3 - 1, NaN, undefined]) assert.throws(() => assertHostMemory(bytes), /HOST_MEMORY_PRESSURE/);
});

test('dedicated original and fixed images are accepted without allowing arbitrary image names', () => {
  for (const language of ['node', 'rust']) for (const kind of ['http', 'sql']) {
    assert(nineImageTag(`sap-polling-${language}:nine-${kind}`));
    assert(nineImageTag(`sap-polling-${language}:nine-fixed-${kind}`));
  }
  for (const tag of [null, 'other:latest', 'sap-polling-node:nine-sql-extra', 'sap-polling-node:nine-fixed-sql\n']) assert.equal(nineImageTag(tag), false);
});
function recordsFor(app) {
  const abap = app.language === 'abap', http = app.approach === 'http', cds = app.approach === 'cds';
  const transport = http ? (abap ? 'classic_socket' : 'socket') : cds ? (abap ? 'direct_cds' : 'odbc') : (abap ? 'native_hana_adbc' : 'hana');
  const pages = abap && cds ? 50 : 51, bytes = http ? 1074741 : 0;
  const scan = (phase, index) => ({ kind: 'scan', phase, schema_version: 1, scan_index: index, outcome: 'ok', error: null,
    rows: seed.expected_rows, pages, digest: seed.expected_digest, metrics: { elapsed_ms: 500, body_bytes: bytes, missed_slots: 0 },
    ...(abap && !http ? { transport, http_requests: 0, ...(cds ? { application_batches: 50 } : { logical_fetches: 51 }) } : {}) });
  const summary = { kind: 'summary', transport, warmup_scans: 1, measured_scans: 2, measured_wall_ms: 1001 };
  if (abap) Object.assign(summary, { duration_seconds: 1, failed_scans: 0, measured_valid_rows: 10000, measured_body_bytes: bytes * 2 },
    http ? { authentication: 'preemptive_basic', service_root: benchmarkServiceRoot }
      : { http_requests: 0, sap_client: '001', db_package_size: 100, entity: cds ? 'ZI_BL_OrderPosition' : 'ZBL_BENCH_SQL.ORDER_POSITIONS_001',
        ...(cds ? { measured_application_batches: 100 } : { measured_logical_fetches: 102 }) });
  else Object.assign(summary, { outcome: 'ok', client_policy: http ? 'fresh_per_scan' : 'persistent', ...(http ? {} : { fetch_size: 100 }) });
  return [scan('warmup', 0), scan('measured', abap ? 0 : 1), scan('measured', abap ? 1 : 2), summary];
}

test('balanced schedule visits all nine apps, thirds, trio slots and all language/approach combinations', () => {
  const schedule = nineSchedule();
  assert.equal(schedule.length, 3);
  for (const round of schedule) {
    assert.equal(new Set(round).size, 9);
    for (let third = 0; third < 3; third++) {
      const group = round.slice(third * 3, third * 3 + 3).map(id => applications.find(app => app.app_id === id));
      assert.equal(new Set(group.map(app => app.language)).size, 3);
      assert.equal(new Set(group.map(app => app.approach)).size, 3);
    }
  }
  for (const app of applications) {
    const positions = schedule.map(round => round.indexOf(app.app_id));
    assert.equal(new Set(positions.map(position => Math.floor(position / 3))).size, 3);
    assert.equal(new Set(positions.map(position => position % 3)).size, 3);
    assert.equal(positions.reduce((sum, position) => sum + position, 0), 12);
  }
  assert.equal(nineSchedule(1).flat().length, 9);
  assert.throws(() => nineSchedule(2));
});

test('all external commands are image pinned, constrained and use the original benchmark adapters', () => {
  for (const app of applications.filter(app => app.language !== 'abap')) {
    const prefix = app.approach === 'native' ? 'native-hana' : app.approach === 'cds' ? 'cds-odbc' : 'nine-http';
    const command = nineCommand(app, { name: `${prefix}-${app.language}-test`, durationSeconds: 180, warmupScans: 5, address: '172.18.0.2', image: `sha256:${'f'.repeat(64)}` });
    assert(command.args.includes('256m'));
    assert(command.args.includes('--cpus'));
    assert(command.args.includes(`sha256:${'f'.repeat(64)}`));
    assert(!command.args.some(value => value.startsWith(`sap-polling-${app.language}:`)));
    assert(command.args.includes(app.language === 'node' ? `/app/src/${app.approach === 'http' ? '' : 'sql-'}benchmark.mjs` : '--benchmark'));
    if (app.approach === 'cds') {
      assert(command.args.includes('--add-host'));
      assert(command.args.some(value => value.includes('/opt/sap/abap-odbc,readonly')));
      assert(command.args.some(value => value.includes('/run/sql/abap-cds-odbc.sql,readonly')));
    }
  }
  assert.throws(() => nineCommand(applications[0], { image: 'mutable:latest' }));
});

test('accepts all nine approach-specific valid record forms', () => {
  for (const app of applications) assert.equal(validateNineRecords(recordsFor(app), app, options).passed, true, app.app_id);
});

test('rejects changed data, ordering indexes, package counters, bytes, metadata and timing', () => {
  for (const app of applications) {
    for (const mutate of [
      records => { records[1].digest = 'b'.repeat(64); },
      records => { records[1].rows = 4999; },
      records => { records[1].pages = 1; },
      records => { records[1].metrics.body_bytes++; },
      records => { records[1].scan_index = 99; },
      records => { records[1].phase = 'warmup'; },
      records => { records.at(-1).measured_wall_ms = 999; },
      records => { records.at(-1).transport = 'wrong'; },
      records => { records.at(-1).measured_scans = 999; },
      records => { records.at(-1).outcome = 'error'; records.at(-1).failed_scans = 1; },
    ]) {
      const records = recordsFor(app); mutate(records);
      assert.equal(validateNineRecords(records, app, options).passed, false, app.app_id);
    }
  }
});

test('requires one terminal summary and no unrecognized records', () => {
  const app = applications[0], records = recordsFor(app);
  for (const bad of [records.slice(0, -1), [...records, records.at(-1)], [...records, { kind: 'debug' }], [records.at(-1), ...records.slice(0, -1)]]) {
    assert.throws(() => validateNineRecords(bad, app, options));
  }
});
