import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { activeSapSources, sapSourceBindingVersion, normalizeViewDefinition, publicSourceFiles, sha256, validateNineReadiness } from './nine-readiness.mjs';
import { prepareNineReadiness } from './prepare-nine-readiness.mjs';

async function fixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), 'nine-readiness-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const write = async (path, value) => { await mkdir(dirname(resolve(root, path)), { recursive: true }); await writeFile(resolve(root, path), typeof value === 'string' ? value : JSON.stringify(value)); };
  for (const directory of ['clients/node', 'clients/rust', 'sap/src', 'sap/setup', 'contracts', 'scripts', 'deploy']) await mkdir(resolve(root, directory), { recursive: true });
  const sourceFiles = [...new Set([...activeSapSources.filter(item => !item.optional || item.name === 'zcl_bl_poll_orders' && item.part !== 'macros').map(item => item.path), 'sap/setup/native-hana-view.sql', 'contracts/fixtures.json', 'contracts/seed-manifest.json', 'contracts/native-hana.sql', 'contracts/abap-cds-odbc.sql', 'clients/node/.dockerignore', 'clients/rust/.dockerignore', 'clients/node/package.json', 'docs/nine-benchmark-protocol.md', 'build-lock.json'])];
  for (const path of sourceFiles) await write(path, 'fixture source\n');
  const expected = { outcome: 'ok', rows: 5000, pages: 51, digest: 'd'.repeat(64), error: null };
  const fixtures = [{ id: 'first', expected }, { id: 'second', expected }];
  await write('contracts/fixtures.json', { cases: fixtures });
  await write('contracts/seed-manifest.json', { expected_rows: 5000, expected_digest: expected.digest });
  await write('sap/src/zcl_bl_poll_orders.clas.testclasses.abap', 'METHODS one FOR TESTING.\nMETHODS two FOR TESTING.\n');
  await write('sap/setup/native-hana-view.sql', '-- lab view\nCREATE VIEW "ZBL_BENCH_SQL"."ORDER_POSITIONS_001" AS\nSELECT * FROM LAB WHERE CLIENT = \'001\';\n');
  const evidence = [];
  const save = async (file, text) => { await write(file, text); evidence.push(file); return { file, sha256: sha256(text) }; };
  const sourceChecks = [];
  for (const item of activeSapSources) {
    const present = sourceFiles.includes(item.path);
    const text = present ? await readFile(resolve(root, item.path), 'utf8') : '* SAP placeholder include\n';
    sourceChecks.push({ id: item.id, name: item.name, part: item.part, kind: item.kind, uri: item.uri, path: item.path, status: 200, local_present: present, source_sha256: present ? sha256(text) : null, ...await save(`work/preflight/${item.id}.active.abap`, text) });
  }
  const fixturesEvidence = await save('work/preflight/fixtures.ndjson', [...fixtures.map(item => ({ id: item.id, passed: true, result: item.expected })), { fixture_count: fixtures.length, passed: fixtures.length }].map(JSON.stringify).join('\n'));
  const unit = { ...await save('work/preflight/unit.xml', '<runResult><testMethod/><testMethod/></runResult>'), methods: 2, source_sha256: sha256(await readFile(resolve(root, 'sap/src/zcl_bl_poll_orders.clas.testclasses.abap'))) };
  const nativeView = { ...await save('work/preflight/view-definition.csv', "SELECT * FROM LAB WHERE CLIENT = '001'"), source_sha256: sha256(await readFile(resolve(root, 'sap/setup/native-hana-view.sql'))) };
  const sapContainer = { image: 'fixture', started_at: '2026-10-24T00:00:00Z', memory_limit: 0, memory_swap_limit: 0, nano_cpus: 0 };
  const preflight = { schema_version: 1, source_binding_version: sapSourceBindingVersion, include_http: false, passed: true, checked_at_utc: '2026-10-24T00:01:00Z', source_checks: sourceChecks, fixtures: fixturesEvidence, unit, native_view: nativeView, sap_container: sapContainer, contract_sha256: sha256(await readFile(resolve(root, 'contracts/fixtures.json'))) };
  await save('work/preflight/preflight.json', JSON.stringify(preflight));
  const appIds = ['node-http', 'node-cds', 'node-native', 'rust-http', 'rust-cds', 'rust-native'];
  const images = Object.fromEntries(appIds.map(app => [app, { tag: `sap-polling-${app.split('-')[0]}:nine-${app.endsWith('http') ? 'http' : 'sql'}`, id: `sha256:${'a'.repeat(64)}`, os: 'linux', architecture: 'amd64' }]));
  const hashes = await Promise.all(sourceFiles.map(async path => ({ path, sha256: sha256(await readFile(resolve(root, path))) })));
  const build = { schema_version: 1, clean_build: true, passed: true, method: 'dockerfile-source-build', source_files: hashes, images };
  await save('work/build/build-receipt.json', JSON.stringify(build));
  const smokeRun = 'results/nine-smoke-fixture';
  const inputs = { source_inputs: hashes, images, sap_container: sapContainer };
  const manifest = { status: 'complete', protocol: 'sap-nine-path-benchmark-smoke-v1', duration_seconds: 3, warmup_scans: 1, started_utc: '2026-10-24T00:02:00Z', inputs_sha256: sha256(JSON.stringify(inputs)), blocks: [] };
  await save(`${smokeRun}/inputs.json`, JSON.stringify(inputs));
  for (const [index, app] of [...appIds, 'abap-http', 'abap-cds', 'abap-native'].entries()) {
    const path = `block-${String(index + 1).padStart(2, '0')}-${app}.json`, rawPath = path.replace('.json', '.ndjson');
    const records = [{ kind: 'scan', phase: 'warmup', ...expected }, { kind: 'scan', phase: 'measured', ...expected }, { kind: 'summary', measured_wall_ms: 3000, measured_scans: 1 }];
    const raw = records.map(JSON.stringify).join('\n');
    const block = { app_id: app, exit_code: 0, timed_out: false, oversized: false, verification: { passed: true }, records, raw_file: rawPath, raw_sha256: sha256(raw) };
    const bytes = JSON.stringify(block);
    await save(`${smokeRun}/${path}`, bytes); await save(`${smokeRun}/${rawPath}`, raw);
    manifest.blocks.push({ app_id: app, passed: true, path, sha256: sha256(bytes) });
  }
  await save(`${smokeRun}/manifest.json`, JSON.stringify(manifest));
  const descriptor = { schema_version: 1, source_files: sourceFiles, evidence_files: evidence, images: Object.fromEntries(appIds.map(app => [app, images[app].tag])), readiness: { ready: true, operator_idle_confirmed: true, sap_preflight: 'work/preflight/preflight.json', build_receipt: 'work/build/build-receipt.json', smoke_run: smokeRun } };
  return { root, write, descriptor, preflight, build, inputs, manifest, smokeRun };
}

