#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { diagnosticCommand, validateBlock } from './run-native-profile.mjs';
import { dockerProgram, invoke, loadRuntime, nativeEnvironment, projectRoot } from '../deploy/sql/native-runtime.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const writeJson = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value, null, 2) + '\n'); };
const sourceRoot = resolve(projectRoot, 'clients/node/src');
const workRoot = resolve(projectRoot, 'work/native-profile/buffer-sources');
const originalToken = 'resultSetRowSetLimitKB: 128';

export function bufferSources(mainManifest) {
  const files = readdirSync(sourceRoot, { withFileTypes: true }).filter(item => item.isFile() && item.name.endsWith('.mjs')).map(item => item.name).sort();
  assert(files.includes('sql-transport.mjs'));
  const original = readFileSync(resolve(sourceRoot, 'sql-transport.mjs'), 'utf8');
  assert.equal(original.split(originalToken).length - 1, 1, 'Exactly one original buffer setting must exist');
  const variants = {};
  for (const kib of [128, 1024]) {
    const directory = resolve(workRoot, String(kib)); mkdirSync(directory, { recursive: true });
    const sourceInputs = [];
    for (const file of files) {
      const baseline = readFileSync(resolve(sourceRoot, file));
      const pinned = mainManifest.source_inputs.find(item => item.path === `clients/node/src/${file}`);
      assert.equal(hash(baseline), pinned?.sha256, `Main diagnostic source differs: ${file}`);
      const bytes = file === 'sql-transport.mjs' && kib === 1024 ? Buffer.from(baseline.toString('utf8').replace(originalToken, 'resultSetRowSetLimitKB: 1024')) : baseline;
      const path = resolve(directory, file); writeFileSync(path, bytes);
      if (file === 'sql-transport.mjs' && kib === 1024) assert.equal(bytes.toString('utf8').replace('resultSetRowSetLimitKB: 1024', originalToken), baseline.toString('utf8'), 'Unexpected variant source change');
      else assert.equal(hash(bytes), hash(baseline));
      sourceInputs.push({ file, sha256: hash(bytes), original_sha256: hash(baseline) });
    }
    variants[kib] = { directory, source_inputs: sourceInputs };
  }
  return { variants, proof: { source: 'clients/node/src/sql-transport.mjs', original_token: originalToken, variant_token: 'resultSetRowSetLimitKB: 1024', exact_substitutions: 1, all_other_source_bytes_identical: true } };
}

