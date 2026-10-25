import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { namespace, controlPlane, dockerProgram, invoke, projectRoot, scanResult } from './native-runtime.mjs';
import { driverDirectory, driverMount, loadOdbcRuntime, odbcEnvironment, sapCertificateHost } from './odbc-runtime.mjs';

export const artifactVersion = 1;
export const bundleRoot = '/opt/sap/abap-odbc-bundles';
export const inputMount = '/run/cds-inputs';
export const terminationPath = '/dev/termination-log';
export const sha256 = value => createHash('sha256').update(value).digest('hex');
const owner = 'sap-order-polling-lab';
const hashPattern = /^[a-f0-9]{64}$/;
const safeName = name => typeof name === 'string' && !['.', '..'].includes(name) && /^[A-Za-z0-9_.+-]+$/.test(name);
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

export function inventoryText(files) {
  assert(Array.isArray(files) && files.length > 0, 'Driver bundle is empty');
  const sorted = [...files].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  assert.equal(new Set(sorted.map(file => file.name)).size, sorted.length, 'Duplicate driver file');
  for (const file of sorted) assert(safeName(file.name) && Number.isSafeInteger(file.bytes) && file.bytes >= 0 && hashPattern.test(file.sha256), 'Invalid driver inventory');
  return sorted.map(file => `${file.name}\t${file.bytes}\t${file.sha256}\n`).join('');
}

export async function inventoryDirectory(directory) {
  const root = await lstat(directory);
  assert(root.isDirectory() && !root.isSymbolicLink(), 'Driver root must be a regular directory, not a link');
  const files = [];
  for (const name of (await readdir(directory)).sort()) {
    assert(safeName(name), 'Driver filenames must use letters, digits, dot, underscore, plus or hyphen');
    const path = resolve(directory, name), info = await lstat(path);
    assert(info.isFile() && !info.isSymbolicLink(), 'Driver bundle must contain only regular files; directories and links are refused');
    const bytes = await readFile(path);
    files.push({ name, bytes: bytes.length, sha256: sha256(bytes) });
  }
  inventoryText(files);
  return files;
}

// Shared by node staging and the in-container before/after checks. No library bytes are logged.
export const inventoryShell = `digest() {
  checksum_result=$(sha256sum -- "$1") || return 42
  checksum_result=\${checksum_result%% *}
  case "$checksum_result" in ''|*[!a-f0-9]*) return 42;; esac
  [ "\${#checksum_result}" -eq 64 ] || return 42
  printf '%s\\n' "$checksum_result"
}
inventory() (
  directory=$1
  [ -d "$directory" ] && [ ! -L "$directory" ] || exit 42
  listing=$(mktemp) || exit 42
  trap 'rm -f -- "$listing"' EXIT
  for file in "$directory"/* "$directory"/.[!.]* "$directory"/..?*; do
    [ -e "$file" ] || [ -L "$file" ] || continue
    [ -f "$file" ] && [ ! -L "$file" ] || exit 42
    name=$(basename -- "$file")
    case "$name" in ''|.|..|*[!A-Za-z0-9_.+-]*) exit 42;; esac
    size=$(wc -c < "$file") || exit 42
    checksum=$(digest "$file") || exit 42
    printf '%s\\t%s\\t%s\\n' "$name" "$size" "$checksum" >> "$listing" || exit 42
  done
  LC_ALL=C sort "$listing"
)
`;

