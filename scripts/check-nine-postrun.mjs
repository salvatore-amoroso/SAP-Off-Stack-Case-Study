import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { sapSettings, sapGet } from './sap-runtime.mjs';
import { invoke, projectRoot, loadRuntime } from '../deploy/sql/native-runtime.mjs';
import { loadOdbcRuntime } from '../deploy/sql/odbc-runtime.mjs';
import { sapSourceSpecs, sapSourceBindingVersion, projectFile, assertSapSourceMatches } from './nine-readiness.mjs';

export function postrunSourceSpecs(preflight) {
  if (preflight?.source_binding_version === sapSourceBindingVersion) {
    assert.equal(typeof preflight.include_http, 'boolean', 'Full-source preflight must identify its HTTP-test scope');
    return sapSourceSpecs({ includeHttp: preflight.include_http });
  }
  assert(preflight?.source_binding_version === undefined || preflight.source_binding_version === 1, 'Unsupported SAP source-binding version');
  // Historical archives declared only four main classes and two DDL definitions.
  return sapSourceSpecs().filter(source => source.part === 'main' && source.name !== 'zcl_bl_test_orders');
}
export async function writeMatchingFile(path, bytes) {
  const expected = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  try { await writeFile(path, expected, { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    assert((await readFile(path)).equals(expected), 'Existing post-run evidence differs; preserve it rather than overwriting');
  }
}
export async function savePostrunProof(path, proof) {
  let previous;
  try { previous = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous) {
    const withoutTimestamp = ({ checked_at_utc, ...value }) => value;
    assert(Number.isFinite(Date.parse(previous.checked_at_utc)) && isDeepStrictEqual(withoutTimestamp(previous), withoutTimestamp(proof)), 'Existing post-run proof differs; it will not be overwritten');
    return previous;
  }
  await writeMatchingFile(path, JSON.stringify(proof, null, 2) + '\n');
  return proof;
}

export async function checkNinePostrun(archive) {
const directory = resolve(projectRoot, archive || '');
assert(directory.startsWith(resolve(projectRoot, 'docs/benchmark-data') + sep), 'Select an archive under docs/benchmark-data');
const inputs = JSON.parse(await readFile(resolve(directory, 'inputs.json')));
const previous = inputs.evidence_files.find(item => item.path.endsWith('/view-definition.csv'));
assert(previous, 'Archive lacks preflight view-definition.csv; validate complete readiness before a new official run');
const previousView = await readFile(resolve(directory, previous.snapshot), 'utf8');
const settings = sapSettings(); assert(settings.local && settings.client === '001');
const normalize = value => value.replaceAll('\r\n', '\n').trimEnd() + '\n';
const hash = value => createHash('sha256').update(value).digest('hex');
const preflightEntry = inputs.evidence_files.find(item => item.path === inputs.readiness?.sap_preflight);
const preflightBytes = preflightEntry ? await readFile(await projectFile(directory, preflightEntry.snapshot)) : null;
if (preflightEntry) assert.equal(hash(preflightBytes), preflightEntry.sha256, 'Archived SAP preflight hash differs');
const preflight = preflightBytes ? JSON.parse(preflightBytes) : null;
const completeSourceBinding = preflight?.source_binding_version === sapSourceBindingVersion;
const sourceSpecs = postrunSourceSpecs(preflight);
if (completeSourceBinding) assert(Array.isArray(preflight.source_checks) && preflight.source_checks.length === sourceSpecs.length && new Set(preflight.source_checks.map(item => item.id)).size === sourceSpecs.length, 'Complete preflight source records are required');
assert.equal(hash(settings.username), inputs.topology.sap_identity_sha256, 'SAP identity changed');
const nativeRuntime = await loadRuntime();
assert.equal(hash(nativeRuntime.settings.HANA_USER), inputs.topology.hana_identity_sha256, 'Native HANA identity changed');
assert.equal(nativeRuntime.settings.HANA_SERVER, inputs.topology.native_server);
const post = resolve(directory, 'postrun'); await mkdir(post, { recursive: true });
const checks = [];
for (const source of sourceSpecs) {
    const response = await sapGet(new URL(`${source.uri}?sap-client=001&version=active`, settings.serviceRoot), settings, { insecureLocal: true, accept: 'text/plain' });
    assert.equal(response.status, 200); assert(!response.body.includes(settings.password));
    const entry = inputs.source_inputs.find(item => item.path === source.path);
    if (completeSourceBinding) {
      const before = preflight.source_checks.find(item => item.id === source.id);
      assert(before && before.uri === source.uri && before.path === source.path && before.status === 200, `Missing or misidentified preflight source: ${source.id}`);
      const captured = inputs.evidence_files.find(item => item.path === before.file); assert(captured, 'Preflight active-source snapshot is missing');
      const capturedBytes = await readFile(await projectFile(directory, captured.snapshot));
      assert.equal(hash(capturedBytes), before.sha256, 'Preflight active source hash differs');
      assert(normalize(response.body) === normalize(capturedBytes.toString('utf8')), `Active SAP source changed: ${source.id}`);
      if (before.local_present) {
        assert(entry, `Archived local source is missing: ${source.path}`);
        const local = await readFile(await projectFile(directory, entry.snapshot));
        assert.equal(hash(local), before.source_sha256, 'Archived local SAP source differs from preflight');
        assertSapSourceMatches(source, response.body, local);
      } else {
        assert.equal(before.local_present, false); assert.equal(before.source_sha256, null); assert(!entry, 'An absent preflight include now has an archived source');
        assertSapSourceMatches(source, response.body, null);
      }
    } else {
      assert(entry); assert(normalize(response.body) === normalize(await readFile(await projectFile(directory, entry.snapshot), 'utf8')), source.name);
    }
    const file = `postrun/${completeSourceBinding ? source.id : source.name}.abap`; await writeMatchingFile(resolve(directory, file), response.body);
    checks.push({ name: source.name, ...(completeSourceBinding ? { id: source.id, part: source.part, path: source.path, uri: source.uri } : {}), file, sha256: hash(response.body), matches_archived_preflight_source: true });
}
const sql = "SELECT BINTOHEX(TO_BINARY(TO_NVARCHAR(DEFINITION))) FROM SYS.VIEWS WHERE SCHEMA_NAME='ZBL_BENCH_SQL' AND VIEW_NAME='ORDER_POSITIONS_001';";
const script = `set -eu\numask 077\nsql_file="$(mktemp /tmp/zbl-postrun-XXXXXX.sql)"\ntrap 'rm -f -- "$sql_file"' EXIT\ncat > "$sql_file" <<'ZBL_SQL'\n${sql}\nZBL_SQL\n/usr/sap/HDB/HDB02/exe/hdbsql -U DEFAULT -a -x -I "$sql_file"\n`;
const metadata = await invoke('docker', ['exec', '--interactive', '--user', 'a4hadm', 'a4h', '/bin/bash'], { input: script, timeout: 30000 });
assert.equal(metadata.status, 0, 'Post-run native view metadata query failed');
const encoded = metadata.stdout.split(/\r?\n/).map(line => line.trim()).find(line => /^"?[0-9a-f]+"?$/i.test(line)); assert(encoded);
const definition = Buffer.from(encoded.replaceAll('"', ''), 'hex').toString('utf8');
assert.equal(normalize(definition), normalize(previousView));
await writeMatchingFile(resolve(post, 'view-definition.csv'), definition);
const runtime = await loadOdbcRuntime(); assert(isDeepStrictEqual(runtime.driver_files, inputs.driver_files));
const container = await invoke('docker', ['inspect', '--format', '{"image":{{json .Config.Image}},"memory_limit":{{json .HostConfig.Memory}},"memory_swap_limit":{{json .HostConfig.MemorySwap}},"nano_cpus":{{json .HostConfig.NanoCpus}},"started_at":{{json .State.StartedAt}}}', 'a4h']);
assert.equal(container.status, 0); const current = JSON.parse(container.stdout); assert(isDeepStrictEqual(current, inputs.sap_container));
const proof = { checked_at_utc: new Date().toISOString(), passed: true, archive: relative(projectRoot, directory).split(sep).join('/'), source_checks: checks,
  ...(completeSourceBinding ? { source_binding_version: sapSourceBindingVersion } : {}),
  native_view: { file: 'postrun/view-definition.csv', sha256: hash(definition), matches_preflight: true },
  sap_container_unchanged: true, sap_container: current, driver_files_unchanged: true, configured_identities_unchanged: true,
  script_sha256: hash(await readFile(import.meta.filename)),
  scope: completeSourceBinding ? 'Read-only complete SAP source-part binding v2 after measurement, including absent/comment-only includes and test/fixture sources; no SAP changes.' : 'Read-only checks after all 27 measurement windows and before graceful shutdown. Sources compare after EOL/EOF normalization; no SAP data, source or configuration was changed.' };
const saved = await savePostrunProof(resolve(post, 'proof.json'), proof);
await writeFile(resolve(projectRoot, 'docs/nine-postrun-proof.json'), JSON.stringify(saved, null, 2) + '\n');
return { passed: true, active_sources: checks.length, source_binding_version: completeSourceBinding ? sapSourceBindingVersion : 1, native_view_unchanged: true, sap_start_and_allocation_unchanged: true, driver_files_unchanged: true };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert(process.argv.length === 3, 'Usage: node scripts/check-nine-postrun.mjs docs/benchmark-data/NEW-ARCHIVE');
  checkNinePostrun(process.argv[2]).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(JSON.stringify({ passed: false, error: error.message })); process.exitCode = 1; });
}
