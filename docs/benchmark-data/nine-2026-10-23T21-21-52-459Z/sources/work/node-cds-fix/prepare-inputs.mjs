import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { invoke } from '../../deploy/sql/native-runtime.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
const read = async file => JSON.parse(await readFile(file, 'utf8'));
const prior = await read('work/nine-readiness/inputs.json');
const images = { ...prior.images, 'node-http': 'sap-polling-node:nine-fixed-http',
  'node-cds': 'sap-polling-node:nine-fixed-sql', 'node-native': 'sap-polling-node:nine-fixed-sql' };
const imageIds = {};
for (const tag of new Set(Object.values(images))) {
  const result = await invoke('docker', ['image', 'inspect', '--format', '{{.Id}}', tag]);
  assert.equal(result.status, 0); imageIds[tag] = result.stdout.trim();
}
const probe = `const fs=require('node:fs'),crypto=require('node:crypto'); const files=['package.json','package-lock.json','scripts/patch-odbc.mjs',...fs.readdirSync('/app/src').filter(name=>name.endsWith('.mjs')).map(name=>'src/'+name)]; console.log(JSON.stringify({node:process.version,source_sha256:Object.fromEntries(files.map(file=>[file,crypto.createHash('sha256').update(fs.readFileSync('/app/'+file)).digest('hex')]))}));`;
const runtimeResult = await invoke('docker', ['run', '--rm', '--network', 'none', '--entrypoint', 'node', imageIds[images['node-cds']], '-e', probe]);
assert.equal(runtimeResult.status, 0);
const nodeRuntime = JSON.parse(runtimeResult.stdout);
for (const [file, expected] of Object.entries(nodeRuntime.source_sha256)) assert.equal(sha(await readFile(`clients/node/${file}`)), expected, file);
const evidence = ['node-tests.tap', 'cancel-proof.json', 'timeout-proof.json', 'cancel-capabilities.json',
  'live-parity.json', 'abap-parity.json', 'post-fix-host.json'].map(file => `work/node-cds-fix/${file}`);
for (const file of evidence.filter(file => file.endsWith('.json') && !file.endsWith('post-fix-host.json') && !file.endsWith('cancel-capabilities.json'))) assert((await read(file)).passed, file);
assert((await read(evidence[0].replace('node-tests.tap', 'cancel-capabilities.json'))).cancel_function_supported === 1);
const tests = await readFile(evidence[0], 'utf8'); assert.match(tests, /# tests 139/); assert.match(tests, /# fail 0/);
const changedSources = ['clients/node/scripts/patch-odbc.mjs', 'clients/node/test/odbc-patch.test.mjs',
  'scripts/run-nine-comparison.mjs', 'scripts/run-nine-comparison.test.mjs', 'scripts/analyze-nine-comparison.mjs',
  'docs/node-cds-block26-investigation.md', 'docs/nine-benchmark-protocol.md'];
const receipt = { schema_version: 1, prepared_at_utc: new Date().toISOString(),
  status: 'prepared_awaiting_operator_idle_and_fresh_smoke', official_measurements_started: false,
  images: imageIds, node_runtime: nodeRuntime, node_tests: { passed: true, count: 139, failed: 0 }, controller_tests: { passed: true, count: 12 },
  analyzer_self_test: { passed: true, synthetic_results_excluded: true },
  source_sha256: Object.fromEntries(await Promise.all(changedSources.map(async file => [file, sha(await readFile(file))]))),
  evidence_sha256: Object.fromEntries(await Promise.all(evidence.map(async file => [file, sha(await readFile(file))]))),
  build: 'New Node images extend the preserved cached runtime. The native ODBC addon was rebuilt offline after applying cursor registration; SAP driver files remain external. Historical image tags are unchanged.',
  historical_comparison: 'results/nine-continued-2026-10-23T16-45-15-388Z',
  next_steps: ['Wait for explicit operator idle confirmation', 'Refresh host/source/view checks and run all nine smoke paths',
    'Write fresh readiness evidence and enable readiness.ready only if every gate passes',
    'Run all 27 blocks with this prepared input, retaining any failure and no retries',
    'Validate, analyze and plot all nine paths locally; preserve the old comparison separately'],
  benchmark_configuration: { rows_per_scan: 5000, warmup_scans: 5, measured_seconds: 180, rounds: 3,
    minimum_free_host_memory_bytes: 2147483648, old_timings_adopted: false } };
await writeFile('work/node-cds-fix/fix-receipt.json', JSON.stringify(receipt, null, 2) + '\n');
const diagnosticSources = ['Dockerfile', 'Dockerfile.http', 'cancel-shim.cpp', 'probe-cursor.mjs', 'probe-poller-timeout.mjs',
  'run-cancel-proof.mjs', 'run-timeout-proof.mjs', 'run-cancel-capabilities.mjs', 'cancel-capabilities.cpp',
  'session-parity.mjs', 'verify-live.mjs', 'verify-abap.mjs', 'prepare-inputs.mjs'].map(file => `work/node-cds-fix/${file}`);
const prepared = { schema_version: 1, images, source_files: [...new Set([...prior.source_files, ...changedSources, ...diagnosticSources])],
  evidence_files: [...evidence, 'work/node-cds-fix/fix-receipt.json'],
  readiness: { ready: false, operator_idle_confirmed: false, fresh_nine_path_smoke_passed: false,
    fixed_node_conformance_passed: true, functional_parity_passed: true,
    reason: 'Official measurement requires operator confirmation and fresh readiness checks.' },
  provenance: { fix_receipt: 'work/node-cds-fix/fix-receipt.json', image_ids_at_preparation: imageIds,
    previous_run: receipt.historical_comparison, fresh_run_required: true,
    reason: 'Native addon changed. Do not combine old and new timing samples.' } };
await writeFile('work/node-cds-fix/benchmark-inputs.json', JSON.stringify(prepared, null, 2) + '\n');
console.log(JSON.stringify({ prepared: true, official_measurements_started: false, readiness: prepared.readiness,
  inputs: 'work/node-cds-fix/benchmark-inputs.json', receipt: 'work/node-cds-fix/fix-receipt.json', images: imageIds }));