export function inputCheckScript({ driverPath = driverMount, queryPath = '/run/sql/abap-cds-odbc.sql', manifestPath = inputMount, messagePath = terminationPath } = {}) {
  return `#!/bin/sh
set -u
export LC_ALL=C
driver=${quote(driverPath)}
query=${quote(queryPath)}
manifest=${quote(manifestPath)}
message=${quote(messagePath)}
${inventoryShell}
role=$1
case "$role" in node|rust) ;; *) exit 86;; esac
input_id=$(cat "$manifest/input-id") || exit 86
case "$input_id" in ''|*[!a-f0-9]*) exit 86;; esac
[ "$(printf '%s' "$input_id" | wc -c)" -eq 64 ] || exit 86
before='null'
after='null'
client_code='null'
write_message() {
  printf '{"schema_version":1,"input_id":"%s","before":%s,"after":%s,"client_exit_code":%s}\\n' "$input_id" "$before" "$after" "$client_code" > "$message"
}
attest() {
  record='{"status":"failed","reason":"INPUT_CHECK_FAILED","driver_sha256":"","query_sha256":"","environment_sha256":"","script_sha256":""}'
  state=passed
  reason=OK
  driver_hash=''
  query_hash=''
  env_hash=''
  for required in run.sh driver-files.tsv query-sha256 "$role-env.tsv" script-sha256; do
    [ -f "$manifest/$required" ] || return 1
  done
  script_hash=$(digest "$manifest/run.sh") || return 1
  actual=$(mktemp) || return 1
  actual_env=$(mktemp) || { rm -f -- "$actual"; return 1; }
  if inventory "$driver" > "$actual"; then
    driver_hash=$(digest "$actual") || { rm -f -- "$actual" "$actual_env"; return 1; }
    if ! cmp -s "$actual" "$manifest/driver-files.tsv"; then state=failed; reason=DRIVER_TREE_MISMATCH; fi
  else state=failed; reason=UNSAFE_DRIVER_TREE; fi
  if [ -f "$query" ] && [ ! -L "$query" ]; then
    query_hash=$(digest "$query") || { rm -f -- "$actual" "$actual_env"; return 1; }
    expected_query=$(cat "$manifest/query-sha256") || { rm -f -- "$actual" "$actual_env"; return 1; }
    if [ "$query_hash" != "$expected_query" ]; then state=failed; reason=QUERY_MISMATCH; fi
  else state=failed; reason=UNSAFE_QUERY_FILE; fi
  while IFS="$(printf '\\t')" read -r name expected; do
    case "$name" in EXPECTED_DIGEST|EXPECTED_ROWS|LD_LIBRARY_PATH|MAX_PAGES|PAGE_SIZE|POLL_INTERVAL_MS|REQUEST_TIMEOUT_SECONDS|SAP_CLIENT|SCANS|SCAN_TIMEOUT_SECONDS|SQL_QUERY_FILE|SQL_TRANSPORT|UV_THREADPOOL_SIZE) ;;
      *) state=failed; reason=UNSAFE_ENVIRONMENT_MANIFEST; break;; esac
    value=$(printenv "$name") || { state=failed; reason=MISSING_ENVIRONMENT; break; }
    printf '%s\\t%s\\n' "$name" "$value" >> "$actual_env"
  done < "$manifest/$role-env.tsv"
  env_hash=$(digest "$actual_env") || { rm -f -- "$actual" "$actual_env"; return 1; }
  if ! cmp -s "$actual_env" "$manifest/$role-env.tsv"; then state=failed; reason=ENVIRONMENT_MISMATCH; fi
  expected_script=$(cat "$manifest/script-sha256") || { rm -f -- "$actual" "$actual_env"; return 1; }
  if [ "$script_hash" != "$expected_script" ]; then state=failed; reason=SCRIPT_MISMATCH; fi
  rm -f -- "$actual" "$actual_env"
  record=$(printf '{"status":"%s","reason":"%s","driver_sha256":"%s","query_sha256":"%s","environment_sha256":"%s","script_sha256":"%s"}' "$state" "$reason" "$driver_hash" "$query_hash" "$env_hash" "$script_hash")
  [ "$state" = passed ]
}
if attest; then before=$record; else before=$record; write_message; exit 86; fi
write_message || exit 86
finish() {
  client_code=$1
  if attest; then after=$record; else after=$record; client_code=86; fi
  write_message || exit 86
  exit "$client_code"
}
client_pid=''
trap 'trap - TERM INT; [ -z "$client_pid" ] || kill -TERM "$client_pid" 2>/dev/null; [ -z "$client_pid" ] || wait "$client_pid" 2>/dev/null; finish 143' TERM
trap 'trap - TERM INT; [ -z "$client_pid" ] || kill -INT "$client_pid" 2>/dev/null; [ -z "$client_pid" ] || wait "$client_pid" 2>/dev/null; finish 130' INT
if [ "$role" = node ]; then
  node --v8-pool-size=1 /app/src/sql-cli.mjs --transport odbc &
else
  sql-poller --transport odbc &
fi
client_pid=$!
wait "$client_pid"
code=$?
trap - TERM INT
finish "$code"
`;
}

