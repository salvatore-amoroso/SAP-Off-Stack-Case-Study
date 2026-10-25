import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { controlPlane, kubectlArguments, namespace, network } from './native-runtime.mjs';
import { dockerProgram, driverDirectory, invoke, odbcDirectory, odbcEnvironment, sapCertificateHost } from './odbc-runtime.mjs';
import { assertImmutableResource, assertJobCompatible, cdsJob, credentialSecret, immutableConfigMaps, loadArtifactContext, stageDriverBundle } from './cds-artifacts.mjs';

export async function configureOdbcRuntime({ run = invoke, context, onStage = () => {} } = {}) {
  onStage('load_runtime');
  const { runtime, files, inputs } = context ?? await loadArtifactContext({ run });
  const kubectl = process.env.KUBECTL_EXE || 'kubectl';
  const execute = async (program, args, options) => {
    const response = await run(program, args, options);
    assert(!response.timed_out && !response.oversized, 'Runtime command exceeded its bound');
    return response;
  };
  const kube = (args, options) => execute(kubectl, [...kubectlArguments, ...args], options);
  const get = async (kind, name) => {
    const response = await kube(['get', kind, name, '--ignore-not-found', '-o', 'json']);
    assert.equal(response.status, 0, 'Unable to inspect runtime resource');
    return response.stdout.trim() ? JSON.parse(response.stdout) : null;
  };
  const inspected = await execute(dockerProgram, ['inspect', '--format', '{{json .NetworkSettings.Networks}}', controlPlane]);
  assert(inspected.status === 0 && JSON.parse(inspected.stdout)[network]?.IPAddress, 'The existing kind node must already share the SAP network');

  onStage('check_existing_jobs');
  const existingJobs = {};
  for (const language of ['node', 'rust']) existingJobs[language] = await get('job', `poller-${language}-cds`);
  const credentials = await kube(['get', 'secrets', '-l', `app.kubernetes.io/part-of=sap-order-polling-lab,sap-polling-lab/input-id=${inputs.id.slice(0, 20)}`, '-o', 'json']);
  assert.equal(credentials.status, 0, 'Unable to inspect immutable credential resources');
  const connection = odbcEnvironment(runtime.settings, runtime.manifest).ABAP_ODBC_CONNECTION_STRING;
  const candidates = JSON.parse(credentials.stdout).items.filter(item => {
    const name = item.metadata?.name;
    if (name !== inputs.names.credentialPrefix && !name?.startsWith(inputs.names.credentialPrefix + '-')) return false;
    const expected = credentialSecret(inputs, name, connection);
    return item.immutable === true && item.type === 'Opaque' && item.metadata.annotations?.['sap-polling-lab/input-sha256'] === inputs.id && isDeepStrictEqual(item.data, expected.data);
  });
  // Credential revisions are opaque names. Passwords never enter public input hashes or disk proofs.
  const preferred = Object.values(existingJobs).map(job => job?.spec.template.spec.containers[0].envFrom?.find(source => source.secretRef)?.secretRef.name);
  candidates.sort((a, b) => Number(preferred.includes(b.metadata.name)) - Number(preferred.includes(a.metadata.name)) || a.metadata.name.localeCompare(b.metadata.name));
  const secretName = candidates[0]?.metadata.name ?? `${inputs.names.credentialPrefix}-${randomUUID().slice(0, 8)}`;
  const secret = credentialSecret(inputs, secretName, connection);
  const jobs = ['node', 'rust'].map(language => {
    const job = cdsJob(language, inputs, secretName);
    if (existingJobs[language]) assertJobCompatible(existingJobs[language], job);
    return job;
  });

  onStage('check_immutable_inputs');
  const resources = [...immutableConfigMaps(inputs, runtime.sql), secret];
  const existingResources = [];
  for (const expected of resources) {
    const actual = await get(expected.kind, expected.metadata.name);
    if (actual) assertImmutableResource(actual, expected);
    existingResources.push(actual);
  }
  onStage('stage_driver');
  const staged = await stageDriverBundle({ directory: driverDirectory, files, run: (args, options) => execute(dockerProgram, args, options) });
  assert.equal(staged.directory, inputs.hostDirectory, 'Staged driver identity differs');

  onStage('publish_immutable_inputs');
  for (let index = 0; index < resources.length; index++) {
    if (existingResources[index]) continue;
    const expected = resources[index];
    const created = await kube(['create', '-f', '-'], { input: JSON.stringify(expected), timeout: 60000 });
    if (created.status !== 0) {
      const actual = await get(expected.kind, expected.metadata.name);
      assert(actual, 'Unable to create immutable runtime input');
      assertImmutableResource(actual, expected);
    }
  }
  onStage('create_jobs');
  for (const job of jobs) {
    if (existingJobs[job.metadata.name.includes('-node-') ? 'node' : 'rust']) continue;
    const created = await kube(['create', '-f', '-'], { input: JSON.stringify(job) });
    if (created.status !== 0) {
      const actual = await get('job', job.metadata.name);
      assert(actual, 'Unable to create suspended CDS Job');
      assertJobCompatible(actual, job);
    }
  }
  await mkdir(odbcDirectory, { recursive: true });
  await writeFile(resolve(odbcDirectory, 'jobs.json'), `${JSON.stringify({ apiVersion: 'v1', kind: 'List', items: jobs }, null, 2)}\n`);
  const proof = { schema_version: 2, configured_at: new Date().toISOString(), namespace, control_plane: controlPlane,
    input_id: inputs.id, query_sha256: inputs.identity.query_sha256, driver_inventory_sha256: inputs.driverId,
    certificate_host: sapCertificateHost, sap_address: runtime.address, driver_directory_on_node: staged.directory,
    driver_bundle_reused: staged.reused, driver_files: files, immutable_configmaps: [inputs.names.config, inputs.names.query, inputs.names.inputs],
    credential_secret: secretName, image_ids: inputs.identity.images, wrapper_sha256: inputs.identity.script_sha256,
    jobs: jobs.map(job => job.metadata.name), new_jobs_suspended: true, termination_message_path: '/dev/termination-log' };
  await writeFile(resolve(odbcDirectory, 'kubernetes-configuration.json'), `${JSON.stringify(proof, null, 2)}\n`);
  return proof;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let stage = 'arguments';
  try {
    assert.equal(process.argv.length, 2, 'Unexpected configuration arguments');
    const proof = await configureOdbcRuntime({ onStage: value => { stage = value; } });
    process.stdout.write(`${JSON.stringify(proof, null, 2)}\n`);
  } catch {
    const action = stage === 'check_existing_jobs' ? 'Preserve the existing CDS Job/pod/logs. If a Job is incompatible, explicitly recreate only that completed lab Job before retrying. Active Jobs are never reset.'
      : stage === 'stage_driver' ? 'Inspect the addressed bundle/staging directory. A changed, unsafe or corrupted bundle is never overwritten; retain old versions and correct local inputs before retrying.'
      : 'Refresh successful Docker/ABAP CDS parity and load those exact SQL images into the existing kind cluster. Existing immutable inputs are never overwritten.';
    process.stderr.write(`${JSON.stringify({ error: 'Unable to configure CDS ODBC Jobs', stage, action })}\n`);
    process.exitCode = 1;
  }
}
