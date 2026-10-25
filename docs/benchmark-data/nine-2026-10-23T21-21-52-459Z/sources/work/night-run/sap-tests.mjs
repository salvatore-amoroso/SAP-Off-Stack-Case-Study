import https from 'node:https';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { sapSettings } from '../../scripts/sap-runtime.mjs';
const settings = sapSettings(); assert(settings.local && settings.client === '001');
const origin = new URL(settings.serviceRoot).origin;
const agent = new https.Agent({ rejectUnauthorized: false });
const authorization = `Basic ${Buffer.from(`${settings.username}:${settings.password}`).toString('base64')}`;
async function request(path, headers = {}, payload) {
  return new Promise((resolve, reject) => {
    const req = https.request(origin + path, { agent, method: payload ? 'POST' : 'GET', headers: { Authorization: authorization, ...headers } }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', part => { body += part; if (body.length > 8388608) req.destroy(new Error('BODY_LIMIT')); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.setTimeout(60000, () => req.destroy(new Error('SAP_TEST_TIMEOUT'))); req.on('error', reject); req.end(payload);
  });
}
try {
  const discovery = await request('/sap/bc/adt/discovery?sap-client=001', { 'X-CSRF-Token': 'Fetch', Accept: 'application/atomsvc+xml' });
  assert.equal(discovery.status, 200);
  const headers = { 'X-CSRF-Token': discovery.headers['x-csrf-token'], Cookie: (discovery.headers['set-cookie'] || []).map(value => value.split(';')[0]).join('; ') };
  const fixtures = await request('/sap/bc/adt/oo/classrun/ZCL_BL_TEST_ORDERS?sap-client=001', { ...headers, Accept: 'text/plain', 'Content-Type': 'application/json' }, '{}');
  assert.equal(fixtures.status, 200);
  const records = fixtures.body.trim().split(/\r?\n/).map(line => JSON.parse(line));
  const cases = JSON.parse(await readFile('contracts/fixtures.json', 'utf8')).cases;
  for (const item of cases) { const actual = records.find(record => record.id === item.id); assert(actual?.passed, item.id); }
  const xml = '<?xml version="1.0"?><aunit:run xmlns:aunit="http://www.sap.com/adt/api/aunit" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:osl="http://www.sap.com/api/osl" title="Lab readiness" context="Local benchmark"><aunit:options><aunit:scope ownTests="true" foreignTests="false" addForeignTestsAsPreview="false"/><aunit:riskLevel harmless="true" dangerous="false" critical="false"/><aunit:duration short="true" medium="true" long="true"/></aunit:options><osl:objectSet xsi:type="osl:flatObjectSet"><osl:object name="ZCL_BL_POLL_ORDERS" type="CLAS"/></osl:objectSet></aunit:run>';
  const start = await request('/sap/bc/adt/abapunit/runs?sap-client=001', { ...headers, Accept: 'application/xml', 'Content-Type': 'application/vnd.sap.adt.api.abapunit.run.v2+xml' }, xml);
  assert([200, 201, 202].includes(start.status), `Unit start HTTP ${start.status}`);
  const id = start.headers.location?.match(/\/runs\/([^/?]+)/)?.[1] || start.body.match(/\bid="([^"]+)"/)?.[1];
  assert(id && /^[A-Za-z0-9_-]+$/.test(id), 'Unit run identifier');
  await request(`/sap/bc/adt/abapunit/runs/${id}?sap-client=001&withLongPolling=true`, { Accept: 'application/vnd.sap.adt.api.abapunit.run-status.v1+xml' });
  const unit = await request(`/sap/bc/adt/abapunit/results/${id}?sap-client=001`, { Accept: 'application/vnd.sap.adt.api.abapunit.run-result.v1+xml' });
  assert.equal(unit.status, 200);
  assert(!unit.body.includes(settings.password) && !unit.body.includes(authorization), 'Unit redaction check');
  await writeFile('work/night-run/unit-attempt.xml', unit.body);
  assert(!/<(?:\w+:)?alert(?:\s|>)/.test(unit.body), 'ABAP Unit reported alerts');
  const methods = unit.body.match(/<(?:\w+:)?testMethod(?:\s|>)/g) || [];
  assert.equal(methods.length, 9, 'ABAP Unit method count');
  for (const [name, bytes] of [['fixtures.ndjson', fixtures.body], ['unit.xml', unit.body]]) {
    assert(!bytes.includes(settings.password) && !bytes.includes(authorization), 'Output redaction check');
    await writeFile(`work/night-run/${name}`, bytes);
  }
  const report = { checked_at_utc: new Date().toISOString(), passed: true, shared_fixtures: cases.length, unit_methods: methods.length,
    route: 'Stateless authenticated ADT requests using the existing local runtime credentials; no SAP source or configuration changes' };
  await writeFile('work/night-run/sap-tests.json', JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report));
} finally { agent.destroy(); }