export function environmentText(environment) {
  return Object.keys(environment).sort().map(key => {
    assert(/^[A-Z_]+$/.test(key) && typeof environment[key] === 'string' && !/[\0\r\n\t]/.test(environment[key]), 'Invalid public runtime environment');
    assert(key !== 'ABAP_ODBC_CONNECTION_STRING', 'Credentials must not enter public input digests');
    return `${key}\t${environment[key]}\n`;
  }).join('');
}

export function artifactInputs(runtime, images, files, script = inputCheckScript()) {
  const environment = { ...odbcEnvironment(runtime.settings, runtime.manifest) };
  delete environment.ABAP_ODBC_CONNECTION_STRING;
  const inventory = inventoryText(files), driverId = sha256(inventory);
  const envFiles = { node: environmentText({ ...environment, UV_THREADPOOL_SIZE: '1' }), rust: environmentText(environment) };
  const identity = { version: artifactVersion, driver_sha256: driverId, query_sha256: sha256(runtime.sql), environment,
    node_environment: { UV_THREADPOOL_SIZE: '1' }, address: runtime.address, certificate_host: sapCertificateHost,
    images: Object.fromEntries(['node', 'rust'].map(language => { assert(/^sha256:[a-f0-9]{64}$/.test(images[language]), 'Immutable Docker image identity required'); return [language, images[language]]; })),
    script_sha256: sha256(script), policy: { cpus: '1', memory: '256Mi', deadline: 150, uid: 10001, retries: 0, read_only: true, service_account_token: false } };
  const id = sha256(JSON.stringify(identity)), suffix = id.slice(0, 20);
  return { id, driverId, hostDirectory: `${bundleRoot}/${driverId}`, files, inventory, environment, envFiles, script, identity,
    names: { config: `cds-config-${suffix}`, query: `cds-query-${suffix}`, inputs: `cds-inputs-${suffix}`, credentialPrefix: `cds-credentials-${suffix}` } };
}

const metadata = (name, inputs) => ({ name, namespace, labels: { 'app.kubernetes.io/part-of': owner, 'sap-polling-lab/input-id': inputs.id.slice(0, 20) }, annotations: { 'sap-polling-lab/input-sha256': inputs.id } });
export function immutableConfigMaps(inputs, sql) {
  return [
    { apiVersion: 'v1', kind: 'ConfigMap', metadata: metadata(inputs.names.config, inputs), immutable: true, data: inputs.environment },
    { apiVersion: 'v1', kind: 'ConfigMap', metadata: metadata(inputs.names.query, inputs), immutable: true, data: { 'abap-cds-odbc.sql': sql } },
    { apiVersion: 'v1', kind: 'ConfigMap', metadata: metadata(inputs.names.inputs, inputs), immutable: true, data: {
      'run.sh': inputs.script, 'input-id': inputs.id, 'driver-files.tsv': inputs.inventory, 'query-sha256': inputs.identity.query_sha256,
      'node-env.tsv': inputs.envFiles.node, 'rust-env.tsv': inputs.envFiles.rust, 'script-sha256': inputs.identity.script_sha256,
    } },
  ];
}
export function credentialSecret(inputs, name, connection) {
  assert(name === inputs.names.credentialPrefix || name.startsWith(inputs.names.credentialPrefix + '-'), 'Invalid credential resource name');
  return { apiVersion: 'v1', kind: 'Secret', metadata: metadata(name, inputs), immutable: true, type: 'Opaque', data: { ABAP_ODBC_CONNECTION_STRING: Buffer.from(connection).toString('base64') } };
}
export function assertImmutableResource(actual, expected) {
  assert(actual?.metadata?.labels?.['app.kubernetes.io/part-of'] === owner && actual.metadata.annotations?.['sap-polling-lab/input-sha256'] === expected.metadata.annotations['sap-polling-lab/input-sha256'], 'Existing input resource is not owned by this lab/input version');
  assert.equal(actual.kind, expected.kind); assert.equal(actual.metadata.name, expected.metadata.name); assert.equal(actual.immutable, true, 'Input resource must be immutable');
  assert(isDeepStrictEqual(actual.data, expected.data) && (expected.type === undefined || actual.type === expected.type), 'Existing immutable input resource differs; preserve it and investigate');
  assert(!actual.binaryData || Object.keys(actual.binaryData).length === 0, 'Unexpected binary input data');
}

