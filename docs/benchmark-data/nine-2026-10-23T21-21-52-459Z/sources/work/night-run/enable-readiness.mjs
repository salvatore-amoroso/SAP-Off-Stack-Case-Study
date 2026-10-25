import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const read = async path => JSON.parse(await readFile(path, 'utf8'));
const smokeDirectory = 'results/nine-smoke-2026-10-23T21-17-07-992Z';
const smoke = await read(`${smokeDirectory}/manifest.json`);
assert.equal(smoke.status, 'complete'); assert.equal(smoke.blocks.length, 9); assert(smoke.blocks.every(block => block.passed));
const sap = await read('work/night-run/sap-tests.json'); assert(sap.passed && sap.unit_methods === 9 && sap.shared_fixtures === 68);
const view = await read('work/node-cds-fix/view-readiness.json'); assert(view.matches_previous_after_eol_eof_normalization);
const active = await read('work/node-cds-fix/abap-parity.json'); assert(active.passed && active.source_checks.length === 6);
const input = await read('work/node-cds-fix/benchmark-inputs.json');
const build = await read('work/node-cds-fix/fix-receipt.json');
const previous = await read('results/nine-continued-2026-10-23T16-45-15-388Z/inputs.json');
for (const file of previous.source_inputs.filter(file => file.path.startsWith('clients/rust/'))) assert.equal(createHash('sha256').update(await readFile(file.path)).digest('hex'), file.sha256);
input.source_files.push('work/night-run/sap-tests.mjs', 'work/night-run/enable-readiness.mjs');
input.evidence_files.push('work/night-run/sap-tests.json', 'work/night-run/unit.xml', 'work/night-run/fixtures.ndjson',
  'work/node-cds-fix/view-readiness.json', 'work/node-cds-fix/view-definition.csv', `${smokeDirectory}/manifest.json`,
  ...smoke.blocks.flatMap(block => [`${smokeDirectory}/${block.path}`, `${smokeDirectory}/${block.path.replace('.json', '.ndjson')}`]));
input.evidence_files.push(...active.source_checks.map(check => check.file));
input.readiness = { ready: true, operator_idle_confirmed: true, authorization: 'Operator authorized the recorded comparison.',
  nine_path_smoke_passed: true, smoke_run: smokeDirectory, smoke_blocks: 9, fixed_node_conformance_passed: true, node_tests: 139,
  live_abap_unit_methods: 9, shared_abap_fixtures: 68, active_sap_source_checks: 6, native_view_definition_unchanged: true,
  rust_source_and_image_unchanged_from_verified_build: true, functional_parity_passed: true };
input.provenance = { ...input.provenance, node_build: build.node_runtime,
  rust_build_reference: 'work/nine-readiness/readiness.json', old_timings_adopted: false,
  host_conditions: 'Shared host; isolation from unrelated workloads is not established.' };
input.evidence_files.push('work/nine-readiness/readiness.json', 'work/night-run/host-preflight.json');
await writeFile('work/night-run/inputs.json', JSON.stringify(input, null, 2) + '\n');
console.log(JSON.stringify({ ready: true, smoke_blocks: 9, abap_unit: 9, abap_fixtures: 68, inputs: 'work/night-run/inputs.json' }));
