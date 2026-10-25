import { readFile, readdir, realpath, access } from 'node:fs/promises';
import { resolve, relative, sep, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { projectRoot } from './sap-runtime.mjs';
import { parseCaseResults, unitMethodCount } from './abap-results.mjs';

export const sapSourceBindingVersion = 2;
const classParts = [
  ['main', 'source/main', ''], ['locals_def', 'includes/definitions', '.locals_def'],
  ['locals_imp', 'includes/implementations', '.locals_imp'], ['macros', 'includes/macros', '.macros'],
  ['testclasses', 'includes/testclasses', '.testclasses'],
];
export function sapSourceSpecs({ includeHttp = false } = {}) {
  const classes = ['zcl_bl_poll_orders', 'zcl_bl_bench_orders', 'zcl_bl_bench_cds', 'zcl_bl_bench_native', 'zcl_bl_test_orders', ...(includeHttp ? ['zcl_bl_test_http'] : [])];
  return [
    ...classes.flatMap(name => classParts.map(([part, uri, suffix]) => ({ id: `${name}.${part}`, name, kind: 'class', part,
      path: `sap/src/${name}.clas${suffix}.abap`, uri: `/sap/bc/adt/oo/classes/${name}/${uri}`, optional: part !== 'main' }))),
    ...['zi_bl_orderheader', 'zi_bl_orderposition'].map(name => ({ id: `${name}.main`, name, kind: 'ddl', part: 'main', path: `sap/src/${name}.ddls.asddls`, uri: `/sap/bc/adt/ddic/ddl/sources/${name}/source/main`, optional: false })),
  ];
}
export const activeSapSources = sapSourceSpecs();
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const normalizeSource = value => value.replaceAll('\r\n', '\n').trimEnd() + '\n';
export function normalizeViewDefinition(value) {
  return value.replace(/^\s*--[^\n]*$/gm, '').replace(/^\s*CREATE\s+VIEW\s+"ZBL_BENCH_SQL"\."ORDER_POSITIONS_001"\s+AS\s+/i, '').trim().replace(/;\s*$/, '').replace(/\s+/g, ' ');
}
export const projectRelative = (root, path) => relative(root, path).split(sep).join('/');
const check = (condition, message) => { if (!condition) throw new Error(`NINE_READINESS: ${message}`); };
export const commentOnlyAbap = text => text.split(/\r?\n/).every(line => !line.trim() || line.startsWith('*') || line.trimStart().startsWith('"'));

export async function localSapSource(root, source) {
  try { return await readFile(await projectFile(root, source.path)); }
  catch (error) { if (source.optional && error.code === 'ENOENT') return null; throw error; }
}

export function assertSapSourceMatches(source, active, local) {
  check(local !== null || source.optional, `Required local SAP source is absent: ${source.path}`);
  check(local === null ? commentOnlyAbap(active) : normalizeSource(active) === normalizeSource(local.toString('utf8')), `Active/current SAP source mismatch: ${source.id}`);
}

export async function validateSapSourceEvidence(preflight, { root, sourceFiles, evidenceFile }) {
  check(preflight.source_binding_version === sapSourceBindingVersion && typeof preflight.include_http === 'boolean', 'Complete active SAP source binding v2 is required; recapture readiness');
  const specs = sapSourceSpecs({ includeHttp: preflight.include_http });
  check(Array.isArray(preflight.source_checks) && preflight.source_checks.length === specs.length && new Set(preflight.source_checks.map(item => item.id)).size === specs.length, `${specs.length} unique active SAP source parts are required`);
  for (const source of specs) {
    const receipt = preflight.source_checks.find(item => item.id === source.id);
    check(receipt && receipt.path === source.path && receipt.name === source.name && receipt.part === source.part && receipt.kind === source.kind && receipt.uri === source.uri && receipt.status === 200, `Active SAP source record is missing or misidentified: ${source.id}`);
    check(/^[a-f0-9]{64}$/.test(receipt.sha256), `Active SAP source hash is missing: ${source.id}`);
    const active = await evidenceFile(receipt.file, receipt.sha256), local = await localSapSource(root, source);
    check(receipt.local_present === (local !== null) && receipt.source_sha256 === (local === null ? null : sha256(local)), `Local SAP source changed since preflight: ${source.id}`);
    if (local !== null) check(sourceFiles.includes(source.path), `SAP source is absent from descriptor: ${source.path}`);
    assertSapSourceMatches(source, active.toString('utf8'), local);
  }
  return specs;
}

export async function projectFile(root, path) {
  check(typeof path === 'string' && path && !isAbsolute(path) && !path.split(/[\\/]/).includes('..'), 'Evidence must use a project-relative path');
  const base = await realpath(root), file = await realpath(resolve(root, path));
  const child = relative(base, file);
  check(child && !isAbsolute(child) && !child.split(/[\\/]/).includes('..'), 'Evidence leaves the project through a link');
  return file;
}

export async function publicSourceFiles(root = projectRoot) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
      if (['node_modules', 'target', '.git'].includes(entry.name)) continue;
      const path = `${directory}/${entry.name}`;
      check(!entry.isSymbolicLink(), 'Public sources must not contain symbolic links');
      if (entry.isDirectory()) await visit(path);
      else if (/\.(?:mjs|rs|json|toml|lock|xml|abap|asddls|baseinfo|srvdsrv|sql|yaml|py|ps1|md|tsv)$|(?:^|\/)Dockerfile(?:\.[^/]+)?$|(?:^|\/)\.dockerignore$/.test(path)) files.push(path);
    }
  }
  for (const directory of ['clients/node', 'clients/rust', 'sap/src', 'sap/setup', 'contracts', 'scripts', 'deploy']) await visit(directory);
  for (const path of ['build-lock.json', '.env.example', 'package.json', 'package-lock.json', '.node-version', 'rust-toolchain.toml']) {
    try { await access(resolve(root, path)); files.push(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return [...new Set([...files, 'docs/nine-benchmark-protocol.md'])].sort();
}

// Filesystem-only gate: importing this module never contacts SAP or Docker.
export async function validateNineReadiness(descriptor, { root = projectRoot, requireReady = true } = {}) {
  check(descriptor?.schema_version === 1 && descriptor.readiness, 'Descriptor schema/readiness is missing');
  if (requireReady) check(descriptor.readiness.ready === true && descriptor.readiness.operator_idle_confirmed === true, 'Official measurement requires ready=true and an idle-host attestation');
  const sources = descriptor.source_files, evidence = descriptor.evidence_files;
  check(Array.isArray(sources) && Array.isArray(evidence), 'Source and evidence file lists are required');
  check(new Set(sources).size === sources.length && new Set(evidence).size === evidence.length, 'File lists contain duplicates');
  const read = async path => readFile(await projectFile(root, path));
  const json = async path => JSON.parse((await read(path)).toString('utf8').replace(/^\uFEFF/, ''));
  const evidenceFile = async (path, expectedHash) => {
    check(evidence.includes(path), `Required evidence is absent from evidence_files: ${path}`);
    const bytes = await read(path);
    if (expectedHash) check(sha256(bytes) === expectedHash, `Evidence changed: ${path}`);
    return bytes;
  };
  const required = [...activeSapSources.filter(item => !item.optional).map(item => item.path), 'sap/src/zcl_bl_poll_orders.clas.testclasses.abap', 'sap/setup/native-hana-view.sql', 'contracts/fixtures.json', 'contracts/seed-manifest.json', 'contracts/native-hana.sql', 'contracts/abap-cds-odbc.sql', 'clients/node/.dockerignore', 'clients/rust/.dockerignore'];
  for (const path of required) check(sources.includes(path), `Required source is absent: ${path}`);
  for (const path of sources) await projectFile(root, path);
  const seed = await json('contracts/seed-manifest.json'), fixtures = (await json('contracts/fixtures.json')).cases;
  check(seed.expected_rows === 5000 && Array.isArray(fixtures) && fixtures.length > 0, 'Frozen seed/fixtures are missing');

  const preflightPath = descriptor.readiness.sap_preflight;
  const preflight = JSON.parse((await evidenceFile(preflightPath)).toString('utf8'));
  check(preflight.schema_version === 1 && preflight.passed === true && Number.isFinite(Date.parse(preflight.checked_at_utc)), 'SAP preflight did not pass');
  check(preflight.contract_sha256 === sha256(await read('contracts/fixtures.json')), 'Fixture contract changed since SAP preflight');
  const sourceSpecs = await validateSapSourceEvidence(preflight, { root, sourceFiles: sources, evidenceFile });
  check(preflight.fixtures?.file?.endsWith('/fixtures.ndjson'), 'Raw fixtures.ndjson evidence is required');
  const captured = parseCaseResults((await evidenceFile(preflight.fixtures.file, preflight.fixtures.sha256)).toString('utf8'), { requireSummary: true });
  check(captured.cases.length === fixtures.length, 'SAP fixture count differs from the current contract');
  const functional = ({ outcome, rows, pages, digest, error }) => ({ outcome, rows, pages, digest, error });
  for (const fixture of fixtures) {
    const actual = captured.cases.find(item => item.id === fixture.id);
    check(actual?.passed === true && isDeepStrictEqual(functional(actual.result), fixture.expected), `SAP fixture failed or changed: ${fixture.id}`);
  }
  check(preflight.unit?.file?.endsWith('/unit.xml'), 'Raw Unit unit.xml evidence is required');
  const methods = unitMethodCount((await evidenceFile(preflight.unit.file, preflight.unit.sha256)).toString('utf8'));
  const unitSource = await read('sap/src/zcl_bl_poll_orders.clas.testclasses.abap');
  check(methods === (unitSource.toString('utf8').match(/\bMETHODS\s+\w+\s+FOR\s+TESTING\b/gi) || []).length && preflight.unit.methods === methods && preflight.unit.source_sha256 === sha256(unitSource), 'ABAP Unit methods/source differ from preflight');
  check(preflight.native_view?.file?.endsWith('/view-definition.csv'), 'Native view-definition.csv evidence is required');
  const view = await evidenceFile(preflight.native_view.file, preflight.native_view.sha256), viewSource = await read('sap/setup/native-hana-view.sql');
  check(preflight.native_view.source_sha256 === sha256(viewSource) && normalizeViewDefinition(view.toString('utf8')) === normalizeViewDefinition(viewSource.toString('utf8')), 'Native view differs from its checked-in definition');

  const buildPath = descriptor.readiness.build_receipt;
  const build = JSON.parse((await evidenceFile(buildPath)).toString('utf8'));
  check(build.schema_version === 1 && build.passed === true && build.clean_build === true && build.method === 'dockerfile-source-build', 'A passing clean Dockerfile source-build receipt is required');
  check(Array.isArray(build.source_files) && build.source_files.length > 0, 'Build source hashes are missing');
  for (const item of build.source_files) {
    check(sources.includes(item.path), `Build input is absent from descriptor sources: ${item.path}`);
    check(sha256(await read(item.path)) === item.sha256, `Source changed since image build: ${item.path}`);
  }
  const appIds = ['node-http', 'node-cds', 'node-native', 'rust-http', 'rust-cds', 'rust-native'];
  for (const appId of appIds) {
    const image = build.images?.[appId];
    check(image && image.tag === descriptor.images?.[appId] && /^sha256:[a-f0-9]{64}$/.test(image.id) && image.os === 'linux' && image.architecture === 'amd64', `Build image receipt differs: ${appId}`);
  }

  let smokeInputs;
  const smokeRun = descriptor.readiness.smoke_run;
  if (smokeRun) {
    check(typeof smokeRun === 'string' && /^results\/nine-smoke-[^/]+$/.test(smokeRun), 'A project-relative fresh smoke run is required');
    const manifestBytes = await evidenceFile(`${smokeRun}/manifest.json`), manifest = JSON.parse(manifestBytes);
    const inputBytes = await evidenceFile(`${smokeRun}/inputs.json`); smokeInputs = JSON.parse(inputBytes);
    check(manifest.status === 'complete' && manifest.protocol === 'sap-nine-path-benchmark-smoke-v1' && manifest.duration_seconds === 3 && manifest.warmup_scans === 1 && Array.isArray(manifest.blocks) && manifest.blocks.length === 9, 'Nine completed smoke blocks are required');
    check(sha256(inputBytes) === manifest.inputs_sha256, 'Smoke input hash differs');
    check(Date.parse(manifest.started_utc) >= Date.parse(preflight.checked_at_utc), 'Smoke predates SAP preflight');
    check(isDeepStrictEqual(smokeInputs.sap_container, preflight.sap_container), 'SAP restarted or its allocation changed after preflight');
    for (const source of sources) {
      const saved = smokeInputs.source_inputs?.find(item => item.path === source);
      check(saved && saved.sha256 === sha256(await read(source)), `Source changed or was omitted from smoke: ${source}`);
    }
    for (const appId of appIds) check(smokeInputs.images?.[appId]?.id === build.images[appId].id && smokeInputs.images[appId].tag === build.images[appId].tag, `Smoke image differs from clean build: ${appId}`);
    const allApps = [...appIds, 'abap-http', 'abap-cds', 'abap-native'];
    check(new Set(manifest.blocks.map(item => item.app_id)).size === 9 && manifest.blocks.every(item => allApps.includes(item.app_id) && item.passed === true), 'Smoke application identities or results differ');
    for (const entry of manifest.blocks) {
      check(typeof entry.path === 'string' && /^block-\d\d-(?:node|rust|abap)-(?:http|cds|native)\.json$/.test(entry.path), 'Unexpected smoke block path');
      const bytes = await evidenceFile(`${smokeRun}/${entry.path}`, entry.sha256), block = JSON.parse(bytes);
      const rawPath = entry.path.replace(/\.json$/, '.ndjson'), raw = await evidenceFile(`${smokeRun}/${rawPath}`, block.raw_sha256);
      check(block.raw_file === rawPath && block.app_id === entry.app_id && block.exit_code === 0 && !block.timed_out && !block.oversized && block.verification?.passed === true, `Smoke process failed: ${entry.app_id}`);
      const records = raw.toString('utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
      check(isDeepStrictEqual(records, block.records), `Smoke raw records differ: ${entry.app_id}`);
      const scans = records.filter(item => item.kind === 'scan'), summary = records.at(-1);
      check(records.length === scans.length + 1 && scans.filter(item => item.phase === 'warmup').length === 1 && scans.filter(item => item.phase === 'measured').length > 0 && summary.kind === 'summary' && summary.measured_wall_ms >= 3000 && summary.measured_scans === scans.length - 1, `Smoke sequence is incomplete: ${entry.app_id}`);
      check(scans.every(item => item.outcome === 'ok' && item.error === null && item.rows === seed.expected_rows && item.digest === seed.expected_digest), `Smoke data mismatch: ${entry.app_id}`);
    }
  } else if (requireReady) check(false, 'Fresh smoke evidence is required before official measurement');
  return { passed: true, shared_fixtures: fixtures.length, unit_methods: methods, active_sources: sourceSpecs.length, source_binding_version: sapSourceBindingVersion, build_receipt: buildPath, smoke_run: smokeRun || null, images: build.images, sap_container: smokeInputs?.sap_container || preflight.sap_container,
    driver_files: smokeInputs?.driver_files || null, topology: smokeInputs?.topology || null };
}