export function assertCdsParity(runtime, files, parity) {
  assert(parity?.all_passed === true && parity.transport === 'cds_odbc', 'Refresh complete Docker/ABAP CDS parity before configuring or checking Jobs');
  assert.equal(parity.expected_rows, runtime.manifest.expected_rows, 'Parity row count differs');
  assert.equal(parity.expected_digest, runtime.manifest.expected_digest, 'Parity digest differs');
  assert.equal(parity.query_sha256, sha256(runtime.sql), 'Parity query differs');
  assert.equal(inventoryText(parity.driver_files), inventoryText(files), 'Parity driver files differ; rerun Docker/ABAP CDS parity');
  const images = {};
  for (const language of ['node', 'rust']) {
    const implementation = parity.implementations?.[language];
    assert(implementation?.status === 'passed' && implementation.exit_code === 0 && !implementation.timed_out, 'Docker CDS client did not pass');
    const result = scanResult(implementation.result);
    assert(result.outcome === 'ok' && result.rows === runtime.manifest.expected_rows && result.digest === runtime.manifest.expected_digest && result.pages === 51 && result.metrics.body_bytes === 0, 'Docker CDS result differs from the frozen manifest');
    assert(/^sha256:[a-f0-9]{64}$/.test(implementation.image_id), 'Docker CDS image identity is missing');
    images[language] = implementation.image_id;
  }
  return images;
}

// All execution is inside this function; importing setup/verification never contacts SAP or Docker.
export async function loadArtifactContext({ run = invoke, runtime, files, parity } = {}) {
  runtime ??= await loadOdbcRuntime();
  files ??= await inventoryDirectory(driverDirectory);
  assert.equal(inventoryText(runtime.driver_files), inventoryText(files), 'Driver files changed while runtime inputs were loaded');
  parity ??= JSON.parse(await readFile(resolve(projectRoot, 'work/abap-odbc/parity.json'), 'utf8'));
  const images = assertCdsParity(runtime, files, parity), built = {}, loaded = {};
  for (const language of ['node', 'rust']) {
    const image = `sap-polling-${language}:sql-odbc`;
    const inspected = await run(dockerProgram, ['image', 'inspect', image]);
    assert(inspected.status === 0 && !inspected.timed_out && !inspected.oversized, 'Unable to inspect Docker CDS image');
    built[language] = JSON.parse(inspected.stdout)[0];
    assert.equal(built[language].Id, images[language], 'Docker image differs from the successful parity run');
    const nodeImage = await run(dockerProgram, ['exec', controlPlane, 'crictl', 'inspecti', image]);
    assert(nodeImage.status === 0 && !nodeImage.timed_out && !nodeImage.oversized, 'Load the parity-verified SQL images into the existing kind cluster first');
    loaded[language] = JSON.parse(nodeImage.stdout);
    assertRuntimeImage(built[language], loaded[language]);
  }
  return { runtime, files, parity, built, loaded, inputs: artifactInputs(runtime, images, files) };
}

