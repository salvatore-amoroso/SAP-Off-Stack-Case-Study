import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { sapGet } from '../../scripts/sap-runtime.mjs';
import { runCdsBenchmark } from '../../scripts/benchmark-control.mjs';
import { loadOdbcRuntime, odbcDockerCommand, odbcEnvironment, invoke } from '../../deploy/sql/odbc-runtime.mjs';
const runtime = await loadOdbcRuntime(), { settings, manifest } = runtime;
const normalize = value => value.replaceAll('\r\n', '\n').trimEnd() + '\n';
const hash = value => createHash('sha256').update(value).digest('hex');
const checks = [];
for (const [kind, names] of [
  ['class', ['zcl_bl_poll_orders', 'zcl_bl_bench_orders', 'zcl_bl_bench_cds', 'zcl_bl_bench_native']],
  ['ddl', ['zi_bl_orderheader', 'zi_bl_orderposition']],
]) for (const name of names) {
  const path = kind === 'class' ? `/sap/bc/adt/oo/classes/${name}/source/main` : `/sap/bc/adt/ddic/ddl/sources/${name}/source/main`;
  const response = await sapGet(new URL(`${path}?sap-client=001&version=active`, settings.serviceRoot), settings, { insecureLocal: true, accept: 'text/plain' });
  assert.equal(response.status, 200, name);
  const local = await readFile(`sap/src/${name}.${kind === 'class' ? 'clas.abap' : 'ddls.asddls'}`, 'utf8');
  assert.equal(normalize(response.body), normalize(local), name);
  assert(!response.body.includes(settings.password), 'Source redaction check');
  const file = `work/node-cds-fix/${name}.active.abap`;
  await writeFile(file, response.body);
  checks.push({ name, type: kind, file, active_sha256: hash(response.body), normalized_sha256: hash(normalize(response.body)), matches_current_local: true });
}
const records = (await runCdsBenchmark({ durationSeconds: 60, warmupScans: 0, maxScans: 1, manifest })).trim().split(/\r?\n/).map(line => JSON.parse(line));
const scans = records.filter(record => record.kind === 'scan');
assert.equal(scans.length, 1);
const abap = scans[0];
assert.equal(abap.outcome, 'ok'); assert.equal(abap.rows, 5000); assert.equal(abap.digest, manifest.expected_digest);
assert.equal(abap.transport, 'direct_cds'); assert.equal(abap.pages, 50);
const command = odbcDockerCommand('rust', runtime.address);
command.args[command.args.indexOf('sap-polling-rust:sql-odbc')] = 'sap-polling-rust:nine-sql';
const execution = await invoke(command.program, command.args, { env: { ...process.env, ...odbcEnvironment(settings, manifest), REQUEST_TIMEOUT_SECONDS: '10' }, timeout: 90000 });
assert.equal(execution.status, 0);
const rust = JSON.parse(execution.stdout);
assert.equal(rust.outcome, 'ok'); assert.equal(rust.rows, abap.rows); assert.equal(rust.digest, abap.digest); assert.equal(rust.pages, 51);
const node = JSON.parse(await readFile('work/node-cds-fix/live-parity.json', 'utf8'));
assert(node.passed && node.reports[0].records.slice(0, 2).every(scan => scan.digest === abap.digest && scan.rows === abap.rows));
const report = { checked_at_utc: new Date().toISOString(), passed: true, source_checks: checks,
  scope: 'Functional source and digest parity only. Internal ABAP has 50 nonempty packages; external ODBC counts 51 fetches including EOF.', abap, rust,
  node_reference: 'work/node-cds-fix/live-parity.json', node_reference_sha256: hash(await readFile('work/node-cds-fix/live-parity.json')) };
await writeFile('work/node-cds-fix/abap-parity.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ passed: true, active_sources: checks.length, abap_rows: abap.rows, rust_rows: rust.rows, digest: abap.digest }));
