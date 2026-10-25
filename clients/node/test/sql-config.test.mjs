import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sqlConfig } from '../src/sql-config.mjs';

const manifest = JSON.parse(await readFile(new URL('../../../contracts/seed-manifest.json', import.meta.url), 'utf8'));
const names = ['SQL_TRANSPORT', 'SQL_QUERY_FILE', 'ABAP_ODBC_CONNECTION_STRING', 'HANA_SERVER', 'HANA_DATABASE', 'HANA_USER', 'HANA_PASSWORD', 'SAP_SERVICE_ROOT', 'SAP_CLIENT', 'EXPECTED_ROWS', 'EXPECTED_DIGEST', 'SCANS', 'POLL_INTERVAL_MS', 'REQUEST_TIMEOUT_SECONDS', 'SCAN_TIMEOUT_SECONDS', 'PAGE_SIZE', 'MAX_BODY_BYTES', 'MAX_PAGES', 'SAP_TLS_INSECURE'];

async function withEnvironment(values, action) {
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  Object.assign(process.env, { EXPECTED_ROWS: String(manifest.expected_rows), EXPECTED_DIGEST: manifest.expected_digest, ...values });
  try { return await action(); }
  finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
}

test('CDS ODBC requires an explicit shared query instead of the HANA default', async () => {
  await withEnvironment({ ABAP_ODBC_CONNECTION_STRING: 'fixture-only' }, async () => {
    await assert.rejects(sqlConfig(['--transport', 'odbc']), error => error.code === 'CONFIG' && /SQL_QUERY_FILE/.test(error.message));
  });
});

test('CDS ODBC loads the shared query and fixed 100-row configuration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'node-cds-config-'));
  try {
    const query = 'SELECT ORDERID FROM CDS_FIXTURE ORDER BY ORDERID';
    const path = join(directory, 'query.sql');
    await writeFile(path, query);
    await withEnvironment({ SQL_QUERY_FILE: path, ABAP_ODBC_CONNECTION_STRING: 'fixture-only' }, async () => {
      const config = await sqlConfig(['--transport', 'odbc']);
      assert.equal(config.transport, 'odbc');
      assert.equal(config.sql, query);
      assert.equal(config.page_size, 100);
      assert.equal(config.expected_digest, manifest.expected_digest);
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('native HANA retains the existing default shared query', async () => {
  await withEnvironment({ HANA_SERVER: 'fixture:30015', HANA_DATABASE: 'FIXTURE', HANA_USER: 'fixture', HANA_PASSWORD: 'fixture-only' }, async () => {
    const config = await sqlConfig(['--transport', 'hana']);
    assert.equal(config.transport, 'hana');
    assert.equal(config.sql, await readFile(new URL('../../../contracts/native-hana.sql', import.meta.url), 'utf8'));
  });
});
