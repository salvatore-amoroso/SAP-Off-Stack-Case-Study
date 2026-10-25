import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { sapSettings } from './sap-runtime.mjs';

function workspace(t) {
  const directory = mkdtempSync(resolve(tmpdir(), 'sap-settings-'));
  const root = resolve(directory, 'Workspace/Projects/lab');
  mkdirSync(root, { recursive: true });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return root;
}
const settings = { SAP_URL: 'https://127.0.0.1', SAP_CLIENT: '001', SAP_USERNAME: 'fixture-user', SAP_PASSWORD: 'fixture-password' };

test('SAP settings work from process environment without any sibling tooling', t => {
  const result = sapSettings({ root: workspace(t), env: settings });
  assert.equal(result.username, settings.SAP_USERNAME);
  assert.equal(result.client, '001');
  assert(result.local);
  assert(result.serviceRoot.startsWith('https://127.0.0.1/sap/opu/odata4/'));
});

test('Node built-in parser reads a selected private file and environment overrides it', t => {
  const root = workspace(t), file = resolve(root, 'private-settings.env');
  writeFileSync(file, 'SAP_URL=https://localhost:443\nSAP_USERNAME="fixture user"\nSAP_PASSWORD="fixture#password"\nABAP_ODBC_DRIVER_DIR=private-driver\n');
  assert.equal(sapSettings({ root, env: { SAP_ENV_PATH: file } }).driverDirectory, resolve(root, 'private-driver'));
  const result = sapSettings({ root, env: { SAP_ENV_PATH: file, SAP_CLIENT: '002', ABAP_ODBC_DRIVER_DIR: 'licensed-driver' } });
  assert.equal(result.username, 'fixture user');
  assert.equal(result.password, 'fixture#password');
  assert.equal(result.client, '002');
  assert.equal(result.driverDirectory, resolve(root, 'licensed-driver'));
});

test('project .env takes precedence over the optional legacy file', t => {
  const root = workspace(t), legacy = resolve(root, '../../Tools/mcp-abap-adt');
  mkdirSync(legacy, { recursive: true });
  writeFileSync(resolve(legacy, '.env'), Object.entries(settings).map(([key, value]) => `${key}=${value}`).join('\n'));
  assert.equal(sapSettings({ root, env: {} }).username, 'fixture-user');
  writeFileSync(resolve(root, '.env'), 'SAP_URL=https://localhost\nSAP_USERNAME=project-user\nSAP_PASSWORD=fixture-password\n');
  assert.equal(sapSettings({ root, env: {} }).username, 'project-user');
});

test('missing/invalid settings give actionable errors without echoing credentials', t => {
  const root = workspace(t);
  assert.throws(() => sapSettings({ root, env: {} }), /Missing SAP settings: SAP_URL, SAP_USERNAME, SAP_PASSWORD/);
  assert.throws(() => sapSettings({ root, env: { ...settings, SAP_ENV_PATH: resolve(root, 'missing') } }), /Unable to read SAP settings/);
  for (const value of ['ftp://localhost', 'https://user:private@localhost', 'https://localhost/path', 'https://localhost/?secret=private']) {
    assert.throws(() => sapSettings({ root, env: { ...settings, SAP_URL: value } }), error => !error.message.includes('private') && /SAP_URL/.test(error.message));
  }
  assert.throws(() => sapSettings({ root, env: { ...settings, SAP_CLIENT: '1' } }), /three digits/);
  assert.throws(() => sapSettings({ root, env: { ...settings, SAP_PASSWORD: 'private\nvalue' } }), error => !error.message.includes('private') && /newline/.test(error.message));
});
