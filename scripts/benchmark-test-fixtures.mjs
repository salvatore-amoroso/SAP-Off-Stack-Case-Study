// Small synthetic evidence; never a performance measurement or live-system fixture.
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { applications, nineSchedule } from './run-nine-comparison.mjs';

export const digest = 'df57de597e919adb10ae5365201b999788e86b39219ad040ffbc305539180bc7';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const origin = Date.UTC(2026, 0, 1);
const utc = milliseconds => new Date(origin + milliseconds).toISOString();
export function fixtureInputs() {
  return { protocol: 'sap-nine-path-benchmark-v1', synthetic_test_data: true,
    configuration: { duration_seconds: 180, warmup_scans: 5, rounds: 3, cooldown_seconds: 5, expected_rows: 5000,
      expected_digest: digest, sap_client: '001', concurrency: 1, retries: 0 },
    apps: applications, schedule: nineSchedule(), images: {}, source_inputs: [], evidence_files: [] };
}

export function fixtureBlock(index, { failed = false, startMs = (index - 1) * 190000 } = {}) {
  const appId = nineSchedule().flat()[index - 1], app = applications.find(item => item.app_id === appId);
  const abap = app.language === 'abap', http = app.approach === 'http', cds = app.approach === 'cds';
  const transport = http ? (abap ? 'classic_socket' : 'socket') : cds ? (abap ? 'direct_cds' : 'odbc') : (abap ? 'native_hana_adbc' : 'hana');
  const scans = Array.from({ length: failed ? 1 : 9 }, (_, offset) => ({ kind: 'scan', phase: offset < 5 ? 'warmup' : 'measured',
    schema_version: 1, scan_index: offset >= 5 && abap ? offset - 5 : offset, outcome: failed ? 'error' : 'ok',
    error: failed ? { code: 'TIMEOUT', page_index: 0, http_status: null } : null, rows: failed ? 0 : 5000,
    pages: failed ? 0 : abap && cds ? 50 : 51, digest: failed ? null : digest,
    metrics: { elapsed_ms: failed ? 25000 : offset < 5 ? 1 : (offset - 2) * 10000, body_bytes: !failed && http ? 1074741 : 0, missed_slots: 0 },
    ...(abap && !http ? { transport, http_requests: 0, application_batches: 50, logical_fetches: 51 } : {}) }));
  const summary = { kind: 'summary', outcome: failed ? 'error' : 'ok', transport, measured_wall_ms: failed ? 0 : 180000,
    warmup_scans: failed ? 1 : 5, measured_scans: failed ? 0 : 4, client_policy: http ? 'fresh_per_scan' : 'persistent', fetch_size: 100 };
  if (abap && !failed) Object.assign(summary, { duration_seconds: 180, failed_scans: 0, measured_valid_rows: 20000,
    measured_body_bytes: http ? 4 * 1074741 : 0, authentication: 'preemptive_basic',
    service_root: 'http://host.docker.internal/sap/opu/odata4/sap/zui_bl_orders_o4/srvd_a2x/sap/zui_bl_orders/0001/',
    http_requests: 0, sap_client: '001', db_package_size: 100,
    entity: cds ? 'ZI_BL_OrderPosition' : 'ZBL_BENCH_SQL.ORDER_POSITIONS_001', measured_application_batches: 200, measured_logical_fetches: 204 });
  const control = failed ? 25100 : 181000;
  return { block_index: index, round: Math.floor((index - 1) / 9) + 1, ...app, exit_code: failed ? 1 : 0,
    timed_out: false, oversized: false, control_wall_ms: control, started_utc: utc(startMs), finished_utc: utc(startMs + control),
    verification: { passed: !failed, failures: failed ? 1 : 0 }, resource_samples: [], records: [...scans, summary] };
}

