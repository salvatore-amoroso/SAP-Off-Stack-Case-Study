import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const runtimeDirectory = resolve(projectRoot, 'work/native-hana');
export const queryFile = resolve(projectRoot, 'contracts/native-hana.sql');
export const namespace = 'sap-polling-lab';
export const context = 'kind-sap-polling-lab';
export const controlPlane = 'sap-polling-lab-control-plane';
export const network = 'sap-local-ports';
export const dockerProgram = process.env.DOCKER_EXE || 'docker';
export const kubectlArguments = ['--kubeconfig', resolve(projectRoot, 'work/kind-kubeconfig.yaml'), '--context', context, '--namespace', namespace];

export function validateRuntime(settings, manifest) {
  if (!settings || ['HANA_DATABASE', 'HANA_USER', 'HANA_PASSWORD'].some(key => typeof settings[key] !== 'string' || !settings[key] || settings[key].includes('\0'))) throw new Error('Private native HANA settings are invalid');
  if (settings.HANA_DATABASE !== 'HDB' || settings.HANA_USER !== 'ZBL_BENCH_RO' || settings.HANA_SERVER !== 'sap-a4h:30215') throw new Error('Native HANA settings do not identify the provisioned lab principal');
  if (manifest.expected_rows !== 5000 || !/^[a-f0-9]{64}$/.test(manifest.expected_digest)) throw new Error('Frozen native HANA manifest is invalid');
}

export async function loadRuntime() {
  const [settings, manifest, sql] = await Promise.all([
    readFile(resolve(runtimeDirectory, 'runtime.json'), 'utf8').then(JSON.parse),
    readFile(resolve(projectRoot, 'contracts/seed-manifest.json'), 'utf8').then(JSON.parse),
    readFile(queryFile, 'utf8'),
  ]);
  validateRuntime(settings, manifest);
  if (!sql.trim() || sql.includes('\0')) throw new Error('Shared native HANA query is invalid');
  return { settings, manifest, sql, query_sha256: createHash('sha256').update(sql).digest('hex') };
}

export function nativeEnvironment(settings, manifest, server = 'sap-a4h:30215') {
  return {
    HANA_SERVER: server, HANA_DATABASE: settings.HANA_DATABASE, HANA_USER: settings.HANA_USER, HANA_PASSWORD: settings.HANA_PASSWORD,
    SQL_QUERY_FILE: '/run/sql/native-hana.sql', SQL_TRANSPORT: 'hana', SAP_CLIENT: '001', EXPECTED_ROWS: String(manifest.expected_rows), EXPECTED_DIGEST: manifest.expected_digest,
    SCANS: '1', POLL_INTERVAL_MS: '1000', PAGE_SIZE: '100', REQUEST_TIMEOUT_SECONDS: '10', SCAN_TIMEOUT_SECONDS: '120', MAX_PAGES: '10000',
  };
}

