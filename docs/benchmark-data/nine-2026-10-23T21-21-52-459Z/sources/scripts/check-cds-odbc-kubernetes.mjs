import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { controlPlane, dockerProgram, functional, invoke, kubectlArguments, namespace, projectRoot, scanResult } from '../deploy/sql/native-runtime.mjs';

const kubectl = process.env.KUBECTL_EXE || 'kubectl';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const configuration = value => ({ user: value.User ?? '', env: value.Env ?? [], entrypoint: value.Entrypoint ?? [], command: value.Cmd ?? [], working_directory: value.WorkingDir ?? '' });
async function readResource(args) {
  const response = await invoke(kubectl, [...kubectlArguments, ...args]);
  assert.equal(response.status, 0);
  assert.equal(response.timed_out, false);
  assert.equal(response.oversized, false);
  return response.stdout;
}

async function check() {
  assert.equal(process.argv.length, 2);
  const parity = JSON.parse(await readFile(resolve(projectRoot, 'work/abap-odbc/parity.json'), 'utf8'));
  assert.equal(parity.all_passed, true);
  const query = JSON.parse(await readResource(['get', 'configmap', 'cds-odbc-query', '-o', 'json']));
  assert.equal(createHash('sha256').update(query.data['abap-cds-odbc.sql']).digest('hex'), parity.query_sha256);
  const jobs = {};
  for (const language of ['node', 'rust']) {
    const name = `poller-${language}-cds`;
    const job = JSON.parse(await readResource(['get', 'job', name, '-o', 'json']));
    const pods = JSON.parse(await readResource(['get', 'pods', '-l', `job-name=${name}`, '-o', 'json'])).items;
    assert.equal(job.metadata.labels['app.kubernetes.io/part-of'], 'sap-order-polling-lab');
    assert.equal(job.status.succeeded, 1);
    assert.equal(job.status.conditions.some(item => item.type === 'Complete' && item.status === 'True'), true);
    assert.equal(pods.length, 1);
    const pod = pods[0];
    assert.equal(pod.metadata.ownerReferences.some(owner => owner.uid === job.metadata.uid && owner.kind === 'Job'), true);
    assert.equal(pod.status.phase, 'Succeeded');
    assert.equal(pod.status.containerStatuses.length, 1);
    const status = pod.status.containerStatuses[0];
    assert.equal(status.state.terminated.exitCode, 0);
    assert.equal(status.restartCount, 0);
    const container = pod.spec.containers[0];
    assert.equal(container.image, `sap-polling-${language}:sql-odbc`);
    const dockerImage = await invoke(dockerProgram, ['image', 'inspect', container.image]);
    assert.equal(dockerImage.status, 0);
    const built = JSON.parse(dockerImage.stdout)[0];
    assert.equal(built.Id, parity.implementations[language].image_id);
    const nodeImage = await invoke(dockerProgram, ['exec', controlPlane, 'crictl', 'inspecti', container.image]);
    assert.equal(nodeImage.status, 0);
    const loaded = JSON.parse(nodeImage.stdout);
    // kind may rewrite a manifest; compare immutable filesystem layers and runtime configuration too.
    assert.deepEqual(loaded.info.imageSpec.rootfs.diff_ids, built.RootFS.Layers);
    assert.deepEqual(configuration(loaded.info.imageSpec.config), configuration(built.Config));
    assert.equal(loaded.status.repoDigests?.includes(status.imageID) || loaded.status.id === status.imageID.replace(/^containerd:\/\//, ''), true);
    assert.equal(container.resources.limits.cpu, '1');
    assert.equal(container.resources.limits.memory, '256Mi');
    assert.equal(container.securityContext.readOnlyRootFilesystem, true);
    assert.equal(container.securityContext.allowPrivilegeEscalation, false);
    assert.equal(pod.spec.automountServiceAccountToken, false);
    for (const volume of ['driver', 'query']) assert.equal(container.volumeMounts.find(mount => mount.name === volume)?.readOnly, true);
    assert.equal(container.volumeMounts.find(mount => mount.name === 'query').mountPath, '/run/sql');
    assert.equal(container.volumeMounts.find(mount => mount.name === 'driver').mountPath, '/opt/sap/abap-odbc');
    assert.equal(pod.spec.volumes.find(volume => volume.name === 'query').configMap.name, 'cds-odbc-query');
    assert.equal(pod.spec.volumes.find(volume => volume.name === 'driver').hostPath.path, '/opt/sap/abap-odbc');
    assert.equal(container.envFrom.some(source => source.secretRef?.name === 'cds-odbc-credentials'), true);
    const result = scanResult(await readResource(['logs', pod.metadata.name]));
    assert.deepEqual(functional(result), functional(parity.implementations[language].result));
    assert.equal(result.metrics.body_bytes, 0);
    jobs[language] = {
      name, uid: job.metadata.uid, pod: pod.metadata.name, phase: pod.status.phase,
      started_at: status.state.terminated.startedAt, finished_at: status.state.terminated.finishedAt,
      exit_code: 0, image: container.image, image_id: status.imageID,
      docker_image_id: built.Id, runtime_image_id: loaded.status.id,
      filesystem_layers_sha256: hash(built.RootFS.Layers), runtime_configuration_sha256: hash(configuration(built.Config)),
      verified_runtime_matches_docker_build: true,
      resources: container.resources, host_aliases: pod.spec.hostAliases,
      read_only_driver_and_query: true, read_only_root_filesystem: true,
      result, passed: true,
    };
  }
  const report = { schema_version: 1, observed_at: new Date().toISOString(), namespace,
    query_sha256: parity.query_sha256, expected_rows: parity.expected_rows, expected_digest: parity.expected_digest,
    jobs, matches_docker_functional_results: true, all_passed: true };
  await writeFile(resolve(projectRoot, 'work/abap-odbc/kubernetes-verification.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

check().catch(() => { process.stderr.write('CDS ODBC Kubernetes verification failed.\n'); process.exitCode = 1; });