export async function fixtureRun({ continued = false, retry = 12 } = {}) {
  await mkdir(resolve(import.meta.dirname, '../work'), { recursive: true });
  const directory = await mkdtemp(resolve(import.meta.dirname, '../work/nine-fixture-'));
  const files = new Set(), inputs = fixtureInputs(), blocks = [], entries = [];
  const save = async (path, value) => {
    const bytes = typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n';
    await mkdir(dirname(resolve(directory, path)), { recursive: true }); await writeFile(resolve(directory, path), bytes); files.add(path);
    return { path, sha256: sha(bytes) };
  };
  const saveBlock = async (block, prefix = '') => {
    const path = `${prefix}block-${String(block.block_index).padStart(2, '0')}-${block.app_id}.json`;
    block.raw_file = path.replace('.json', '.ndjson');
    block.raw_sha256 = (await save(block.raw_file, block.records.map(record => JSON.stringify(record)).join('\n') + '\n')).sha256;
    return { ...await save(path, block), round: block.round, app_id: block.app_id, passed: block.exit_code === 0 };
  };
  const addSource = async (path, contents) => inputs.source_inputs.push({ path, sha256: (await save(`sources/${path}`, contents)).sha256, snapshot: `sources/${path}` });
  await addSource('contracts/fixtures.json', { cases: [{ id: 'synthetic-empty', expected: { outcome: 'ok', rows: 0, pages: 1, digest: 'a'.repeat(64), error: null } }] });
  await addSource('sap/src/zcl_bl_poll_orders.clas.testclasses.abap', 'METHODS first FOR TESTING.\nMETHODS second FOR TESTING.\n');
  for (const [path, contents] of [
    ['fixtures.ndjson', JSON.stringify({ id: 'synthetic-empty', passed: true, result: { outcome: 'ok', rows: 0, pages: 1, digest: 'a'.repeat(64), error: null } }) + '\n' + JSON.stringify({ fixture_count: 1, passed: 1 }) + '\n'],
    ['unit.xml', '<run><testMethod name="first"/><testMethod name="second"/></run>'],
  ]) inputs.evidence_files.push({ path: `work/preflight/${path}`, snapshot: `evidence/${path}`, sha256: (await save(`evidence/${path}`, contents)).sha256 });
  const inputsEntry = await save('inputs.json', inputs);
  const manifest = { protocol: inputs.protocol, status: 'complete', inputs_sha256: inputsEntry.sha256, schedule: inputs.schedule, blocks: entries, final_images: {} };
  const failureStart = (retry - 1) * 190000, pause = 900000, resumed = failureStart + 25100 + pause;
  for (let index = 1; index <= 27; index++) {
    const startMs = continued && index >= retry ? resumed + 5000 + (index - retry) * 190000 : (index - 1) * 190000;
    const block = fixtureBlock(index, { startMs }); blocks.push(block); entries.push(await saveBlock(block));
  }
  if (continued) {
    const failed = fixtureBlock(retry, { failed: true, startMs: failureStart }), failedEntry = await saveBlock(failed, 'prior-attempts/');
    const original = { status: 'failed', inputs_sha256: inputsEntry.sha256,
      blocks: [...entries.slice(0, retry - 1), { ...failedEntry, path: failedEntry.path.replace('prior-attempts/', '') }], finished_utc: failed.finished_utc };
    const originalEntry = await save('prior-attempts/manifest.failed.json', original);
    const proof = await save('continuation-proof.json', { ready: true, unchanged_workload: true, unchanged_runtime_configuration: true, sap_not_restarted: true, changes_during_pause: { source: false } });
    const controller = await save('controller/source.mjs', '// Synthetic controller snapshot.\n');
    const amendment = { execution_mode: 'continued', clean_run: false, first_continued_block_index: retry, original_inputs_sha256: inputsEntry.sha256,
      original_failed_manifest: originalEntry, adopted_blocks: entries.slice(0, retry - 1).map(({ path, sha256 }) => ({ path, sha256 })),
      failed_attempt: { ...failedEntry, planned_block_index: retry, measured_scans: 0, raw_path: failed.raw_file, raw_sha256: failed.raw_sha256 },
      proof, diagnostics: [], controller: { snapshot: controller.path, sha256: controller.sha256 },
      paused_at_utc: failed.finished_utc, resumed_at_utc: utc(resumed), created_utc: utc(resumed), gap_before_resume_ms: pause };
    const amendmentEntry = await save('continuation-inputs.json', amendment);
    const attempts = entries.flatMap((entry, index) => {
      const block = blocks[index], attempt = { planned_block_index: index + 1, attempt_index: index + 1 === retry ? 2 : 1,
        app_id: block.app_id, status: 'passed', path: entry.path, sha256: entry.sha256, started_utc: block.started_utc, finished_utc: block.finished_utc, adopted: index + 1 < retry };
      return index + 1 !== retry ? [attempt] : [{ ...attempt, attempt_index: 1, status: 'failed', path: failedEntry.path, sha256: failedEntry.sha256,
        started_utc: failed.started_utc, finished_utc: failed.finished_utc, adopted: false }, attempt];
    });
    const attemptsEntry = await save('attempts.json', attempts);
    Object.assign(manifest, { execution_mode: 'continued', clean_run: false, total_attempts: 28, failed_attempts: 1, successful_measured_blocks: 27,
      continuation_inputs_file: amendmentEntry.path, continuation_inputs_sha256: amendmentEntry.sha256, attempts_file: attemptsEntry.path, attempts_sha256: attemptsEntry.sha256 });
  }
  const saveManifest = () => save('manifest.json', manifest);
  const saveIndex = async () => save('evidence-files.json', { files: await Promise.all([...files].filter(path => path !== 'evidence-files.json').map(async path => ({ path, sha256: sha(await readFile(resolve(directory, path))) }))) });
  await saveManifest(); await saveIndex();
  return { directory, inputs, manifest, blocks, save, saveBlock, saveManifest, saveIndex };
}
