import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadOdbcRuntime, odbcDockerCommand, odbcEnvironment, invoke, projectRoot } from '../../deploy/sql/odbc-runtime.mjs';
import { loadRuntime, nativeDockerCommand, nativeEnvironment } from '../../deploy/sql/native-runtime.mjs';
const odbc = await loadOdbcRuntime(), native = await loadRuntime();
const image = 'sap-polling-node:nine-fixed-sql', reports = [];
for (const transport of ['odbc', 'hana']) {
  const command = transport === 'odbc' ? odbcDockerCommand('node', odbc.address) : nativeDockerCommand('node');
  const index = command.args.findIndex(value => value.startsWith('sap-polling-node:'));
  command.args.splice(index, command.args.length - index, '--mount', `type=bind,source=${resolve(projectRoot, 'work/node-cds-fix')},target=/proof,readonly`,
    image, '--v8-pool-size=1', '/proof/session-parity.mjs', '--transport', transport);
  const environment = transport === 'odbc' ? odbcEnvironment(odbc.settings, odbc.manifest) : nativeEnvironment(native.settings, native.manifest);
  const result = await invoke(command.program, command.args, { env: { ...process.env, ...environment, REQUEST_TIMEOUT_SECONDS: '10' }, timeout: 90000 });
  assert.equal(result.status, 0, `${transport}: parity process failed`);
  const records = result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.equal(records.length, 3);
  for (const [index, scan] of records.slice(0, 2).entries()) {
    assert.equal(scan.scan_index, index); assert.equal(scan.outcome, 'ok'); assert.equal(scan.rows, 5000);
    assert.equal(scan.digest, odbc.manifest.expected_digest); assert.equal(scan.pages, 51);
  }
  assert.equal(records.at(-1).outcome, 'ok');
  reports.push({ transport, records });
}
const id = await invoke('docker', ['image', 'inspect', '--format', '{{.Id}}', image]);
const report = { checked_at_utc: new Date().toISOString(), passed: true, image, image_id: id.stdout.trim(),
  scope: 'Functional parity only; concurrent host activity makes these diagnostic timings unsuitable for performance comparison', reports };
await writeFile(resolve(projectRoot, 'work/node-cds-fix/live-parity.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
