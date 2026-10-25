import https from 'node:https';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sapSettings, projectRoot } from './sap-runtime.mjs';

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--scans' || !/^[1-9][0-9]*$/.test(args[1]) || Number(args[1]) > 10)) {
  throw new Error('Use --scans 1..10 for finite native ABAP verification');
}
const scans = Number(args[1] || 3);
const settings = sapSettings();
if (!settings.local || settings.client !== '001') throw new Error('Existing local trial/client 001 required');
const seed = JSON.parse(readFileSync(resolve(projectRoot, 'contracts/seed-manifest.json'), 'utf8'));
const query = readFileSync(resolve(projectRoot, 'contracts/native-hana.sql'), 'utf8');
const core = readFileSync(resolve(projectRoot, 'sap/src/zcl_bl_poll_orders.clas.abap'), 'utf8');
const nativeMethod = core.match(/\bMETHOD scan_native\.[\s\S]*?\bENDMETHOD\./i)?.[0];
const queryExpression = nativeMethod?.match(/cursor = statement->execute_query\(([\s\S]*?)\)\./)?.[1];
const embeddedQuery = [...(queryExpression || '').matchAll(/`([^`]*)`/g)].map(match => match[1]).join('');
const normalizeQuery = value => value.trim().replace(/\s+/g, ' ');
if (normalizeQuery(embeddedQuery) !== normalizeQuery(query)) throw new Error('ABAP native query does not match the shared query');
const hash = value => createHash('sha256').update(value).digest('hex');
const directory = resolve(projectRoot, 'work/native-hana');
mkdirSync(directory, { recursive: true });
const origin = new URL(settings.serviceRoot).origin;
const agent = new https.Agent({ keepAlive: true, rejectUnauthorized: false });
const authorization = `Basic ${Buffer.from(`${settings.username}:${settings.password}`).toString('base64')}`;

function request(path, headers, body) {
  return new Promise((accept, reject) => {
    const req = https.request(`${origin}${path}`, { agent, method: body ? 'POST' : 'GET',
      headers: { Authorization: authorization, ...headers } }, response => {
      let output = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { output += chunk; if (output.length > 1048576) req.destroy(new Error('CONTROL_BODY_LIMIT')); });
      response.on('end', () => accept({ status: response.statusCode, headers: response.headers, body: output }));
      response.on('error', () => reject(new Error('CONTROL_RESPONSE_FAILURE')));
    });
    req.setTimeout(180000, () => req.destroy(new Error('CONTROL_TIMEOUT')));
    req.on('error', error => reject(new Error(error.message === 'CONTROL_TIMEOUT' ? error.message : 'CONTROL_TRANSPORT_FAILURE')));
    req.end(body);
  });
}

try {
  const discovery = await request(`/sap/bc/adt/discovery?sap-client=${settings.client}`, { 'X-CSRF-Token': 'Fetch', Accept: 'application/atomsvc+xml' });
  const token = discovery.headers['x-csrf-token'];
  if (discovery.status !== 200 || !token || token === 'Required') throw new Error('CONTROL_CSRF_FETCH_FAILED');
  const cookie = (discovery.headers['set-cookie'] || []).map(value => value.split(';')[0]).join('; ');
  const payload = JSON.stringify({ sap_client: settings.client, expected_rows: seed.expected_rows,
    expected_digest: seed.expected_digest, scan_timeout_seconds: 120, max_pages: 10000,
    duration_seconds: 60, warmup_scans: 0, max_scans: scans });
  const response = await request(`/sap/bc/adt/oo/classrun/ZCL_BL_BENCH_NATIVE?sap-client=${settings.client}`, {
    Cookie: cookie, 'X-CSRF-Token': token, Accept: 'text/plain', 'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  }, payload);
  if (response.status !== 200) throw new Error(`CONTROL_HTTP_${response.status}`);
  if ([settings.password, authorization].some(value => response.body.includes(value))) throw new Error('CONTROL_OUTPUT_REDACTION_FAILED');
  const records = response.body.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
  const scanRecords = records.filter(record => record.kind === 'scan');
  const summaries = records.filter(record => record.kind === 'summary');
  const passed = scanRecords.length === scans && summaries.length === 1 && summaries[0].failed_scans === 0 &&
    summaries[0].measured_scans === scans && scanRecords.every((record, index) => record.scan_index === index &&
      record.outcome === 'ok' && record.rows === seed.expected_rows && record.pages === 51 && record.error === null &&
      record.digest === seed.expected_digest && record.metrics.body_bytes === 0 && record.transport === 'native_hana_adbc');
  const proof = { observed_at: new Date().toISOString(), passed, query_sha256: hash(query),
    source_sha256: hash(core), records };
  writeFileSync(resolve(directory, 'abap-proof.json'), `${JSON.stringify(proof, null, 2)}\n`);
  if (!passed) throw new Error('ABAP_NATIVE_PARITY_FAILED');
  const { kind, phase, transport, logical_fetches, http_requests, ...result } = scanRecords[0];
  writeFileSync(resolve(directory, 'abap-result.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ passed, scans, rows: seed.expected_rows, digest: seed.expected_digest, logical_fetches: 51 }));
} catch (error) {
  console.error(String(error.message).replaceAll(settings.password, '[REDACTED]').replaceAll(authorization, '[REDACTED]'));
  process.exitCode = 1;
} finally { agent.destroy(); }
