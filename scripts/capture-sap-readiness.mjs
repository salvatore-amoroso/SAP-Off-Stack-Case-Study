import https from 'node:https';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sapSettings, sapGet, projectRoot } from './sap-runtime.mjs';
import { dockerProgram, invoke } from '../deploy/sql/native-runtime.mjs';
import { sapSourceSpecs, sapSourceBindingVersion, localSapSource, assertSapSourceMatches, normalizeViewDefinition, projectRelative, sha256 } from './nine-readiness.mjs';
import { parseCaseResults, unitMethodCount } from './abap-results.mjs';

export async function readNativeViewDefinition() {
  const sql = "SELECT BINTOHEX(TO_BINARY(TO_NVARCHAR(DEFINITION))) FROM SYS.VIEWS WHERE SCHEMA_NAME='ZBL_BENCH_SQL' AND VIEW_NAME='ORDER_POSITIONS_001';";
  const script = `set -eu\numask 077\nsql_file="$(mktemp /tmp/zbl-view-read-XXXXXX.sql)"\ntrap 'rm -f -- "$sql_file"' EXIT\ncat > "$sql_file" <<'ZBL_SQL'\n${sql}\nZBL_SQL\n/usr/sap/HDB/HDB02/exe/hdbsql -U DEFAULT -a -x -I "$sql_file"\n`;
  const result = await invoke(dockerProgram, ['exec', '--interactive', '--user', 'a4hadm', 'a4h', '/bin/bash'], { input: script, timeout: 30000 });
  assert.equal(result.status, 0, 'Native view metadata query failed');
  const encoded = result.stdout.split(/\r?\n/).map(line => line.trim()).find(line => /^"?(?:[0-9a-f]{2})+"?$/i.test(line));
  assert(encoded, 'Native view metadata was absent or invalid');
  return Buffer.from(encoded.replaceAll('"', ''), 'hex').toString('utf8');
}

export async function inspectSapContainer() {
  const result = await invoke(dockerProgram, ['inspect', '--format', '{"image":{{json .Config.Image}},"memory_limit":{{json .HostConfig.Memory}},"memory_swap_limit":{{json .HostConfig.MemorySwap}},"nano_cpus":{{json .HostConfig.NanoCpus}},"started_at":{{json .State.StartedAt}}}', 'a4h']);
  assert.equal(result.status, 0, 'Unable to inspect the existing SAP container');
  return JSON.parse(result.stdout);
}