export function cdsJob(language, inputs, secretName) {
  assert(['node', 'rust'].includes(language));
  const name = `poller-${language}-cds`;
  const spec = { restartPolicy: 'Never', automountServiceAccountToken: false, enableServiceLinks: false,
    hostAliases: [{ ip: inputs.identity.address, hostnames: [sapCertificateHost] }],
    securityContext: { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, seccompProfile: { type: 'RuntimeDefault' } },
    containers: [{ name: 'poller', image: `sap-polling-${language}:sql-odbc`, imagePullPolicy: 'Never', command: ['/bin/sh', `${inputMount}/run.sh`], args: [language],
      envFrom: [{ configMapRef: { name: inputs.names.config } }, { secretRef: { name: secretName } }],
      ...(language === 'node' ? { env: [{ name: 'UV_THREADPOOL_SIZE', value: '1' }] } : {}),
      volumeMounts: [{ name: 'query', mountPath: '/run/sql/abap-cds-odbc.sql', subPath: 'abap-cds-odbc.sql', readOnly: true }, { name: 'driver', mountPath: driverMount, readOnly: true }, { name: 'inputs', mountPath: inputMount, readOnly: true }, { name: 'scratch', mountPath: '/tmp' }],
      resources: { requests: { cpu: '1', memory: '256Mi' }, limits: { cpu: '1', memory: '256Mi' } },
      securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
      terminationMessagePath: terminationPath, terminationMessagePolicy: 'File',
    }],
    volumes: [{ name: 'query', configMap: { name: inputs.names.query, defaultMode: 292 } }, { name: 'driver', hostPath: { path: inputs.hostDirectory, type: 'Directory' } },
      { name: 'inputs', configMap: { name: inputs.names.inputs, defaultMode: 292 } }, { name: 'scratch', emptyDir: { medium: 'Memory', sizeLimit: '16Mi' } }],
  };
  return { apiVersion: 'batch/v1', kind: 'Job', metadata: metadata(name, inputs), spec: { suspend: true, backoffLimit: 0, completions: 1, parallelism: 1, activeDeadlineSeconds: 150,
    template: { metadata: { labels: { ...metadata(name, inputs).labels, 'app.kubernetes.io/name': name }, annotations: { 'sap-polling-lab/input-sha256': inputs.id } }, spec } } };
}

function normalizedPod(spec) {
  const value = structuredClone(spec);
  for (const [key, fallback] of Object.entries({ dnsPolicy: 'ClusterFirst', schedulerName: 'default-scheduler', serviceAccountName: 'default', serviceAccount: 'default', terminationGracePeriodSeconds: 30 })) if (value[key] === fallback) delete value[key];
  for (const key of ['nodeName', 'preemptionPolicy', 'priority']) delete value[key];
  if (Array.isArray(value.tolerations) && value.tolerations.every(item => ['node.kubernetes.io/not-ready', 'node.kubernetes.io/unreachable'].includes(item.key) && item.effect === 'NoExecute' && item.operator === 'Exists' && item.tolerationSeconds === 300)) delete value.tolerations;
  return value;
}
export function assertJobCompatible(actual, expected) {
  const action = `Existing ${expected.metadata.name} is incompatible. Preserve its Job/pod/logs, then explicitly recreate only that completed lab Job and rerun configuration.`;
  assert(actual?.metadata?.labels?.['app.kubernetes.io/part-of'] === owner, action);
  assert.equal(actual.spec.backoffLimit, expected.spec.backoffLimit, action); assert.equal(actual.spec.completions, 1, action); assert.equal(actual.spec.parallelism, 1, action); assert.equal(actual.spec.activeDeadlineSeconds, 150, action);
  assert.equal(actual.spec.template.metadata.annotations?.['sap-polling-lab/input-sha256'], expected.spec.template.metadata.annotations['sap-polling-lab/input-sha256'], action);
  assert(isDeepStrictEqual(normalizedPod(actual.spec.template.spec), normalizedPod(expected.spec.template.spec)), action);
}
export function assertPodCompatible(pod, expected) {
  assert.equal(pod.metadata.annotations?.['sap-polling-lab/input-sha256'], expected.spec.template.metadata.annotations['sap-polling-lab/input-sha256'], 'Executed pod input identity differs');
  assert(isDeepStrictEqual(normalizedPod(pod.spec), normalizedPod(expected.spec.template.spec)), 'Executed pod template differs from the input policy');
}

