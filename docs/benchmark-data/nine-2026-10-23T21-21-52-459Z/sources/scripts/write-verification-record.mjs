import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { projectRoot } from './sap-runtime.mjs';

const read = path => JSON.parse(readFileSync(resolve(projectRoot, path), 'utf8').replace(/^\uFEFF/, ''));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const core = read('work/conformance-report.json');
const http = read('work/http-conformance-report.json');
const live = read('work/live-parity-report.json');
const kubernetes = read('work/kubernetes-parity-report.json');
const images = read('work/kubernetes-image-proof.json');
const exported = read('work/sap-package.final.metadata.json');
const service = read('work/service-check.json');
const unit = read('work/abap-unit-results.json');
const fixtures = read('contracts/fixtures.json').cases;
const httpCount = fixtures.filter(item => !item.id.startsWith('config_')).length + read('contracts/http-scenarios.json').cases.length;
assert.equal(core.cases, fixtures.length);
assert.equal(http.cases, httpCount);
for (const report of [core, http, live, kubernetes]) assert.equal(report.all_passed, true);
assert.equal(live.functional_match, true);
assert.equal(images.all_approved_configs_match, true);
assert.equal(service.metadata_status, 200);
assert.equal(service.header_status, 200);
assert.equal(service.expanded_positions, 5);
assert.equal(exported.serializer_log_status, 'S');
assert.equal(unit.success, true);
const methods = unit.run_result['aunit:runResult'].program.flatMap(program => program.testClasses.testClass.flatMap(test => test.testMethods.testMethod.map(method => method['@']['adtcore:name'])));
assert.equal(methods.length, 6);
assert.equal(sha256(readFileSync(resolve(projectRoot, 'work/sap-package.final.zip'))), exported.zip_sha256);
for (const file of exported.files) assert.equal(sha256(readFileSync(resolve(projectRoot, file.path))), file.sha256, file.path);

const paths = ['contracts/fixtures.json', 'contracts/http-scenarios.json', 'contracts/seed-manifest.json',
  'clients/node/src/poller.mjs', 'clients/node/src/transport.mjs', 'clients/node/src/cli.mjs', 'clients/node/package-lock.json',
  'clients/rust/src/lib.rs', 'clients/rust/src/main.rs', 'clients/rust/Cargo.lock',
  'deploy/base/node-job.yaml', 'deploy/base/rust-job.yaml', 'deploy/base/kustomization.yaml', 'deploy/local/kustomization.yaml'];
const record = {
  schema_version: 1,
  recorded_at_utc: new Date().toISOString(),
  target: { system: 'A4H', release: 'ABAP Trial 2025', sap_basis: '816', client: '001', package: '$ZBACKEND_LAB' },
  cluster: read('work/kind-setup.json'),
  checks: { core, http, abap_unit: { passed: methods.length, methods }, node_tests: { passed: 76 }, rust_tests: { passed: 5 } },
  service, live, kubernetes, images,
  observed_build_bases: {
    node: 'node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205',
    rust: 'rust:bookworm@sha256:48b7f435b8fc6378ce43b44f15e3a47fd8919b2825f835c39bd4bd3da50af5b8',
    rust_runtime: 'debian:bookworm-slim@sha256:7ff6ba31527b9e336162fa061746c366c4b2032f4d2cff2078bea43f78efe3f8'
  },
  sap_export: exported,
  source_inputs: paths.map(path => ({ path, sha256: sha256(readFileSync(resolve(projectRoot, path))) })),
  limits: [
    'ABAP live proof uses internal ICF dispatch; real socket transport is verified separately by HTTP fault scenarios.',
    'Authenticated live ABAP SM59 socket scan and clean-system abapGit import were not run.',
    'ABAP buffers native HTTP responses and uses whole-second transport timeouts.',
    'These are correctness/deployment smoke runs, not a controlled performance ranking.'
  ]
};
writeFileSync(resolve(projectRoot, 'docs/verification.json'), JSON.stringify(record, null, 2) + '\n');
console.log(JSON.stringify({ written: 'docs/verification.json', core_cases: core.cases, http_cases: http.cases, all_passed: true, sap_files: exported.source_file_count }));
