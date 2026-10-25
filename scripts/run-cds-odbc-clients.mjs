import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { runCdsBenchmark } from './benchmark-control.mjs';
import { sapGet } from './sap-runtime.mjs';
import { scanResult, functional } from '../deploy/sql/native-runtime.mjs';
import { cdsPayload, dockerProgram, invoke, loadOdbcRuntime, odbcDirectory, odbcDockerCommand, odbcEnvironment, projectRoot, sapCertificateHost } from '../deploy/sql/odbc-runtime.mjs';

async function run() {
  if (process.argv.length !== 2) throw new Error('Unexpected CDS verification arguments');
  const runtime = await loadOdbcRuntime();
  const { settings, manifest, address } = runtime;
  await mkdir(odbcDirectory, { recursive: true });
  const active = await sapGet(new URL('/sap/bc/adt/oo/classes/zcl_bl_poll_orders/source/main?sap-client=001', settings.serviceRoot).href, settings, { insecureLocal: true, accept: 'text/plain' });
  if (active.status !== 200) throw new Error('Unable to read active ABAP validation core');
  const localCore = await readFile(resolve(projectRoot, 'sap/src/zcl_bl_poll_orders.clas.abap'), 'utf8');
  if (active.body.replaceAll('\r\n', '\n').trim() !== localCore.replaceAll('\r\n', '\n').trim()) throw new Error('Active ABAP core differs from local shared validator');
  const records = (await runCdsBenchmark({ durationSeconds: 60, warmupScans: 0, maxScans: 1, manifest })).split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
  const abap = records.filter(record => record.kind === 'scan');
  if (abap.length !== 1 || abap[0].scan_index !== 0 || abap[0].transport !== 'direct_cds' || abap[0].http_requests !== 0) throw new Error('ABAP direct CDS control did not return one scan');
  const successful = result => result.outcome === 'ok' && result.rows === manifest.expected_rows && result.digest === manifest.expected_digest && result.error === null && result.metrics.body_bytes === 0;
  if (!successful(abap[0])) throw new Error('ABAP direct CDS reference failed');
  const implementations = { abap: { app: 'abap-cds', status: 'passed', result: abap[0] } };
  const environment = { ...process.env, ...odbcEnvironment(settings, manifest) };
  for (const implementation of ['node', 'rust']) {
    const name = `cds-odbc-${implementation}-${randomUUID().slice(0, 8)}`;
    const command = odbcDockerCommand(implementation, address, { name });
    const execution = await invoke(command.program, command.args, { env: environment, timeout: 150000 });
    if (execution.timed_out || execution.oversized) await invoke(dockerProgram, ['rm', '--force', name]);
    let result;
    try { result = scanResult(execution.stdout); } catch { /* Keep invalid output out of the report. */ }
    const passed = execution.status === 0 && !execution.timed_out && !execution.oversized && result && successful(result) && result.pages === 51 && isDeepStrictEqual(cdsPayload(result), cdsPayload(abap[0]));
    const image = await invoke(dockerProgram, ['image', 'inspect', '--format', '{{.Id}}', `sap-polling-${implementation}:sql-odbc`]);
    implementations[implementation] = { app: `${implementation}-cds`, status: passed ? 'passed' : 'failed', image_id: image.status === 0 ? image.stdout.trim() : null, exit_code: execution.status, timed_out: execution.timed_out, result: result ?? null };
  }
  const nodeRustMatch = Boolean(implementations.node.result && implementations.rust.result && isDeepStrictEqual(functional(implementations.node.result), functional(implementations.rust.result)));
  const report = { schema_version: 1, observed_at: new Date().toISOString(), transport: 'cds_odbc', service_binding: 'ZUI_BL_ORDERS_SQL',
    expected_rows: manifest.expected_rows, expected_digest: manifest.expected_digest, query_sha256: runtime.query_sha256,
    abap_source_sha256: createHash('sha256').update(active.body).digest('hex'), driver_files: runtime.driver_files,
    certificate_validation: { trust_all: false, expected_host: sapCertificateHost, trusted_file: 'sap-trial-ca.pem' },
    implementations, node_rust_functional_match: nodeRustMatch,
    cds_payload_match: Object.values(implementations).every(item => item.result && isDeepStrictEqual(cdsPayload(item.result), cdsPayload(abap[0]))),
    application_batches: { abap: 'Internal CDS packages; excludes empty final fetch', odbc: 'Attempts including empty final fetch' },
    all_passed: nodeRustMatch && Object.values(implementations).every(item => item.status === 'passed') };
  await writeFile(resolve(odbcDirectory, 'parity.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.all_passed ? 0 : 1;
}
run().catch(() => { process.stderr.write('Unable to configure or verify the CDS ODBC applications.\n'); process.exitCode = 1; });
