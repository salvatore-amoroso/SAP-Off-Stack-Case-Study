import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { configureOdbcRuntime } from './configure-odbc-runtime.mjs';
import { checkCdsOdbcKubernetes } from '../../scripts/check-cds-odbc-kubernetes.mjs';
import { network } from './native-runtime.mjs';
import { odbcEnvironment } from './odbc-runtime.mjs';
import { artifactInputs, assertCdsParity, assertImmutableResource, assertJobCompatible, assertPodCompatible, bundleRoot, cdsJob, credentialSecret, immutableConfigMaps, inputCheckScript, inventoryDirectory, inventoryText, sha256, stageDriverBundle, validateAttestation } from './cds-artifacts.mjs';

// The real Job wrapper targets POSIX containers; Linux CI also exercises the shell and symlink cases.
const shell = process.platform === 'win32' ? null : '/bin/sh';
const unix = path => path.replaceAll('\\', '/');
const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
const fixtureResult = { schema_version: 1, scan_index: 0, outcome: 'ok', rows: 5000, pages: 51, digest: 'a'.repeat(64), error: null, metrics: { elapsed_ms: 1, body_bytes: 0, missed_slots: 0 } };
const fixtureFiles = [{ name: 'driver.so', bytes: 6, sha256: sha256('driver') }];
function fixtureContext() {
  const runtime = { settings: { local: true, client: '001', username: 'fixture-user', password: 'fixture-password' }, manifest: { expected_rows: 5000, expected_digest: fixtureResult.digest }, sql: 'SELECT fixture\n', address: '172.18.0.2', driver_files: fixtureFiles };
  const images = { node: `sha256:${'1'.repeat(64)}`, rust: `sha256:${'2'.repeat(64)}` };
  const inputs = artifactInputs(runtime, images, fixtureFiles);
  const parity = { transport: 'cds_odbc', all_passed: true, query_sha256: sha256(runtime.sql), expected_rows: 5000, expected_digest: fixtureResult.digest, driver_files: fixtureFiles,
    implementations: Object.fromEntries(['node', 'rust'].map(language => [language, { status: 'passed', exit_code: 0, timed_out: false, image_id: images[language], result: fixtureResult }])) };
  const built = {}, loaded = {};
  for (const language of ['node', 'rust']) {
    built[language] = { Id: images[language], RootFS: { Layers: ['sha256:fixture-layer'] }, Config: {} };
    loaded[language] = { info: { imageSpec: { rootfs: { diff_ids: ['sha256:fixture-layer'] }, config: {} } }, status: { id: images[language], repoDigests: [] } };
  }
  return { runtime, inputs, files: fixtureFiles, parity, built, loaded, images };
}
function attestation(inputs, language) {
  const phase = { status: 'passed', reason: 'OK', driver_sha256: inputs.driverId, query_sha256: inputs.identity.query_sha256, environment_sha256: sha256(inputs.envFiles[language]), script_sha256: inputs.identity.script_sha256 };
  return { schema_version: 1, input_id: inputs.id, before: { ...phase }, after: { ...phase }, client_exit_code: 0 };
}
const response = (stdout = '', status = 0) => ({ stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout), status, timed_out: false, oversized: false });

