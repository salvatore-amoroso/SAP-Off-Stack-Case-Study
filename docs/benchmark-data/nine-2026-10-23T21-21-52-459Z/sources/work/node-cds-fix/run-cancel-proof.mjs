import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { loadOdbcRuntime, odbcDockerCommand, odbcEnvironment, invoke, projectRoot } from '../../deploy/sql/odbc-runtime.mjs';
const runtime = await loadOdbcRuntime(), here = resolve(projectRoot, 'work/node-cds-fix');
const reports = [];
for (const image of ['sap-polling-node:nine-sql', 'sap-polling-node:nine-fixed-sql']) {
  const command = odbcDockerCommand('node', runtime.address);
  const index = command.args.indexOf('sap-polling-node:sql-odbc');
  command.args.splice(index, command.args.length - index, '--mount', `type=bind,source=${here},target=/proof,readonly`,
    '--env', 'LD_PRELOAD=/proof/cancel-shim.so', image, '--v8-pool-size=1', '/proof/probe-cursor.mjs');
  const result = await invoke(command.program, command.args, { env: { ...process.env, ...odbcEnvironment(runtime.settings, runtime.manifest) }, timeout: 90000 });
  assert.equal(result.status, 0, 'Native cancellation probe failed');
  const probe = JSON.parse(result.stdout);
  assert.equal(probe.outcome, 'ok'); assert.equal(probe.rows, 100);
  const id = await invoke('docker', ['image', 'inspect', '--format', '{{.Id}}', image]);
  reports.push({ image, image_id: id.stdout.trim(), ...probe });
}
assert.equal(reports[0].proof.cancel_reached_fetch, false);
assert.equal(reports[1].proof.cancel_reached_fetch, true);
assert(reports[0].fetch_elapsed_ms >= 4900);
assert(reports[1].fetch_elapsed_ms < 3000);
const report = { checked_at_utc: new Date().toISOString(), passed: true, tests: reports,
  scope: 'Real node-odbc addon and live SAP cursor; test shim models a stalled native fetch and successful cancellation. This does not prove SAP driver cancellation latency under paging.',
  source_sha256: Object.fromEntries(await Promise.all(['cancel-shim.cpp', 'probe-cursor.mjs', 'run-cancel-proof.mjs'].map(async file => [file, createHash('sha256').update(await readFile(resolve(here, file))).digest('hex')]))) };
await writeFile(resolve(here, 'cancel-proof.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