export function nativeDockerCommand(implementation, { name, sqlFile = queryFile, sourceDirectory } = {}) {
  if (!['node', 'rust'].includes(implementation)) throw new Error('Unknown native HANA client');
  if (name !== undefined && !/^native-hana-(?:node|rust)-[a-z0-9-]+$/.test(name)) throw new Error('Invalid native HANA client container name');
  if (sqlFile.includes(',')) throw new Error('The shared SQL path cannot contain a comma');
  const args = ['run', '--rm', '--cpus', '1', '--memory', '256m', '--memory-swap', '256m', '--network', network, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true'];
  if (name) args.push('--name', name);
  for (const key of Object.keys(nativeEnvironment({ HANA_DATABASE: '', HANA_USER: '', HANA_PASSWORD: '' }, { expected_rows: 5000, expected_digest: '' }))) args.push('--env', key);
  args.push('--mount', `type=bind,source=${sqlFile},target=/run/sql/native-hana.sql,readonly`);
  if (sourceDirectory) {
    if (implementation !== 'node' || sourceDirectory.includes(',')) throw new Error('Invalid native client source mount');
    args.push('--mount', `type=bind,source=${sourceDirectory},target=/app/src,readonly`);
  }
  if (implementation === 'node') args.push('--env', 'UV_THREADPOOL_SIZE=1', '--env', 'HDB_NODEJS_THREADPOOL_SIZE=1', '--entrypoint', 'node');
  args.push(`sap-polling-${implementation}:sql`);
  if (implementation === 'node') args.push('--v8-pool-size=1', '/app/src/sql-cli.mjs');
  args.push('--transport', 'hana');
  return { program: dockerProgram, args };
}

export async function mountedSource(sourceDirectory) {
  const files = (await readdir(sourceDirectory, { withFileTypes: true })).filter(file => file.isFile() && file.name.endsWith('.mjs')).map(file => file.name).sort();
  const hash = createHash('sha256');
  for (const file of files) hash.update(file).update('\0').update(await readFile(resolve(sourceDirectory, file))).update('\0');
  return { mode: 'read_only_bind_mount', sha256: hash.digest('hex'), files };
}

// Native driver and kubectl stderr can include credentials; callers get only status and bounded stdout.
export function invoke(program, args, { env = process.env, input, timeout = 30000, maxBytes = 1048576 } = {}) {
  return new Promise(resolveProcess => {
    let stdout = '', bytes = 0, timedOut = false, oversized = false, settled = false;
    const child = spawn(program, args, { cwd: projectRoot, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const finish = status => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveProcess({ status, stdout: oversized ? '' : stdout, timed_out: timedOut, oversized });
    };
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) { oversized = true; stdout = ''; child.kill(); }
      else if (!oversized) stdout += chunk;
    });
    child.stderr.on('data', () => {});
    child.on('error', () => finish(null));
    child.on('close', status => finish(status));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export function scanResult(text) {
  const value = typeof text === 'string' ? JSON.parse(text.trim()) : text;
  const integer = number => Number.isSafeInteger(number) && number >= 0;
  const metric = number => typeof number === 'number' && Number.isFinite(number) && number >= 0;
  const codes = ['CONFIG', 'TRANSPORT', 'TIMEOUT', 'LIMIT', 'SCHEMA', 'ORDER', 'COUNT', 'DIGEST'];
  if (!value || value.schema_version !== 1 || value.scan_index !== 0 || !['ok', 'error'].includes(value.outcome) || !integer(value.rows) || !integer(value.pages)) throw new Error('Invalid native HANA scan result');
  if (value.outcome === 'ok' ? (value.error !== null || !/^[a-f0-9]{64}$/.test(value.digest)) : (value.digest !== null || !value.error || !codes.includes(value.error.code) || !integer(value.error.page_index) || value.error.http_status !== null)) throw new Error('Invalid native HANA outcome');
  if (!value.metrics || !metric(value.metrics.elapsed_ms) || !metric(value.metrics.body_bytes) || !integer(value.metrics.missed_slots)) throw new Error('Invalid native HANA metrics');
  return {
    schema_version: 1, scan_index: 0, outcome: value.outcome, rows: value.rows, pages: value.pages, digest: value.digest,
    error: value.error === null ? null : { code: value.error.code, page_index: value.error.page_index, http_status: null },
    metrics: { elapsed_ms: value.metrics.elapsed_ms, body_bytes: value.metrics.body_bytes, missed_slots: value.metrics.missed_slots },
  };
}

export const functional = ({ schema_version, scan_index, outcome, rows, pages, digest, error }) => ({ schema_version, scan_index, outcome, rows, pages, digest, error });
export const validScan = (result, manifest) => Boolean(result && result.outcome === 'ok' && result.rows === manifest.expected_rows && result.digest === manifest.expected_digest && result.pages === 51 && result.metrics.body_bytes === 0);

export function abapEvidence(result, proof, manifest, queryHash) {
  if (!proof) return { status: 'pending', passed: false, reason: 'ABAP native HANA proof has not been captured' };
  try {
    if (proof.passed !== true || proof.query_sha256 !== queryHash || typeof proof.observed_at !== 'string' || !Number.isFinite(Date.parse(proof.observed_at)) || !Array.isArray(proof.records)) throw new Error('Invalid ABAP query proof');
    const first = scanResult(proof.records.find(record => record.kind === 'scan'));
    const passed = validScan(result, manifest) && validScan(first, manifest) && isDeepStrictEqual(functional(first), functional(result));
    return { status: passed ? 'passed' : 'failed', passed, observed_at: proof.observed_at, query_sha256: proof.query_sha256, result };
  } catch {
    return { status: 'failed', passed: false, reason: 'ABAP native HANA proof does not validate this query and saved scan' };
  }
}

export function parityReport(implementations, manifest, queryHash) {
  const names = ['node', 'rust', 'abap'];
  const reference = implementations.node?.result;
  const clientsPassed = ['node', 'rust'].every(name => implementations[name]?.passed);
  const nodeRustMatch = Boolean(reference && implementations.rust?.result && isDeepStrictEqual(functional(reference), functional(implementations.rust.result)));
  const pending = names.some(name => implementations[name]?.status === 'pending');
  const functionalMatch = pending ? null : Boolean(reference) && names.every(name => implementations[name]?.result && isDeepStrictEqual(functional(reference), functional(implementations[name].result)));
  const allPassed = functionalMatch === true && names.every(name => implementations[name]?.passed);
  const failed = names.some(name => implementations[name]?.status === 'failed') || (clientsPassed && !nodeRustMatch);
  return {
    schema_version: 1, observed_at: new Date().toISOString(), transport: 'native_hana', expected_rows: manifest.expected_rows, expected_digest: manifest.expected_digest, query_sha256: queryHash,
    resources: { cpu_limit: '1', memory_limit: '256Mi', scans: 1, sequential: true }, implementations,
    node_rust_match: nodeRustMatch, node_rust_passed: clientsPassed && nodeRustMatch, functional_match: functionalMatch,
    status: allPassed ? 'passed' : failed || !pending ? 'failed' : 'pending', all_passed: allPassed,
  };
}

export function runtimeObjects(settings, manifest, sql, address) {
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(address) || address.split('.').some(octet => Number(octet) > 255)) throw new Error('Invalid existing SAP network address');
  const environment = nativeEnvironment(settings, manifest, `${address}:30215`);
  const data = Object.fromEntries(Object.entries(environment).filter(([key]) => !['HANA_USER', 'HANA_PASSWORD'].includes(key)));
  const metadata = name => ({ name, namespace, labels: { 'app.kubernetes.io/part-of': 'sap-order-polling-lab' } });
  return {
    apiVersion: 'v1', kind: 'List', items: [
      { apiVersion: 'v1', kind: 'Namespace', metadata: { name: namespace, labels: { 'app.kubernetes.io/part-of': 'sap-order-polling-lab' } } },
      { apiVersion: 'v1', kind: 'ConfigMap', metadata: metadata('native-hana-config'), data },
      { apiVersion: 'v1', kind: 'ConfigMap', metadata: metadata('native-hana-query'), data: { 'native-hana.sql': sql } },
      { apiVersion: 'v1', kind: 'Secret', metadata: metadata('native-hana-credentials'), type: 'Opaque', data: { HANA_USER: Buffer.from(settings.HANA_USER).toString('base64'), HANA_PASSWORD: Buffer.from(settings.HANA_PASSWORD).toString('base64') } },
    ],
  };
}