test('complete current capture/build/smoke evidence enables all nine paths', async t => {
  const value = await fixture(t), summary = await validateNineReadiness(value.descriptor, { root: value.root });
  assert.equal(summary.shared_fixtures, 2); assert.equal(summary.unit_methods, 2); assert.equal(summary.active_sources, 27);
  const files = await publicSourceFiles(value.root);
  assert(files.includes('clients/node/.dockerignore') && files.includes('sap/setup/native-hana-view.sql') && files.includes('build-lock.json'));
});

test('ready=true cannot substitute for missing view, Unit, fixture or smoke evidence', async t => {
  const value = await fixture(t);
  for (const file of ['work/preflight/view-definition.csv', 'work/preflight/unit.xml', 'work/preflight/fixtures.ndjson', `${value.smokeRun}/inputs.json`]) {
    const descriptor = structuredClone(value.descriptor); descriptor.evidence_files = descriptor.evidence_files.filter(path => path !== file);
    await assert.rejects(validateNineReadiness(descriptor, { root: value.root }), /Required evidence is absent/);
  }
  const descriptor = structuredClone(value.descriptor); delete descriptor.readiness.smoke_run;
  await assert.rejects(validateNineReadiness(descriptor, { root: value.root }), /Fresh smoke evidence/);
});

test('changed build inputs, active sources and driver-facing view definitions fail before timing', async t => {
  const value = await fixture(t);
  await value.write('clients/node/package.json', 'changed');
  await assert.rejects(validateNineReadiness(value.descriptor, { root: value.root }), /Source changed since image build/);
  await value.write('clients/node/package.json', 'fixture source\n');
  await value.write(activeSapSources[0].path, 'changed ABAP');
  await assert.rejects(validateNineReadiness(value.descriptor, { root: value.root }), /Local SAP source changed/);
  assert.notEqual(normalizeViewDefinition("SELECT * FROM LAB WHERE CLIENT = '002'"), normalizeViewDefinition(await readFile(resolve(value.root, 'sap/setup/native-hana-view.sql'), 'utf8')));
});

