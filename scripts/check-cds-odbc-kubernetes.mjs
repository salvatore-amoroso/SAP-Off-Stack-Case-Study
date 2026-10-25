import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dockerProgram, functional, invoke, kubectlArguments, namespace, projectRoot, scanResult } from '../deploy/sql/native-runtime.mjs';
import { odbcEnvironment } from '../deploy/sql/odbc-runtime.mjs';
import { assertImmutableResource, assertJobCompatible, assertPodCompatible, assertRuntimeImage, cdsJob, credentialSecret, immutableConfigMaps, loadArtifactContext, runtimeConfiguration, sha256, validateAttestation } from '../deploy/sql/cds-artifacts.mjs';

export async function checkCdsOdbcKubernetes({ run = invoke, context } = {}) {
  const { runtime, files, parity, inputs, built, loaded } = context ?? await loadArtifactContext({ run });
  const kubectl = process.env.KUBECTL_EXE || 'kubectl';
  const readResource = async args => {
    const response = await run(kubectl, [...kubectlArguments, ...args]);
    assert(response.status === 0 && !response.timed_out && !response.oversized, 'Unable to read bounded Kubernetes evidence');
    return response.stdout;
  };
  const resourceIdentity = value => ({ name: value.metadata.name, uid: value.metadata.uid, resource_version: value.metadata.resourceVersion });
  const configmaps = [];
  for (const expected of immutableConfigMaps(inputs, runtime.sql)) {
    const actual = JSON.parse(await readResource(['get', 'configmap', expected.metadata.name, '-o', 'json']));
    assertImmutableResource(actual, expected);
    configmaps.push(resourceIdentity(actual));
  }
  const jobs = {};
  for (const language of ['node', 'rust']) {
    const name = `poller-${language}-cds`;
    const job = JSON.parse(await readResource(['get', 'job', name, '-o', 'json']));
    const pods = JSON.parse(await readResource(['get', 'pods', '-l', `job-name=${name}`, '-o', 'json'])).items;
    assert.equal(job.status.succeeded, 1, 'CDS Job has not succeeded');
    assert(job.status.conditions?.some(item => item.type === 'Complete' && item.status === 'True'), 'CDS Job is not complete');
    assert.equal(pods.length, 1, 'Expected exactly one CDS execution pod');
    const pod = pods[0];
    assert(pod.metadata.ownerReferences?.some(owner => owner.uid === job.metadata.uid && owner.name === name && owner.kind === 'Job' && owner.controller === true), 'CDS pod is not controlled by this Job');
    assert.equal(pod.status.phase, 'Succeeded');
    assert.equal(pod.status.containerStatuses?.length, 1);
    const status = pod.status.containerStatuses[0];
    assert.equal(status.name, 'poller');
    assert.equal(status.state.terminated?.exitCode, 0);
    assert.equal(status.restartCount, 0);

    const container = pod.spec.containers[0];
    const secretName = container.envFrom?.find(source => source.secretRef)?.secretRef.name;
    const expectedSecret = credentialSecret(inputs, secretName, odbcEnvironment(runtime.settings, runtime.manifest).ABAP_ODBC_CONNECTION_STRING);
    const actualSecret = JSON.parse(await readResource(['get', 'secret', secretName, '-o', 'json']));
    assertImmutableResource(actualSecret, expectedSecret);
    const expectedJob = cdsJob(language, inputs, secretName);
    assertJobCompatible(job, expectedJob);
    assertPodCompatible(pod, expectedJob);
    assertRuntimeImage(built[language], loaded[language], status.imageID);
    const attestation = validateAttestation(status.state.terminated.message, inputs, language);
    const result = scanResult(await readResource(['logs', pod.metadata.name, '--container', 'poller']));
    assert.deepEqual(functional(result), functional(parity.implementations[language].result), 'Kubernetes result differs from verified Docker execution');
    assert.equal(result.metrics.body_bytes, 0);
    jobs[language] = {
      name, uid: job.metadata.uid, pod: pod.metadata.name, pod_uid: pod.metadata.uid, phase: pod.status.phase,
      started_at: status.state.terminated.startedAt, finished_at: status.state.terminated.finishedAt,
      exit_code: 0, image: container.image, image_id: status.imageID,
      docker_image_id: built[language].Id, runtime_image_id: loaded[language].status.id,
      filesystem_layers_sha256: sha256(JSON.stringify(built[language].RootFS.Layers)),
      runtime_configuration_sha256: sha256(JSON.stringify(runtimeConfiguration(built[language].Config))),
      verified_runtime_matches_docker_build: true, verified_executed_input_template: true,
      resources: container.resources, host_aliases: pod.spec.hostAliases,
      credential_secret: resourceIdentity(actualSecret),
      read_only_driver_and_query: true, read_only_root_filesystem: true,
      input_attestation: attestation, input_attestation_bytes: Buffer.byteLength(status.state.terminated.message),
      result, passed: true,
    };
  }
  return { schema_version: 2, observed_at: new Date().toISOString(), namespace, input_id: inputs.id,
    query_sha256: inputs.identity.query_sha256, driver_inventory_sha256: inputs.driverId,
    driver_directory_on_node: inputs.hostDirectory, driver_files: files, immutable_configmaps: configmaps,
    expected_rows: parity.expected_rows, expected_digest: parity.expected_digest,
    jobs, matches_docker_functional_results: true, mounted_inputs_verified_before_and_after: true, all_passed: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    assert.equal(process.argv.length, 2, 'Unexpected verification arguments');
    const report = await checkCdsOdbcKubernetes();
    await writeFile(resolve(projectRoot, 'work/abap-odbc/kubernetes-verification.json'), `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch {
    process.stderr.write('CDS ODBC Kubernetes verification failed. Require the current immutable Job inputs, successful Docker parity, and complete before/after mounted-input termination attestations.\n');
    process.exitCode = 1;
  }
}
