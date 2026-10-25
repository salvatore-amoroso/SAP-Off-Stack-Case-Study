import assert from 'node:assert/strict';
import { cp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { projectRoot, loadRuntime } from '../deploy/sql/native-runtime.mjs';
import { sapSettings } from './sap-runtime.mjs';
import { connectionString } from '../deploy/sql/odbc-runtime.mjs';
import { assertEvidenceSafe } from './evidence-safety.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
const posix = value => value.split(sep).join('/');
export async function archiveNineRun(sourceArg, targetArg, { root = projectRoot, secrets = [] } = {}) {
  const source = resolve(root, sourceArg), target = resolve(root, targetArg);
  assert(source.startsWith(resolve(root, 'results') + sep), 'Source must be a local results directory');
  assert(target.startsWith(resolve(root, 'docs/benchmark-data') + sep), 'Archive must stay inside docs/benchmark-data');
  const manifest = JSON.parse(await readFile(resolve(source, 'manifest.json')));
  assert(manifest.status === 'complete' && manifest.blocks.length === 27 && manifest.blocks.every(block => block.passed), 'Only a complete passing run can be archived');
  try { await stat(target); throw new Error('Archive destination already exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const files = [];
  async function inventory(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      assert(!entry.isSymbolicLink(), 'Evidence must not contain symbolic links');
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await inventory(path);
      else {
        const bytes = await readFile(path), name = posix(relative(source, path));
        assertEvidenceSafe(name, bytes, { secrets });
        files.push({ path: name, bytes: bytes.length, sha256: sha(bytes) });
      }
    }
  }
  // Finish the safety scan before creating destination content.
  await inventory(source);
  await mkdir(resolve(root, 'docs/benchmark-data'), { recursive: true });
  await cp(source, target, { recursive: true, errorOnExist: true, force: false });
  for (const file of files) assert.equal(sha(await readFile(resolve(target, file.path))), file.sha256, 'Copied evidence differs');
  files.sort((a, b) => a.path.localeCompare(b.path));
  await writeFile(resolve(target, 'evidence-files.json'), JSON.stringify({ schema_version: 1, files }, null, 2) + '\n');
  await writeFile(resolve(target, 'checksums.sha256'), files.map(file => `${file.sha256}  ${file.path}\n`).join(''));
  const receipt = { archived_at_utc: new Date().toISOString(), source: posix(relative(root, source)), archive: posix(relative(root, target)),
    files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0), manifest_sha256: sha(await readFile(resolve(target, 'manifest.json'))), all_copies_hash_verified: true,
    safety_scan: { passed: true, text_type_allowlist: true, private_filenames_rejected: true, private_key_and_token_patterns_checked: true, configured_secret_values_checked: secrets.filter(Boolean).length,
      scope: 'Rejects recognized private files, binaries, key/token patterns and supplied values; cannot prove absence of every unrecognized secret.' }, sap_driver_binaries_included: false };
  await writeFile(resolve(target, 'archive-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert(process.argv.length === 4, 'Usage: archive-nine-run.mjs <complete run> <new archive directory>');
  const settings = sapSettings(), native = await loadRuntime();
  const secrets = [settings.password, native.settings.HANA_PASSWORD, connectionString(settings), `Basic ${Buffer.from(`${settings.username}:${settings.password}`).toString('base64')}`].filter(Boolean);
  console.log(JSON.stringify(await archiveNineRun(process.argv[2], process.argv[3], { secrets })));
}