test('strict local inventory includes every file and refuses directories and links', async t => {
  const directory = await mkdtemp(resolve(tmpdir(), 'cds-inventory-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  await writeFile(resolve(directory, 'driver.so'), 'driver');
  await writeFile(resolve(directory, '.companion'), 'extra');
  assert.equal((await inventoryDirectory(directory)).length, 2);
  await mkdir(resolve(directory, 'nested'));
  await assert.rejects(inventoryDirectory(directory), /only regular files/);
  await rm(resolve(directory, 'nested'), { recursive: true });
  try { await symlink(resolve(directory, 'driver.so'), resolve(directory, 'link.so')); }
  catch (error) { if (error.code === 'EPERM' && process.platform === 'win32') return; throw error; }
  await assert.rejects(inventoryDirectory(directory), /only regular files/);
  assert.throws(() => inventoryText([...fixtureFiles, fixtureFiles[0]]), /Duplicate/);
  assert.throws(() => inventoryText([{ ...fixtureFiles[0], name: '../driver.so' }]), /Invalid/);
});

test('staging uses a fresh addressed path and verifies complete inventory before publication', async () => {
  const expected = inventoryText(fixtureFiles), calls = [], inspections = [response('', 44), response(expected), response(expected)];
  const staged = await stageDriverBundle({ directory: '/private/driver', files: fixtureFiles, nonce: 'fixture-fresh', run: async (args, options) => {
    calls.push({ args, options });
    return args.includes('--interactive') ? inspections.shift() : response();
  } });
  assert.equal(staged.directory, `${bundleRoot}/${sha256(expected)}`);
  assert.equal(staged.reused, false);
  const copied = calls.find(call => call.args[0] === 'cp').args;
  assert(copied[2].endsWith('/.stage-fixture-fresh'));
  assert(calls.some(call => call.args.includes('mv') && call.args.includes('-T') && call.args.includes('-n')));
  assert(!calls.some(call => call.args.includes('rm') || call.args.includes('/opt/sap/abap-odbc')));
  assert.equal(inspections.length, 0);
});

test('reuse verifies exact files; changed, missing, extra and unsafe trees are never overwritten', async () => {
  const expected = inventoryText(fixtureFiles);
  for (const [status, text] of [[0, expected], [0, ''], [0, expected + 'retired.so\t1\t' + 'f'.repeat(64) + '\n'], [0, expected.replace(fixtureFiles[0].sha256, 'b'.repeat(64))], [42, '']]) {
    const calls = [], run = async args => { calls.push(args); return response(text, status); };
    if (status === 0 && text === expected) assert.equal((await stageDriverBundle({ directory: '/private/driver', files: fixtureFiles, run })).reused, true);
    else await assert.rejects(stageDriverBundle({ directory: '/private/driver', files: fixtureFiles, run }), /will not be overwritten/);
    assert.equal(calls.length, 1);
  }
  for (const staged of [response(''), response(expected + 'extra'), response('', 42)]) {
    const calls = [], inspections = [response('', 44), staged];
    await assert.rejects(stageDriverBundle({ directory: '/private/driver', files: fixtureFiles, run: async args => {
      calls.push(args); return args.includes('--interactive') ? inspections.shift() : response();
    } }), /Staged driver bundle/);
    assert(!calls.some(args => args.includes('mv')));
  }
});

test('public identity excludes credentials and binds query, files, image, route and environment', () => {
  const { runtime, images, inputs } = fixtureContext();
  assert(!JSON.stringify(inputs).includes('fixture-password'));
  assert.equal(artifactInputs({ ...runtime, settings: { ...runtime.settings, password: 'rotated' } }, images, fixtureFiles).id, inputs.id);
  for (const changed of [{ ...runtime, sql: runtime.sql + '--changed' }, { ...runtime, address: '172.18.0.3' }, { ...runtime, manifest: { ...runtime.manifest, expected_rows: 4999 } }]) assert.notEqual(artifactInputs(changed, images, fixtureFiles).id, inputs.id);
  assert.notEqual(artifactInputs(runtime, { ...images, rust: `sha256:${'3'.repeat(64)}` }, fixtureFiles).id, inputs.id);
  assert.notEqual(artifactInputs(runtime, images, [{ ...fixtureFiles[0], sha256: 'c'.repeat(64) }]).id, inputs.id);
});

test('immutable resources and Job policy refuse changed content or legacy templates', () => {
  const { runtime, inputs } = fixtureContext();
  const map = immutableConfigMaps(inputs, runtime.sql)[1];
  assertImmutableResource(structuredClone(map), map);
  for (const changed of [{ ...map, immutable: false }, { ...map, data: { 'abap-cds-odbc.sql': 'wrong' } }, { ...map, binaryData: { extra: 'YQ==' } }]) assert.throws(() => assertImmutableResource(changed, map));
  const job = cdsJob('node', inputs, inputs.names.credentialPrefix), actual = structuredClone(job);
  Object.assign(actual.spec.template.spec, { serviceAccountName: 'default', serviceAccount: 'default', dnsPolicy: 'ClusterFirst', schedulerName: 'default-scheduler', terminationGracePeriodSeconds: 30 });
  assertJobCompatible(actual, job);
  const pod = { metadata: structuredClone(job.spec.template.metadata), spec: structuredClone(actual.spec.template.spec) };
  pod.spec.nodeName = 'kind-control-plane';
  pod.spec.tolerations = [{ key: 'node.kubernetes.io/not-ready', operator: 'Exists', effect: 'NoExecute', tolerationSeconds: 300 }];
  assertPodCompatible(pod, job);
  const query = actual.spec.template.spec.containers[0].volumeMounts.find(mount => mount.name === 'query');
  assert.equal(query.subPath, 'abap-cds-odbc.sql');
  actual.spec.template.spec.volumes.find(volume => volume.name === 'driver').hostPath.path = '/opt/sap/abap-odbc';
  assert.throws(() => assertJobCompatible(actual, job), /Preserve its Job\/pod\/logs/);
  assert.throws(() => assertCdsParity(runtime, [{ ...fixtureFiles[0], sha256: 'b'.repeat(64) }], fixtureContext().parity), /Parity driver files differ/);
});

test('incompatible existing Job fails before staging or any API write', async () => {
  const context = fixtureContext(), calls = [];
  await assert.rejects(configureOdbcRuntime({ context, run: async (program, args) => {
    calls.push(args);
    if (args[0] === 'inspect') return response({ [network]: { IPAddress: '172.18.0.3' } });
    const action = args.slice(args.indexOf('--namespace') + 2);
    if (action[0] === 'get' && action[1] === 'job') return response({ metadata: { labels: { 'app.kubernetes.io/part-of': 'sap-order-polling-lab' } }, spec: { template: { spec: { containers: [{ envFrom: [] }] } } } });
    if (action[0] === 'get' && action[1] === 'secrets') return response({ items: [] });
    throw new Error('Unexpected mutation');
  } }), /incompatible/);
  assert(!calls.some(args => args.includes('create') || args.includes('apply') || args.includes('exec') || args[0] === 'cp'));
});

test('attestation needs both actual digests, bounded intact JSON and a successful client', () => {
  const { inputs } = fixtureContext(), record = attestation(inputs, 'node');
  assert(Buffer.byteLength(JSON.stringify(record)) < 4096);
  validateAttestation(JSON.stringify(record), inputs, 'node');
  for (const mutate of [value => { value.after = null; }, value => { value.before.driver_sha256 = 'b'.repeat(64); }, value => { value.after.query_sha256 = 'b'.repeat(64); }, value => { value.client_exit_code = 1; }]) {
    const changed = structuredClone(record); mutate(changed);
    assert.throws(() => validateAttestation(JSON.stringify(changed), inputs, 'node'));
  }
  assert.throws(() => validateAttestation(JSON.stringify(record).slice(0, -10), inputs, 'node'), /Incomplete/);
  assert.throws(() => validateAttestation(' '.repeat(4097), inputs, 'node'), /oversized/);
});

async function shellFixture(t, { role = 'node', child = '', before = async () => {} } = {}) {
  const directory = await mkdtemp(resolve(tmpdir(), 'cds-attestation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const paths = Object.fromEntries(['driver', 'manifest', 'query.sql', 'termination.json', 'client.sh'].map(name => [name, unix(resolve(directory, name))]));
  await mkdir(paths.driver); await mkdir(paths.manifest);
  await writeFile(resolve(paths.driver, 'driver.so'), 'driver');
  const context = fixtureContext();
  await writeFile(paths['query.sql'], context.runtime.sql);
  await writeFile(paths['client.sh'], `#!/bin/sh\n${child.replaceAll('DRIVER_FILE', quote(`${paths.driver}/driver.so`)).replaceAll('QUERY_FILE', quote(paths['query.sql']))}\nprintf '%s\\n' '${JSON.stringify(fixtureResult)}'\n`);
  const script = inputCheckScript({ driverPath: paths.driver, queryPath: paths['query.sql'], manifestPath: paths.manifest, messagePath: paths['termination.json'] })
    .replace('node --v8-pool-size=1 /app/src/sql-cli.mjs --transport odbc', `sh ${quote(paths['client.sh'])}`)
    .replace('sql-poller --transport odbc', `sh ${quote(paths['client.sh'])}`);
  const inputs = artifactInputs(context.runtime, context.images, fixtureFiles, script);
  for (const [name, value] of Object.entries(immutableConfigMaps(inputs, context.runtime.sql)[2].data)) await writeFile(resolve(paths.manifest, name), value);
  await before(paths);
  const environment = { ...process.env, ...inputs.environment, ...(role === 'node' ? { UV_THREADPOOL_SIZE: '1' } : {}) };
  const executed = spawnSync(shell, [unix(resolve(paths.manifest, 'run.sh')), role], { env: environment, encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert(!executed.error, executed.error?.message);
  assert(existsSync(paths['termination.json']), `No termination file (exit ${executed.status}): ${executed.stderr}`);
  const message = await readFile(paths['termination.json'], 'utf8');
  return { executed, message, record: JSON.parse(message), inputs, paths };
}

test('real POSIX wrapper preserves exactly one JSON stdout scan and attests both client roles', { skip: !shell }, async t => {
  for (const role of ['node', 'rust']) {
    const result = await shellFixture(t, { role });
    assert.equal(result.executed.status, 0, result.executed.stderr);
    assert.equal(result.executed.stderr, '');
    assert.equal(result.executed.stdout, JSON.stringify(fixtureResult) + '\n');
    validateAttestation(result.message, result.inputs, role);
    assert(result.message.length < 4096);
  }
});

test('real POSIX wrapper blocks extra/missing/changed inputs before invoking the client', { skip: !shell }, async t => {
  for (const before of [
    paths => writeFile(resolve(paths.driver, 'retired.so'), 'extra'),
    paths => rm(resolve(paths.driver, 'driver.so')),
    paths => writeFile(resolve(paths.driver, 'driver.so'), 'changed'),
    paths => writeFile(paths['query.sql'], 'changed'),
    paths => mkdir(resolve(paths.driver, 'nested')),
  ]) {
    const result = await shellFixture(t, { before });
    assert.equal(result.executed.status, 86, result.executed.stderr);
    assert.equal(result.executed.stdout, '');
    assert.equal(result.record.before.status, 'failed');
    assert.equal(result.record.after, null);
  }
});

test('real POSIX wrapper detects actual mutations after the client and preserves client failures', { skip: !shell }, async t => {
  for (const child of ["printf changed > DRIVER_FILE", "printf changed > QUERY_FILE"]) {
    const result = await shellFixture(t, { child });
    assert.equal(result.executed.status, 86, result.executed.stderr);
    assert.equal(result.record.before.status, 'passed');
    assert.equal(result.record.after.status, 'failed');
    assert.throws(() => validateAttestation(result.message, result.inputs, 'node'));
  }
  const failed = await shellFixture(t, { child: 'exit 7' });
  assert.equal(failed.executed.status, 7);
  assert.equal(failed.record.before.status, 'passed');
  assert.equal(failed.record.after.status, 'passed');
  assert.equal(failed.record.client_exit_code, 7);
});

test('real POSIX inventory rejects symlinks without leaking file content', { skip: !shell || process.platform === 'win32' }, async t => {
  const result = await shellFixture(t, { before: async paths => {
    await rm(resolve(paths.driver, 'driver.so'));
    await symlink(paths['query.sql'], resolve(paths.driver, 'driver.so'));
  } });
  assert.equal(result.executed.status, 86);
  assert.equal(result.record.before.status, 'failed');
  assert.equal(result.executed.stdout, '');
  assert(!result.message.includes('SELECT fixture'));
  const queryLink = await shellFixture(t, { before: async paths => {
    await rm(paths['query.sql']);
    await symlink(resolve(paths.driver, 'driver.so'), paths['query.sql']);
  } });
  assert.equal(queryLink.executed.status, 86);
});

test('verifier binds actual pod, immutable inputs, image and before/after evidence', async () => {
  const context = fixtureContext(), secretName = context.inputs.names.credentialPrefix;
  const resources = new Map(immutableConfigMaps(context.inputs, context.runtime.sql).map(resource => [resource.metadata.name, resource]));
  resources.set(secretName, credentialSecret(context.inputs, secretName, odbcEnvironment(context.runtime.settings, context.runtime.manifest).ABAP_ODBC_CONNECTION_STRING));
  const jobs = {}, pods = {};
  for (const language of ['node', 'rust']) {
    const job = cdsJob(language, context.inputs, secretName), name = job.metadata.name;
    job.metadata.uid = `job-${language}`;
    job.status = { succeeded: 1, conditions: [{ type: 'Complete', status: 'True' }] };
    jobs[name] = job;
    pods[name] = { metadata: { ...structuredClone(job.spec.template.metadata), name: `pod-${language}`, uid: `pod-uid-${language}`, ownerReferences: [{ kind: 'Job', name, uid: job.metadata.uid, controller: true }] }, spec: structuredClone(job.spec.template.spec),
      status: { phase: 'Succeeded', containerStatuses: [{ name: 'poller', imageID: context.images[language], restartCount: 0, state: { terminated: { exitCode: 0, message: JSON.stringify(attestation(context.inputs, language)) } } }] } };
  }
  const run = async (program, args) => {
    const action = args.slice(args.indexOf('--namespace') + 2);
    if (action[0] === 'logs') return response(fixtureResult);
    if (action[1] === 'configmap' || action[1] === 'secret') return response(resources.get(action[2]));
    if (action[1] === 'job') return response(jobs[action[2]]);
    if (action[1] === 'pods') return response({ items: [pods[action[3].slice('job-name='.length)]] });
    throw new Error('Unexpected read');
  };
  assert.equal((await checkCdsOdbcKubernetes({ context, run })).all_passed, true);
  for (const mutate of [
    pod => { pod.status.containerStatuses[0].state.terminated.message = '{}'; },
    pod => { pod.spec.volumes.find(volume => volume.name === 'driver').hostPath.path = '/opt/sap/abap-odbc'; },
    pod => { pod.status.containerStatuses[0].imageID = `sha256:${'f'.repeat(64)}`; },
  ]) {
    const original = structuredClone(pods['poller-node-cds']);
    mutate(pods['poller-node-cds']);
    await assert.rejects(checkCdsOdbcKubernetes({ context, run }));
    pods['poller-node-cds'] = original;
  }
  const query = resources.get(context.inputs.names.query);
  query.data['abap-cds-odbc.sql'] = 'changed';
  await assert.rejects(checkCdsOdbcKubernetes({ context, run }), /immutable input resource differs/);
});
