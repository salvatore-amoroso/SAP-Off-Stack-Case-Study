import test from 'node:test';
import assert from 'node:assert/strict';
import { assertEvidenceSafe } from './evidence-safety.mjs';
test('public source and text evidence are allowed', () => {
  for (const path of ['src/poller.mjs', 'work/preflight/fixtures.ndjson', 'contracts/fixtures.json', 'unit.xml', '.env.example', 'Dockerfile.sql', 'sources/cancel-shim.cpp', 'sources/cancel-shim.h']) assert.doesNotThrow(() => assertEvidenceSafe(path, Buffer.from('public text')));
});
test('private configuration, distributions, unexpected binaries and traversal are refused', () => {
  for (const path of ['.env', '.env.local', 'work/native-hana/runtime.json', '.npmrc', 'odbc.ini', 'id_rsa', 'driver.SAR', 'ODBC_driver_for_ABAP.so', 'libsapcrypto.so.1', 'SAPCAR', 'certificate.pem', 'key.p12', 'x.exe', 'dump.bin', '../outside.json']) assert.throws(() => assertEvidenceSafe(path, Buffer.from('unrelated text')));
  assert.throws(() => assertEvidenceSafe('file.json', Buffer.from([123,0,125])));
});
test('private keys and unrelated tokens are blocked independently of current SAP credentials', () => {
  const key = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
  assert.throws(() => assertEvidenceSafe('unexpected.txt', Buffer.from(key)), /PRIVATE_KEY/);
  for (const token of ['ghp' + '_' + 'x'.repeat(40), 'github_pat' + '_' + 'x'.repeat(50), 'AK' + 'IA' + 'X'.repeat(16)]) assert.throws(() => assertEvidenceSafe('output.json', Buffer.from(token)), /TOKEN/);
  assert.throws(() => assertEvidenceSafe('output.json', Buffer.from('value=fixture-password'), { secrets: ['fixture-password'] }), /CONFIGURED_CREDENTIAL/);
});