test('smoke must use clean-built images and include every descriptor source', async t => {
  const value = await fixture(t);
  value.inputs.images['node-http'].id = `sha256:${'b'.repeat(64)}`;
  await value.write(`${value.smokeRun}/inputs.json`, value.inputs);
  value.manifest.inputs_sha256 = sha256(JSON.stringify(value.inputs)); await value.write(`${value.smokeRun}/manifest.json`, value.manifest);
  await assert.rejects(validateNineReadiness(value.descriptor, { root: value.root }), /Smoke image differs/);
});

test('descriptor preparation is disabled until a verified smoke and explicit idle attestation', async t => {
  const value = await fixture(t), options = { preflight: 'work/preflight/preflight.json', buildReceipt: 'work/build/build-receipt.json' };
  const first = await prepareNineReadiness(options, { root: value.root }); assert.equal(first.ready, false);
  const draft = await prepareNineReadiness({ ...options, smokeRun: value.smokeRun }, { root: value.root }); assert.equal(draft.ready, false);
  await assert.rejects(prepareNineReadiness({ ...options, confirmIdle: true }, { root: value.root }), /completed smoke/);
  const final = await prepareNineReadiness({ ...options, smokeRun: value.smokeRun, confirmIdle: true }, { root: value.root }); assert.equal(final.ready, true);
});

test('old six-main-source receipts cannot enable new official readiness', async t => {
  const value = await fixture(t);
  value.preflight.source_checks = value.preflight.source_checks.filter(item => item.part === 'main' && item.name !== 'zcl_bl_test_orders');
  delete value.preflight.source_binding_version;
  await value.write(value.descriptor.readiness.sap_preflight, value.preflight);
  await assert.rejects(validateNineReadiness(value.descriptor, { root: value.root }), /source binding v2/);
});

test('five/six-record and missing-hash receipts fail even when marked as full-source v2', async t => {
  for (const count of [5, 6]) {
    const value = await fixture(t);
    value.preflight.source_checks = value.preflight.source_checks.slice(0, count);
    await value.write(value.descriptor.readiness.sap_preflight, value.preflight);
    await assert.rejects(validateNineReadiness(value.descriptor, { root: value.root }), /27 unique active SAP source parts/);
  }
  const value = await fixture(t);
  delete value.preflight.source_checks[0].sha256;
  await value.write(value.descriptor.readiness.sap_preflight, value.preflight);
  await assert.rejects(validateNineReadiness(value.descriptor, { root: value.root }), /Active SAP source hash is missing/);
});

test('unchanged Unit counts cannot hide inactive test bodies, local clock code or fixture runners', async t => {
  for (const part of ['locals_def', 'locals_imp', 'testclasses', 'fixture-main']) {
    const value = await fixture(t);
    const record = value.preflight.source_checks.find(item => part === 'fixture-main' ? item.name === 'zcl_bl_test_orders' && item.part === 'main' : item.name === 'zcl_bl_poll_orders' && item.part === part);
    const changed = await readFile(resolve(value.root, record.path), 'utf8') + '* local change not activated in SAP\n';
    await value.write(record.path, changed);
    record.source_sha256 = sha256(changed);
    if (part === 'testclasses') value.preflight.unit.source_sha256 = sha256(changed);
    await value.write(value.descriptor.readiness.sap_preflight, value.preflight);
    await assert.rejects(validateNineReadiness(value.descriptor, { root: value.root }), /Active\/current SAP source mismatch/);
  }
});

test('active code in a repository-absent macro/include is rejected even with a valid captured hash', async t => {
  const value = await fixture(t), record = value.preflight.source_checks.find(item => item.name === 'zcl_bl_poll_orders' && item.part === 'macros');
  const injected = 'DEFINE active_only_macro.\nWRITE 1.\nEND-OF-DEFINITION.\n';
  await value.write(record.file, injected); record.sha256 = sha256(injected);
  await value.write(value.descriptor.readiness.sap_preflight, value.preflight);
  await assert.rejects(validateNineReadiness(value.descriptor, { root: value.root }), /Active\/current SAP source mismatch/);
});
