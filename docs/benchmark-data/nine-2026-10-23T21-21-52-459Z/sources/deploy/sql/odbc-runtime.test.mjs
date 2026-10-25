import assert from 'node:assert/strict';
import test from 'node:test';
import { connectionString, cdsPayload, odbcDockerCommand, odbcEnvironment } from './odbc-runtime.mjs';

const settings = { local: true, client: '001', username: 'TEST_USER', password: 'fixture;}value' };
const manifest = { expected_rows: 5000, expected_digest: 'a'.repeat(64) };

test('connection strings escape ODBC values and enforce explicit certificate validation', () => {
  const text = connectionString(settings);
  assert.ok(text.includes('PWD={fixture;}}value};'));
  assert.ok(text.includes('TrustAll={false};'));
  assert.ok(text.includes('TrustedCertificates={/opt/sap/abap-odbc/sap-trial-ca.pem};'));
  assert.ok(text.includes('Driver={/opt/sap/abap-odbc/ODBC_driver_for_ABAP.so};'));
  assert.ok(text.includes('Host={a4h.wdf.sap.corp};'));
});
test('runtime refuses other SAP clients and endpoints', () => {
  assert.throws(() => connectionString({ ...settings, local: false }));
  assert.throws(() => connectionString({ ...settings, client: '000' }));
  assert.throws(() => connectionString(settings, 'external.example'));
});
test('both containers use the same driver and query, with no credential values in arguments', () => {
  for (const language of ['node', 'rust']) {
    const { args } = odbcDockerCommand(language, '172.18.0.2');
    assert.ok(args.includes('ABAP_ODBC_CONNECTION_STRING'));
    assert.ok(!args.join(' ').includes(settings.password));
    assert.ok(args.some(value => value.includes('target=/opt/sap/abap-odbc,readonly')));
    assert.ok(args.some(value => value.includes('target=/run/sql/abap-cds-odbc.sql,readonly')));
    assert.deepEqual(args.slice(-2), ['--transport', 'odbc']);
  }
  const environment = odbcEnvironment(settings, manifest);
  assert.equal(environment.EXPECTED_ROWS, '5000');
  assert.equal(environment.SQL_QUERY_FILE, '/run/sql/abap-cds-odbc.sql');
});
test('CDS payload equality excludes access-specific batches and timings', () => {
  const base = { schema_version: 1, scan_index: 0, outcome: 'ok', rows: 5000, digest: manifest.expected_digest, error: null };
  assert.deepEqual(cdsPayload({ ...base, pages: 50, metrics: { elapsed_ms: 90 } }), cdsPayload({ ...base, pages: 51, metrics: { elapsed_ms: 700 } }));
});
