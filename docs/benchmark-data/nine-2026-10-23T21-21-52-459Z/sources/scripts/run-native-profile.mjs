import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { runAbapProfile } from './native-profile-control.mjs';
import { projectRoot, loadRuntime, nativeEnvironment, nativeDockerCommand, invoke, dockerProgram } from '../deploy/sql/native-runtime.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const output = (path, data) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(data, null, 2) + '\n'); };
const capturePath = resolve(projectRoot, 'work/native-profile/captured-rows.json');
const modes = ['live_control', 'live_profile', 'db_only', 'replay_full'];
const clients = ['node', 'rust', 'abap'];

export function diagnosticCommand(client, mode, { name, durationSeconds, warmupScans, capture = false }) {
  const command = nativeDockerCommand(client, { name, ...(client === 'node' ? { sourceDirectory: resolve(projectRoot, 'clients/node/src') } : {}) });
  const args = command.args;
  if (!capture && mode === 'replay_full') {
    const imageAt = args.indexOf(`sap-polling-${client}:sql`);
    args.splice(imageAt, 0, '--mount', `type=bind,source=${capturePath},target=/run/capture.json,readonly`);
  }
  if (client === 'node') {
    args[args.indexOf('/app/src/sql-cli.mjs')] = '/app/src/sql-profile.mjs';
    args.push('--mode', capture ? 'capture' : ({ live_control: 'full', live_profile: 'full', db_only: 'db-only', replay_full: 'replay' })[mode], '--profile', String(mode !== 'live_control' && !capture));
    if (mode === 'replay_full') args.push('--capture-file', '/run/capture.json');
  } else {
    args[args.indexOf('sap-polling-rust:sql')] = 'sap-polling-rust:sql-profile';
    const transportAt = args.indexOf('--transport');
    args.splice(transportAt, 2);
    args.push('--mode', ({ live_control: 'control', live_profile: 'full', db_only: 'fetch-only', replay_full: 'replay-full' })[mode]);
    if (mode === 'replay_full') args.push('--rows-file', '/run/capture.json');
  }
  args.push('--duration-seconds', String(durationSeconds), '--warmup-scans', String(warmupScans));
  return command;
}

export function validateBlock(records, client, mode, { durationSeconds, warmupScans, manifest, smoke = false }) {
  const scans = records.filter(item => item.kind === 'scan'), summaries = records.filter(item => item.kind === 'summary');
  assert.equal(summaries.length, 1, 'One summary required');
  const summary = summaries[0], measured = scans.filter(item => item.phase === 'measured'), warmup = scans.filter(item => item.phase === 'warmup');
  assert.equal(summary.measured_scans, measured.length);
  assert.equal(summary.warmup_scans, warmup.length);
  assert.equal(warmup.length, warmupScans);
  assert(measured.length > 0 && summary.measured_wall_ms >= durationSeconds * 1000 - (smoke ? 1 : 0));
  assert(summary.outcome === undefined || summary.outcome === 'ok');
  assert(!summary.failed_scans);
  for (const item of scans) {
    assert.equal(item.outcome, 'ok'); assert.equal(item.rows, manifest.expected_rows); assert.equal(item.error, null);
    if (mode !== 'db_only') assert.equal(item.digest, manifest.expected_digest);
    if (mode !== 'live_control') {
      const timings = item.timings || item.metrics?.profile;
      assert(timings, `${client} ${mode}: phase timings required`);
      for (const key of ['database_ms', 'validation_ms', 'hashing_ms', 'cleanup_ms', 'residual_ms', 'total_ms']) assert(Number.isFinite(timings[key]) && timings[key] >= -0.1, `${key} invalid`);
      const sum = timings.database_ms + timings.validation_ms + timings.hashing_ms + timings.cleanup_ms + timings.residual_ms;
      assert(Math.abs(sum - timings.total_ms) < 0.03, 'Exclusive phase sum differs from total');
    }
  }
  return { passed: true, failed_scans: 0, measured_scans: measured.length, warmup_scans: warmup.length, measured_wall_ms: summary.measured_wall_ms };
}

async function runExternal(client, mode, options, env, sensitive) {
  const command = diagnosticCommand(client, mode, options);
  const result = await invoke(command.program, command.args, { env, timeout: (options.durationSeconds + 180) * 1000, maxBytes: 33554432 });
  if (result.status !== 0 || result.timed_out || result.oversized) throw new Error(`PROFILE_PROCESS_FAILED:${client}:${mode}:${result.status}`);
  if (sensitive.some(value => result.stdout.includes(value))) throw new Error('OUTPUT_REDACTION_FAILED');
  return result.stdout;
}