async function main(args) {
  assert.equal(args.length, 2, 'Usage: node scripts/run-node-hana-buffer-control.mjs --after-run <completed-profile-directory>');
  assert.equal(args[0], '--after-run');
  const mainDirectory = resolve(args[1]), mainBytes = readFileSync(resolve(mainDirectory, 'manifest.json')), previous = JSON.parse(mainBytes);
  assert.equal(previous.protocol, 'sap-native-hana-profile-v1'); assert.equal(previous.status, 'complete'); assert.equal(previous.smoke, false); assert.equal(previous.blocks.length, 36);
  assert(Date.parse(previous.finished_utc) < Date.now(), 'Main experiment must have finished before supplemental measurements');
  const { settings, manifest: seed, query_sha256 } = await loadRuntime();
  assert.equal(previous.expected_rows, seed.expected_rows); assert.equal(previous.expected_digest, seed.expected_digest); assert.equal(previous.query_sha256, query_sha256);
  const source = bufferSources(previous);
  const directory = resolve(projectRoot, 'results', `node-hana-buffer-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  mkdirSync(directory, { recursive: true });
  const env = { ...process.env, ...nativeEnvironment(settings, seed) };
  const image = async () => {
    const result = await invoke(dockerProgram, ['image', 'inspect', '--format', '{{.Id}}', 'sap-polling-node:sql']);
    assert.equal(result.status, 0); return result.stdout.trim();
  };
  const imageId = await image(); assert.equal(imageId, previous.images.node);
  const sourceInputs = [];
  for (const [kib, variant] of Object.entries(source.variants)) for (const item of variant.source_inputs) {
    const snapshot = `sources/${kib}/${item.file}`, path = resolve(directory, snapshot); mkdirSync(dirname(path), { recursive: true });
    copyFileSync(resolve(variant.directory, item.file), path); sourceInputs.push({ variant_kib: Number(kib), ...item, snapshot });
  }
  const queryBytes = readFileSync(resolve(projectRoot, 'contracts/native-hana.sql')); writeFileSync(resolve(directory, 'native-hana.sql'), queryBytes);
  const scriptBytes = readFileSync(resolve(projectRoot, 'scripts/run-node-hana-buffer-control.mjs')); writeFileSync(resolve(directory, 'run-node-hana-buffer-control.mjs'), scriptBytes);
  const manifest = { schema_version: 1, protocol: 'sap-node-hana-buffer-control-v1', status: 'running', started_utc: new Date().toISOString(),
    main_run: { directory: relative(projectRoot, mainDirectory), manifest_sha256: hash(mainBytes) }, rounds: 3, duration_seconds: 15, warmup_scans: 5,
    expected_rows: seed.expected_rows, expected_digest: seed.expected_digest, query_sha256, client_resources: { cpu_limit: 1, memory_bytes: 268435456, memory_swap_bytes: 268435456 },
    image: imageId, source_inputs: sourceInputs, variant_diff_proof: source.proof, script_sha256: hash(scriptBytes), schedule: [[128, 1024], [1024, 128], [128, 1024]], blocks: [] };
  writeJson(resolve(directory, 'manifest.json'), manifest);
  let blockIndex = 0;
  for (const [roundIndex, sizes] of manifest.schedule.entries()) for (const kib of sizes) {
    const variant = source.variants[kib];
    for (const item of variant.source_inputs) assert.equal(hash(readFileSync(resolve(variant.directory, item.file))), item.sha256, 'Variant changed during run');
    const command = diagnosticCommand('node', 'live_profile', { name: `native-hana-node-buffer-${++blockIndex}`, durationSeconds: 15, warmupScans: 5 });
    const sourceAt = command.args.findIndex(value => value.includes('target=/app/src,readonly'));
    assert(sourceAt >= 0); command.args[sourceAt] = `type=bind,source=${variant.directory},target=/app/src,readonly`;
    const started = new Date().toISOString(), clockStarted = performance.now();
    console.log(JSON.stringify({ event: 'block_started', block: blockIndex, round: roundIndex + 1, buffer_kib: kib }));
    const result = await invoke(command.program, command.args, { env, timeout: 195000, maxBytes: 33554432 });
    if (settings.HANA_PASSWORD && result.stdout.includes(settings.HANA_PASSWORD)) throw new Error('OUTPUT_REDACTION_FAILED');
    const path = `block-${String(blockIndex).padStart(2, '0')}-${kib}kib.json`;
    writeFileSync(resolve(directory, path.replace(/\.json$/, '.ndjson')), result.stdout);
    let records = [], verification;
    try {
      assert.equal(result.status, 0); assert.equal(result.timed_out, false); assert.equal(result.oversized, false);
      records = result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
      verification = validateBlock(records, 'node', 'live_profile', { durationSeconds: 15, warmupScans: 5, manifest: seed });
      for (const scan of records.filter(item => item.kind === 'scan')) {
        const calls = scan.metrics?.driver_statistics?.driver_calls;
        assert(calls, 'Driver crossing counters required');
        assert.equal(calls.next_sync + calls.next_async, seed.expected_rows + 1);
        assert.equal(calls.get_values_sync + calls.get_values_async, seed.expected_rows);
        assert.equal(calls.logical_fetch, 51); assert.equal(scan.pages, 51);
      }
    } catch (error) {
      writeJson(resolve(directory, path), { block_index: blockIndex, round: roundIndex + 1, buffer_kib: kib, records, verification: { passed: false } });
      manifest.status = 'failed'; manifest.blocks.push({ path, round: roundIndex + 1, buffer_kib: kib, passed: false }); writeJson(resolve(directory, 'manifest.json'), manifest);
      throw error;
    }
    writeJson(resolve(directory, path), { block_index: blockIndex, round: roundIndex + 1, implementation: 'node', mode: 'live_profile', buffer_kib: kib, duration_seconds: 15,
      started_utc: started, finished_utc: new Date().toISOString(), control_wall_ms: performance.now() - clockStarted, verification, records });
    manifest.blocks.push({ path, round: roundIndex + 1, buffer_kib: kib, passed: true }); writeJson(resolve(directory, 'manifest.json'), manifest);
    console.log(JSON.stringify({ event: 'block_complete', block: blockIndex, round: roundIndex + 1, buffer_kib: kib, ...verification }));
    await new Promise(accept => setTimeout(accept, 2000));
  }
  assert.equal(await image(), imageId); assert.equal(hash(readFileSync(resolve(projectRoot, 'contracts/native-hana.sql'))), query_sha256);
  assert.equal(hash(readFileSync(resolve(mainDirectory, 'manifest.json'))), manifest.main_run.manifest_sha256);
  for (const variant of Object.values(source.variants)) for (const item of variant.source_inputs) assert.equal(hash(readFileSync(resolve(variant.directory, item.file))), item.sha256);
  manifest.status = 'complete'; manifest.finished_utc = new Date().toISOString(); manifest.final_image = imageId; writeJson(resolve(directory, 'manifest.json'), manifest);
  console.log(JSON.stringify({ event: 'complete', directory: relative(projectRoot, directory), blocks: manifest.blocks.length }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2)).catch(error => { console.error(JSON.stringify({ event: 'failed', error: error.message })); process.exitCode = 1; });
}
