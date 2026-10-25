import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadOdbcRuntime, odbcDockerCommand, odbcEnvironment, invoke, projectRoot } from '../../deploy/sql/odbc-runtime.mjs';
const runtime = await loadOdbcRuntime(), here = resolve(projectRoot, 'work/node-cds-fix'), tests = [];
for (const image of ['sap-polling-node:nine-sql', 'sap-polling-node:nine-fixed-sql']) {
  const command = odbcDockerCommand('node', runtime.address);
  const index = command.args.indexOf('sap-polling-node:sql-odbc');
  command.args.splice(index, command.args.length - index, '--mount', `type=bind,source=${here},target=/proof,readonly`,
    '--env', 'LD_PRELOAD=/proof/cancel-shim.so', '--env', 'ODBC_FAULT_FETCH=71', image, '--v8-pool-size=1', '/proof/probe-poller-timeout.mjs');
  const result = await invoke(command.program, command.args, { env: { ...process.env, ...odbcEnvironment(runtime.settings, runtime.manifest) }, timeout: 90000 });
  assert.equal(result.status, 0, 'Poller timeout diagnostic failed');
  const probe = JSON.parse(result.stdout), [healthy, timeout, recovered] = probe.records;
  for (const scan of [healthy, recovered]) {
    assert.equal(scan.outcome, 'ok'); assert.equal(scan.rows, 5000); assert.equal(scan.pages, 51); assert.equal(scan.digest, runtime.manifest.expected_digest);
  }
  assert.equal(timeout.outcome, 'error'); assert.equal(timeout.error.code, 'TIMEOUT');
  assert.equal(timeout.rows, 1900); assert.equal(timeout.pages, 20); assert.equal(timeout.digest, null);
  tests.push({ image, ...probe });
}
assert.equal(tests[0].proof.cancel_reached_fetch, false);
assert.equal(tests[1].proof.cancel_reached_fetch, true);
assert(tests[0].records[1].metrics.elapsed_ms >= 4900);
assert(tests[1].records[1].metrics.elapsed_ms < 3000);
const report = { checked_at_utc: new Date().toISOString(), passed: true, tests,
  scope: 'Controlled five-second client-side stall at logical fetch 20 of scan 2. A one-second test deadline reproduces the original normalized failure and verifies reconnect, count, validation and hash. The shim models successful native cancellation; this is not an SAP driver stress or performance result.' };
await writeFile(resolve(here, 'timeout-proof.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