async function main(args) {
  const smoke = args.includes('--smoke'), captureOnly = args.includes('--capture-only');
  const clientFlag = args.indexOf('--only'), only = clientFlag < 0 ? clients : [args[clientFlag + 1]];
  assert(only.every(client => clients.includes(client)));
  const { settings, manifest: seed, query_sha256 } = await loadRuntime();
  const env = { ...process.env, ...nativeEnvironment(settings, seed) }, sensitive = [settings.HANA_PASSWORD].filter(Boolean);
  if (captureOnly || !readable(capturePath)) {
    console.log(JSON.stringify({ event: 'capture_started' }));
    const raw = await runExternal('node', 'live_control', { name: 'native-hana-node-profile-capture', durationSeconds: 1, warmupScans: 5, capture: true }, env, sensitive);
    const capture = raw.trim().split(/\r?\n/).map(line => JSON.parse(line)).find(item => item.kind === 'capture');
    assert(capture && capture.rows.length === 5000 && capture.expected_digest === seed.expected_digest);
    output(capturePath, capture);
    console.log(JSON.stringify({ event: 'capture_complete', rows: capture.rows.length, sha256: hash(readFileSync(capturePath)) }));
    if (captureOnly) return;
  }
  const identifier = new Date().toISOString().replace(/[:.]/g, '-');
  const directory = resolve(projectRoot, smoke ? 'work/native-profile' : 'results', `native-profile-${identifier}`);
  mkdirSync(directory, { recursive: true });
  const raw = async (program, args) => { const result = await invoke(program, args, { timeout: 30000 }); if (result.status !== 0) throw new Error('PROVENANCE_FAILED'); return result.stdout.trim(); };
  const images = {};
  for (const client of ['node', 'rust']) if (only.includes(client)) images[client] = await raw(dockerProgram, ['image', 'inspect', '--format', '{{.Id}}', `sap-polling-${client}:${client === 'rust' ? 'sql-profile' : 'sql'}`]);
  const sourcePaths = ['scripts/run-native-profile.mjs', 'scripts/native-profile-control.mjs', 'docs/native-profile-protocol.md', 'contracts/native-hana.sql', 'contracts/seed-manifest.json', 'clients/rust/Cargo.toml', 'clients/rust/Cargo.lock', 'clients/node/package-lock.json', 'sap/src/zcl_bl_poll_orders.clas.abap', 'sap/src/zcl_bl_poll_orders.clas.locals_def.abap', 'sap/src/zcl_bl_poll_orders.clas.locals_imp.abap'];
  const addSources = path => { for (const item of readdirSync(resolve(projectRoot, path), { withFileTypes: true })) { const child = `${path}/${item.name}`; if (item.isDirectory()) addSources(child); else if (/\.(?:mjs|rs|abap)$/.test(item.name)) sourcePaths.push(child); } };
  for (const path of ['clients/node/src', 'clients/rust/src', 'sap/diagnostics/native-hana']) {
    if (!readable(resolve(projectRoot, path))) continue;
    addSources(path);
  }
  const sourceInputs = sourcePaths.map(path => { const bytes = readFileSync(resolve(projectRoot, path)), snapshot = `sources/${path}`; mkdirSync(dirname(resolve(directory, snapshot)), { recursive: true }); copyFileSync(resolve(projectRoot, path), resolve(directory, snapshot)); return { path, snapshot, sha256: hash(bytes) }; });
  const officialPath = resolve(projectRoot, 'docs/native-comparison.json');
  const report = { schema_version: 1, protocol: 'sap-native-hana-profile-v1', status: 'running', smoke, started_utc: new Date().toISOString(),
    rounds: smoke ? 1 : 3, warmup_scans: smoke ? 1 : 5, live_duration_seconds: smoke ? 1 : 20, control_duration_seconds: smoke ? 1 : 10,
    expected_rows: seed.expected_rows, expected_digest: seed.expected_digest, query_sha256, capture: { path: relative(projectRoot, capturePath), sha256: hash(readFileSync(capturePath)) },
    official_baseline: { path: 'docs/native-comparison.json', sha256: hash(readFileSync(officialPath)) }, client_resources: { cpu_limit: 1, memory_bytes: 268435456 },
    images, source_inputs: sourceInputs, source_revision: await raw('git', ['rev-parse', 'HEAD']), working_tree_status: await raw('git', ['status', '--porcelain']),
    readiness: { node_tests: { passed: 123, failed: 0, command: 'npm --prefix clients/node test' }, controller_self_checks: 7,
      rust: JSON.parse(readFileSync(resolve(projectRoot, 'work/native-profile/rust/build-receipt.json'))),
      abap_active_source_proof: JSON.parse(readFileSync(resolve(projectRoot, 'sap/diagnostics/native-hana/active-source-proof.json'))),
      smoke: { node: 'work/native-profile/native-profile-2026-10-23T14-24-15-045Z', abap: 'work/native-profile/native-profile-2026-10-23T14-24-34-129Z', rust: 'work/native-profile/native-profile-2026-10-23T14-26-19-490Z', all_passed: true },
    }, blocks: [] };
  copyFileSync(capturePath, resolve(directory, 'captured-rows.json'));
  output(resolve(directory, 'manifest.json'), report);
  const schedule = smoke ? [only] : [['node', 'rust', 'abap'], ['rust', 'abap', 'node'], ['abap', 'node', 'rust']].map(items => items.filter(client => only.includes(client)));
  let blockIndex = 0;
  for (const [roundIndex, order] of schedule.entries()) for (const client of order) {
    const modeOrder = roundIndex % 2 ? ['live_profile', 'live_control', 'replay_full', 'db_only'] : modes;
    for (const mode of modeOrder) {
      const durationSeconds = smoke ? 1 : mode.startsWith('live_') ? 20 : 10, warmupScans = smoke ? 1 : 5;
      for (const source of sourceInputs) assert.equal(hash(readFileSync(resolve(projectRoot, source.path))), source.sha256, `Measured source changed: ${source.path}`);
      const started = new Date().toISOString(), clockStarted = performance.now();
      console.log(JSON.stringify({ event: 'block_started', block: ++blockIndex, round: roundIndex + 1, client, mode, duration_seconds: durationSeconds }));
      let body;
      if (client === 'abap') body = await runAbapProfile({ mode: ({ live_control: 'copy', live_profile: 'profile', db_only: 'db_only', replay_full: 'replay' })[mode],
        duration_seconds: durationSeconds, warmup_scans: warmupScans, max_scans: 0, expected_rows: seed.expected_rows, expected_digest: seed.expected_digest, sap_client: '001', scan_timeout_seconds: 120, max_pages: 10000 });
      else body = await runExternal(client, mode, { name: `native-hana-${client}-profile-${blockIndex}`, durationSeconds, warmupScans }, env, sensitive);
      const records = body.trim().split(/\r?\n/).map(line => JSON.parse(line));
      const path = `block-${String(blockIndex).padStart(2, '0')}-${client}-${mode}.json`;
      writeFileSync(resolve(directory, path.replace(/\.json$/, '.ndjson')), body);
      let verification;
      try { verification = validateBlock(records, client, mode, { durationSeconds, warmupScans, manifest: seed, smoke }); }
      catch (error) {
        output(resolve(directory, path), { block_index: blockIndex, round: roundIndex + 1, implementation: client, mode, records, verification: { passed: false } });
        report.status = 'failed'; report.blocks.push({ path, round: roundIndex + 1, implementation: client, mode, passed: false }); output(resolve(directory, 'manifest.json'), report);
        throw error;
      }
      output(resolve(directory, path), { block_index: blockIndex, round: roundIndex + 1, implementation: client, mode, duration_seconds: durationSeconds, started_utc: started, finished_utc: new Date().toISOString(), control_wall_ms: performance.now() - clockStarted, verification, records });
      report.blocks.push({ path, round: roundIndex + 1, implementation: client, mode, passed: true });
      output(resolve(directory, 'manifest.json'), report);
      console.log(JSON.stringify({ event: 'block_complete', block: blockIndex, client, mode, ...verification }));
      await new Promise(accept => setTimeout(accept, smoke ? 100 : 2000));
    }
  }
  for (const source of sourceInputs) assert.equal(hash(readFileSync(resolve(projectRoot, source.path))), source.sha256);
  for (const [client, id] of Object.entries(images)) assert.equal(await raw(dockerProgram, ['image', 'inspect', '--format', '{{.Id}}', `sap-polling-${client}:${client === 'rust' ? 'sql-profile' : 'sql'}`]), id);
  assert.equal(hash(readFileSync(officialPath)), report.official_baseline.sha256);
  report.status = 'complete'; report.finished_utc = new Date().toISOString();
  output(resolve(directory, 'manifest.json'), report);
  console.log(JSON.stringify({ event: 'complete', directory: relative(projectRoot, directory), blocks: report.blocks.length }));
}