function adtClient(settings) {
  const origin = new URL(settings.serviceRoot).origin;
  assert(origin.startsWith('https://'), 'SAP readiness requires the HTTPS ADT control endpoint');
  const agent = new https.Agent({ keepAlive: true, rejectUnauthorized: !settings.local });
  const authorization = `Basic ${Buffer.from(`${settings.username}:${settings.password}`).toString('base64')}`;
  const sensitive = [settings.password, authorization];
  return {
    close: () => agent.destroy(),
    safe: text => { assert(!sensitive.some(value => text.includes(value)), 'SAP output contains credentials'); return text; },
    request: (path, headers = {}, body) => new Promise((accept, reject) => {
      const request = https.request(origin + path, { agent, method: body === undefined ? 'GET' : 'POST', headers: { Authorization: authorization, ...(body === undefined ? {} : { 'Content-Length': Buffer.byteLength(body) }), ...headers } }, response => {
        let bytes = 0; const chunks = [];
        response.on('data', chunk => { bytes += chunk.length; if (bytes > 8388608) request.destroy(new Error('SAP_CAPTURE_BODY_LIMIT')); else chunks.push(chunk); });
        response.on('end', () => accept({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
        response.on('error', () => reject(new Error('SAP_CAPTURE_RESPONSE_FAILED')));
      });
      const deadline = setTimeout(() => request.destroy(new Error('SAP_CAPTURE_TIMEOUT')), 90000);
      request.on('close', () => clearTimeout(deadline));
      request.on('error', error => reject(new Error(error.message === 'SAP_CAPTURE_TIMEOUT' ? error.message : 'SAP_CAPTURE_REQUEST_FAILED')));
      request.end(body);
    }),
  };
}

function verifyCases(text, fixtures) {
  const parsed = parseCaseResults(text, { requireSummary: true });
  assert.equal(parsed.cases.length, fixtures.length, 'SAP fixture count differs from the current contract');
  for (const fixture of fixtures) {
    const actual = parsed.cases.find(item => item.id === fixture.id);
    assert(actual?.passed, `SAP fixture failed: ${fixture.id}`);
    const { outcome, rows, pages, digest, error } = actual.result;
    assert.deepEqual({ outcome, rows, pages, digest, error }, fixture.expected, `SAP fixture result differs: ${fixture.id}`);
  }
  return parsed.cases.length;
}

export async function captureActiveSapSources({ root = projectRoot, settings, includeHttp = false, get = sapGet, store }) {
  const checks = [];
  for (const source of sapSourceSpecs({ includeHttp })) {
    const active = await get(new URL(`${source.uri}?sap-client=001&version=active`, settings.serviceRoot), settings, { insecureLocal: true, accept: 'text/plain' });
    assert.equal(active.status, 200, `Unable to read active SAP source: ${source.id}`);
    if (settings.password) assert(!active.body.includes(settings.password), 'SAP source contains credentials');
    const local = await localSapSource(root, source);
    assertSapSourceMatches(source, active.body, local);
    checks.push({ id: source.id, name: source.name, kind: source.kind, part: source.part, path: source.path, uri: source.uri,
      status: 200, local_present: local !== null, source_sha256: local === null ? null : sha256(local), ...await store(`${source.id}.active.abap`, active.body) });
  }
  return checks;
}

export async function captureSapReadiness(output, { includeHttp = false } = {}) {
  const directory = resolve(projectRoot, output);
  assert(directory.startsWith(resolve(projectRoot, 'work') + sep), 'Capture output must be a new directory under ignored work/');
  const settings = sapSettings();
  assert(settings.local && settings.client === '001', 'Existing local trial/client 001 required');
  const client = adtClient(settings);
  const store = async (name, text) => {
    client.safe(text);
    const path = resolve(directory, name);
    await writeFile(path, text, { flag: 'wx' });
    return { file: projectRelative(projectRoot, path), sha256: sha256(text) };
  };
  await mkdir(dirname(directory), { recursive: true });
  await mkdir(directory);
  try {
    const sapContainer = await inspectSapContainer();
    // Bind all executable and test parts before invoking either fixture runner or Unit.
    const sourceChecks = await captureActiveSapSources({ settings, includeHttp, store });
    const discovery = await client.request('/sap/bc/adt/discovery?sap-client=001', { 'X-CSRF-Token': 'Fetch', Accept: 'application/atomsvc+xml' });
    assert.equal(discovery.status, 200, 'SAP ADT discovery failed');
    const token = discovery.headers['x-csrf-token']; assert(token && token !== 'Required', 'SAP ADT CSRF token is missing');
    const headers = { 'X-CSRF-Token': token, Cookie: (discovery.headers['set-cookie'] || []).map(value => value.split(';')[0]).join('; ') };
    const classRun = async name => {
      const result = await client.request(`/sap/bc/adt/oo/classrun/${name}?sap-client=001`, { ...headers, Accept: 'text/plain', 'Content-Type': 'application/json' }, '{}');
      assert.equal(result.status, 200, `SAP class-run failed: ${name}`);
      return client.safe(result.body);
    };
    const contract = await readFile(resolve(projectRoot, 'contracts/fixtures.json'));
    const fixtures = JSON.parse(contract).cases;
    const fixtureText = await classRun('ZCL_BL_TEST_ORDERS');
    const fixtureCount = verifyCases(fixtureText, fixtures);
    const fixtureEvidence = { ...await store('fixtures.ndjson', fixtureText), cases: fixtureCount };
    const unitSource = await readFile(resolve(projectRoot, 'sap/src/zcl_bl_poll_orders.clas.testclasses.abap'));
    const expectedMethods = (unitSource.toString('utf8').match(/\bMETHODS\s+\w+\s+FOR\s+TESTING\b/gi) || []).length;
    const unitRequest = '<?xml version="1.0"?><aunit:run xmlns:aunit="http://www.sap.com/adt/api/aunit" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:osl="http://www.sap.com/api/osl" title="Lab readiness" context="Local benchmark"><aunit:options><aunit:scope ownTests="true" foreignTests="false" addForeignTestsAsPreview="false"/><aunit:riskLevel harmless="true" dangerous="false" critical="false"/><aunit:duration short="true" medium="true" long="true"/></aunit:options><osl:objectSet xsi:type="osl:flatObjectSet"><osl:object name="ZCL_BL_POLL_ORDERS" type="CLAS"/></osl:objectSet></aunit:run>';
    const started = await client.request('/sap/bc/adt/abapunit/runs?sap-client=001', { ...headers, Accept: 'application/xml', 'Content-Type': 'application/vnd.sap.adt.api.abapunit.run.v2+xml' }, unitRequest);
    assert([200, 201, 202].includes(started.status), 'Unable to start ABAP Unit');
    const id = started.headers.location?.match(/\/runs\/([^/?]+)/)?.[1] || started.body.match(/\bid="([^"]+)"/)?.[1];
    assert(id && /^[A-Za-z0-9_-]+$/.test(id), 'Invalid ABAP Unit run identifier');
    const status = await client.request(`/sap/bc/adt/abapunit/runs/${id}?sap-client=001&withLongPolling=true`, { ...headers, Accept: 'application/vnd.sap.adt.api.abapunit.run-status.v1+xml' });
    assert.equal(status.status, 200, 'ABAP Unit status unavailable');
    const unit = await client.request(`/sap/bc/adt/abapunit/results/${id}?sap-client=001`, { ...headers, Accept: 'application/vnd.sap.adt.api.abapunit.run-result.v1+xml' });
    assert.equal(unit.status, 200, 'ABAP Unit result unavailable');
    const unitEvidence = await store('unit.xml', unit.body), methods = unitMethodCount(unit.body);
    assert.equal(methods, expectedMethods, 'ABAP Unit count differs from current local test source');
    const definition = await readNativeViewDefinition(), viewSource = await readFile(resolve(projectRoot, 'sap/setup/native-hana-view.sql'));
    client.safe(definition);
    assert(normalizeViewDefinition(definition) === normalizeViewDefinition(viewSource.toString('utf8')), 'Native view differs from the checked-in definition');
    const viewEvidence = { ...await store('view-definition.csv', definition), source_sha256: sha256(viewSource) };
    let http;
    if (includeHttp) {
      const scenarios = [...fixtures.filter(item => !item.id.startsWith('config_') && !item.offline_only), ...JSON.parse(await readFile(resolve(projectRoot, 'contracts/http-scenarios.json'))).cases];
      const text = await classRun('ZCL_BL_TEST_HTTP');
      http = { ...await store('http.ndjson', text), cases: verifyCases(text, scenarios) };
    }
    assert.deepEqual(await inspectSapContainer(), sapContainer, 'SAP restarted or its allocation changed during preflight');
    const proof = { schema_version: 1, source_binding_version: sapSourceBindingVersion, include_http: includeHttp, checked_at_utc: new Date().toISOString(), passed: true, contract_sha256: sha256(contract), source_checks: sourceChecks,
      fixtures: fixtureEvidence, unit: { ...unitEvidence, methods, source_sha256: sha256(unitSource) }, native_view: viewEvidence, ...(http ? { http } : {}), sap_container: sapContainer,
      scope: 'Read-only source/view checks and harmless ABAP fixture/Unit execution on existing local trial; no data seeding, source activation or parameter changes.' };
    const saved = await store('preflight.json', JSON.stringify(proof, null, 2) + '\n');
    return { passed: true, preflight: saved.file, shared_fixtures: fixtureCount, unit_methods: methods, active_sources: sourceChecks.length, source_binding_version: sapSourceBindingVersion, ...(http ? { http_cases: http.cases } : {}) };
  } finally { client.close(); }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') { console.log('Usage: node scripts/capture-sap-readiness.mjs --output work/NEW-PREFLIGHT-DIRECTORY [--http]'); return; }
  assert(args[0] === '--output' && args[1] && (args.length === 2 || args.length === 3 && args[2] === '--http'), 'Use --output work/NEW-PREFLIGHT-DIRECTORY [--http]');
  console.log(JSON.stringify(await captureSapReadiness(args[1], { includeHttp: args[2] === '--http' })));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(JSON.stringify({ passed: false, error: error.message })); process.exitCode = 1; });