export function validateAttestation(message, inputs, language) {
  assert(typeof message === 'string' && Buffer.byteLength(message) <= 4096, 'Missing/oversized input attestation termination message');
  let record; try { record = JSON.parse(message); } catch { throw new Error('Incomplete input attestation termination message'); }
  assert.equal(record.schema_version, 1); assert.equal(record.input_id, inputs.id); assert.equal(record.client_exit_code, 0, 'Poller or input checks failed');
  for (const phase of ['before', 'after']) {
    const value = record[phase]; assert(value?.status === 'passed' && value.reason === 'OK', `Mounted input ${phase} attestation failed`);
    assert.equal(value.driver_sha256, inputs.driverId, 'Mounted driver inventory differs'); assert.equal(value.query_sha256, inputs.identity.query_sha256, 'Mounted query differs');
    assert.equal(value.environment_sha256, sha256(inputs.envFiles[language]), 'Executed public environment differs'); assert.equal(value.script_sha256, inputs.identity.script_sha256, 'Mounted wrapper differs');
  }
  return record;
}

export function runtimeConfiguration(value) { return { user: value.User ?? '', env: value.Env ?? [], entrypoint: value.Entrypoint ?? [], command: value.Cmd ?? [], working_directory: value.WorkingDir ?? '' }; }
export function assertRuntimeImage(built, loaded, podImageId) {
  assert.deepEqual(loaded.info.imageSpec.rootfs.diff_ids, built.RootFS.Layers, 'Loaded image filesystem differs');
  assert.deepEqual(runtimeConfiguration(loaded.info.imageSpec.config), runtimeConfiguration(built.Config), 'Loaded image configuration differs');
  if (podImageId) assert(loaded.status.repoDigests?.includes(podImageId) || loaded.status.id === podImageId.replace(/^containerd:\/\//, ''), 'Executed pod image differs from the loaded verified image');
}

export async function stageDriverBundle({ directory, files, run, node = controlPlane, nonce = randomUUID() }) {
  const expected = inventoryText(files), id = sha256(expected), target = `${bundleRoot}/${id}`, staging = `${bundleRoot}/.stage-${nonce}`;
  assert(/^[a-zA-Z0-9-]+$/.test(nonce));
  const inspect = path => run(['exec', '--interactive', node, '/bin/sh', '-s', '--', path], { input: `${inventoryShell}\nif [ ! -e "$1" ] && [ ! -L "$1" ]; then exit 44; fi\ninventory "$1"\n` });
  const before = await inspect(target);
  if (before.status === 0) { assert.equal(before.stdout, expected, 'Existing addressed driver bundle is corrupted; it will not be overwritten'); return { id, directory: target, reused: true }; }
  assert.equal(before.status, 44, 'Existing addressed driver bundle is unsafe or unreadable; it will not be overwritten');
  const commands = [
    ['exec', node, '/bin/sh', '-c', 'mkdir -p -- "$1" && [ -d "$1" ] && [ ! -L "$1" ] && mkdir -m 0755 -- "$2"', 'sh', bundleRoot, staging],
    ['cp', `${directory}/.`, `${node}:${staging}`],
  ];
  for (const args of commands) assert.equal((await run(args, { timeout: 90000 })).status, 0, 'Unable to stage a fresh driver bundle; existing versions remain untouched');
  const staged = await inspect(staging); assert.equal(staged.status, 0, 'Staged driver bundle contains unsafe files'); assert.equal(staged.stdout, expected, 'Staged driver bundle differs; it will not be published');
  assert.equal((await run(['exec', node, 'chmod', '0444', ...files.map(file => `${staging}/${file.name}`)])).status, 0, 'Unable to seal driver files');
  assert.equal((await run(['exec', node, 'chmod', '0555', staging])).status, 0, 'Unable to seal driver directory');
  assert.equal((await run(['exec', node, 'mv', '-T', '-n', '--', staging, target])).status, 0, 'Unable to publish driver bundle without clobbering');
  const published = await inspect(target); assert.equal(published.status, 0); assert.equal(published.stdout, expected, 'Published bundle differs; it will not be reused');
  return { id, directory: target, reused: false };
}
