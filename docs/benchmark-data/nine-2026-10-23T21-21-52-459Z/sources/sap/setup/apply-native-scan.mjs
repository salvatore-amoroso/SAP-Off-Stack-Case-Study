import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const setup = dirname(fileURLToPath(import.meta.url));
const sourcePath = resolve(setup, '../src/zcl_bl_poll_orders.clas.abap');
const hash = value => createHash('sha256').update(value).digest('hex');
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const expected = args.find(value => value.startsWith('--expect-source-sha256='))?.split('=')[1];
if (args.some(value => value !== '--apply' && !/^--expect-source-sha256=[0-9a-f]{64}$/.test(value))) {
  throw new Error('USAGE: apply-native-scan.mjs [--apply --expect-source-sha256=<dry-run hash>]');
}
if (apply && !expected) throw new Error('APPLY_REQUIRES_DRY_RUN_SOURCE_HASH');

const baseline = readFileSync(sourcePath, 'utf8');
const sourceHash = hash(baseline);
if (expected && expected !== sourceHash) throw new Error('BASELINE_CHANGED_RUN_DRY_RUN_AGAIN');
if (/\b(?:METHODS|METHOD)\s+scan_native\b/i.test(baseline)) throw new Error('SCAN_NATIVE_ALREADY_PRESENT');
const newline = baseline.includes('\r\n') ? '\r\n' : '\n';
const fragment = name => readFileSync(resolve(setup, name), 'utf8').trimEnd().replace(/\r?\n/g, newline) + newline;
const definition = fragment('native-scan-definition.abap');
const implementation = fragment('native-scan-implementation.abap');
if (!/^    METHODS scan_native\b/.test(definition) || !/^  METHOD scan_native\./.test(implementation)) {
  throw new Error('UNEXPECTED_NATIVE_FRAGMENTS');
}
const queryCall = implementation.match(/cursor = statement->execute_query\(\s*([\s\S]*?)\s*\)\./i)?.[1];
if (!queryCall || queryCall.replace(/`[^`]*`/g, '').replace(/&&|\s/g, '') !== '') {
  throw new Error('EXPECTED_LITERAL_NATIVE_QUERY');
}
const query = [...queryCall.matchAll(/`([^`]*)`/g)].map(match => match[1]).join('');
const normalizeSql = sql => sql.replace(/\s+/g, ' ').trim();
const sharedQuery = readFileSync(resolve(setup, '../../contracts/native-hana.sql'), 'utf8');
if (normalizeSql(query) !== normalizeSql(sharedQuery)) throw new Error('SHARED_NATIVE_QUERY_MISMATCH');
const privateMarker = '  PRIVATE SECTION.';
const implementationMarker = 'CLASS zcl_bl_poll_orders IMPLEMENTATION.';
const declarationAt = baseline.indexOf(privateMarker);
const implementationAt = baseline.lastIndexOf('ENDCLASS.');
if (declarationAt < 0 || declarationAt !== baseline.lastIndexOf(privateMarker)
  || baseline.indexOf(implementationMarker) <= declarationAt
  || implementationAt <= baseline.indexOf(implementationMarker)) {
  throw new Error('UNEXPECTED_POLLER_LAYOUT');
}
const candidate = baseline.slice(0, declarationAt) + definition
  + baseline.slice(declarationAt, implementationAt) + implementation + baseline.slice(implementationAt);
if (candidate.replace(definition, '').replace(implementation, '') !== baseline) throw new Error('INSERTIONS_ONLY_GUARD_FAILED');

function methodHashes(source) {
  const methods = new Map();
  for (const match of source.matchAll(/^  METHOD ([a-z0-9_]+)\.\r?\n[\s\S]*?^  ENDMETHOD\./gim)) {
    const name = match[1].toLowerCase();
    if (methods.has(name)) throw new Error('DUPLICATE_METHOD_' + name);
    methods.set(name, hash(match[0]));
  }
  return methods;
}
const before = methodHashes(baseline);
const after = methodHashes(candidate);
if (!before.has('validate_values') || !before.has('scan_cds')) throw new Error('REQUIRED_SHARED_METHOD_MISSING');
if (after.size !== before.size + 1 || !after.has('scan_native')) throw new Error('EXPECTED_ONE_NEW_METHOD');
for (const [name, digest] of before) {
  if (after.get(name) !== digest) throw new Error('EXISTING_METHOD_CHANGED_' + name);
}
// Re-read immediately before the single write so an intervening edit cannot be overwritten.
if (apply) {
  if (hash(readFileSync(sourcePath)) !== sourceHash) throw new Error('BASELINE_CHANGED_BEFORE_WRITE');
  writeFileSync(sourcePath, candidate, 'utf8');
}
console.log(JSON.stringify({
  outcome: apply ? 'applied' : 'dry_run', source_path: sourcePath,
  baseline_sha256: sourceHash, candidate_sha256: hash(candidate),
  unchanged_existing_methods: before.size,
  validate_values_sha256: before.get('validate_values'), scan_cds_sha256: before.get('scan_cds'),
  native_scan_sha256: after.get('scan_native'),
  normalized_shared_query_sha256: hash(normalizeSql(query)),
}));
