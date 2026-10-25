import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { abapEvidence, mountedSource, nativeDockerCommand, nativeEnvironment, parityReport, runtimeObjects, scanResult, validScan, validateRuntime } from './native-runtime.mjs';

const manifest = JSON.parse(await readFile(new URL('../../contracts/seed-manifest.json', import.meta.url), 'utf8'));
const sql = await readFile(new URL('../../contracts/native-hana.sql', import.meta.url), 'utf8');
const settings = { HANA_SERVER: 'sap-a4h:30215', HANA_DATABASE: 'HDB', HANA_USER: 'ZBL_BENCH_RO', HANA_PASSWORD: 'fixture-secret' };
const successful = { schema_version: 1, scan_index: 0, outcome: 'ok', rows: 5000, pages: 51, digest: manifest.expected_digest, error: null, metrics: { elapsed_ms: 1, body_bytes: 0, missed_slots: 0 } };

test('native Docker commands have equal bounds and no credential values', () => {
  for (const implementation of ['node', 'rust']) {
    const command = nativeDockerCommand(implementation, { name: `native-hana-${implementation}-fixture` });
    const value = flag => command.args[command.args.indexOf(flag) + 1];
    assert.equal(value('--cpus'), '1');
    assert.equal(value('--memory'), '256m');
    assert.equal(value('--memory-swap'), '256m');
    assert.equal(value('--network'), 'sap-local-ports');
    assert.ok(value('--mount').endsWith('target=/run/sql/native-hana.sql,readonly'));
    assert.deepEqual(command.args.slice(-2), ['--transport', 'hana']);
    assert.ok(command.args.includes('HANA_PASSWORD'));
    assert.equal(JSON.stringify(command).includes(settings.HANA_PASSWORD), false);
  }
  const environment = nativeEnvironment(settings, manifest);
  assert.equal(environment.HANA_SERVER, 'sap-a4h:30215');
  assert.equal(environment.SCANS, '1');
  assert.equal(environment.PAGE_SIZE, '100');
  assert.throws(() => nativeDockerCommand('invalid'));
  assert.throws(() => nativeDockerCommand('node', { name: 'a4h' }));
  const mounted = nativeDockerCommand('node', { sourceDirectory: 'C:/fixture/src' });
  assert.ok(mounted.args.includes('type=bind,source=C:/fixture/src,target=/app/src,readonly'));
  assert.throws(() => nativeDockerCommand('rust', { sourceDirectory: 'C:/fixture/src' }));
});

test('mounted source records deterministic code hashes without source contents', async () => {
  const directory = fileURLToPath(new URL('../../clients/node/src/', import.meta.url));
  const first = await mountedSource(directory);
  const second = await mountedSource(directory);
  assert.deepEqual(first, second);
  assert.match(first.sha256, /^[a-f0-9]{64}$/);
  assert.ok(first.files.includes('sql-cli.mjs'));
});

test('Kubernetes runtime objects use inspected IP, exact shared SQL and runtime Secret', () => {
  validateRuntime(settings, manifest);
  const objects = runtimeObjects(settings, manifest, sql, '172.22.0.2').items;
  const config = objects.find(item => item.metadata.name === 'native-hana-config');
  const query = objects.find(item => item.metadata.name === 'native-hana-query');
  const secret = objects.find(item => item.kind === 'Secret');
  assert.equal(config.data.HANA_SERVER, '172.22.0.2:30215');
  assert.equal(config.data.HANA_PASSWORD, undefined);
  assert.equal(config.data.EXPECTED_DIGEST, manifest.expected_digest);
  assert.equal(query.data['native-hana.sql'], sql);
  assert.equal(Buffer.from(secret.data.HANA_PASSWORD, 'base64').toString(), settings.HANA_PASSWORD);
  assert.throws(() => runtimeObjects(settings, manifest, sql, 'sap-a4h'));
  assert.throws(() => validateRuntime({ ...settings, HANA_USER: 'SYSTEM' }, manifest));
});

test('only contract result fields survive captured client stdout', () => {
  const parsed = scanResult(JSON.stringify({ ...successful, HANA_PASSWORD: settings.HANA_PASSWORD, metrics: { ...successful.metrics, unsafe: settings.HANA_PASSWORD } }));
  assert.deepEqual(parsed, successful);
  assert.equal(JSON.stringify(parsed).includes(settings.HANA_PASSWORD), false);
  assert.equal(validScan(parsed, manifest), true);
  assert.equal(validScan({ ...parsed, pages: 50 }, manifest), false);
  assert.throws(() => scanResult({ ...successful, outcome: 'error', digest: null, error: { code: settings.HANA_PASSWORD, page_index: 0, http_status: null } }));
  assert.throws(() => scanResult(`${JSON.stringify(successful)}\n${JSON.stringify(successful)}`));
});

test('missing ABAP evidence stays pending and complete functional equality passes', () => {
  const client = { status: 'passed', passed: true, result: successful };
  const pending = parityReport({ node: client, rust: client, abap: { status: 'pending', passed: false } }, manifest, 'fixture-hash');
  assert.equal(pending.status, 'pending');
  assert.equal(pending.node_rust_passed, true);
  assert.equal(pending.functional_match, null);
  assert.equal(pending.all_passed, false);
  const passed = parityReport({ node: client, rust: client, abap: { ...client, result: { ...successful, metrics: { ...successful.metrics, elapsed_ms: 999 } } } }, manifest, 'fixture-hash');
  assert.equal(passed.status, 'passed');
  assert.equal(passed.all_passed, true);
  const failed = parityReport({ node: client, rust: { status: 'failed', passed: false }, abap: client }, manifest, 'fixture-hash');
  assert.equal(failed.status, 'failed');
  const proof = { passed: true, query_sha256: 'fixture-hash', observed_at: '2026-10-23T12:00:00Z', records: [{ kind: 'scan', ...successful }] };
  assert.equal(abapEvidence(successful, undefined, manifest, 'fixture-hash').status, 'pending');
  assert.equal(abapEvidence(successful, proof, manifest, 'fixture-hash').status, 'passed');
  assert.equal(abapEvidence(successful, { ...proof, query_sha256: 'old-hash' }, manifest, 'fixture-hash').status, 'failed');
  assert.equal(abapEvidence(successful, { ...proof, records: [{ kind: 'scan', ...successful, pages: 50 }] }, manifest, 'fixture-hash').status, 'failed');
});

test('native Kubernetes Jobs are suspended, finite and equally bounded', async () => {
  for (const name of ['node', 'rust']) {
    const yaml = await readFile(new URL(`${name}-job.yaml`, import.meta.url), 'utf8');
    for (const fragment of ['suspend: true', 'backoffLimit: 0', 'parallelism: 1', 'activeDeadlineSeconds: 150', 'cpu: "1"', 'memory: "256Mi"', 'readOnly: true', 'name: native-hana-query']) assert.ok(yaml.includes(fragment));
    assert.ok(yaml.includes(`image: sap-polling-${name}:sql`));
    assert.equal(yaml.includes(settings.HANA_PASSWORD), false);
  }
});