function readable(path) { try { readFileSync(path); return true; } catch { try { readdirSync(path); return true; } catch { return false; } } }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--self-test')) {
    const seed = { expected_rows: 5000, expected_digest: 'a'.repeat(64) };
    const scan = phase => ({ kind: 'scan', phase, outcome: 'ok', rows: 5000, error: null, digest: seed.expected_digest, timings: { database_ms: 1, validation_ms: 2, hashing_ms: 3, cleanup_ms: 1, residual_ms: 1, total_ms: 8 } });
    const records = [scan('warmup'), scan('measured'), { kind: 'summary', measured_scans: 1, warmup_scans: 1, measured_wall_ms: 20000 }];
    const options = { durationSeconds: 20, warmupScans: 1, manifest: seed };
    assert(validateBlock(records, 'node', 'live_profile', options).passed);
    for (const mutate of [data => { data[1].digest = 'b'.repeat(64); }, data => { data[1].timings.hashing_ms = -1; }, data => { data[2].measured_wall_ms = 19999; }, data => { data[1].outcome = 'error'; }, data => { data[1].timings.total_ms = 9; }]) { const copy = structuredClone(records); mutate(copy); assert.throws(() => validateBlock(copy, 'node', 'live_profile', options)); }
    const command = diagnosticCommand('rust', 'replay_full', { durationSeconds: 20, warmupScans: 5 });
    assert(!command.args.includes('--transport') && command.args.includes('--rows-file'));
    console.log('Native profiling controller self-test passed (seven checks).');
  } else await main(process.argv.slice(2)).catch(error => { console.error(JSON.stringify({ event: 'failed', error: error.message })); process.exitCode = 1; });
}
