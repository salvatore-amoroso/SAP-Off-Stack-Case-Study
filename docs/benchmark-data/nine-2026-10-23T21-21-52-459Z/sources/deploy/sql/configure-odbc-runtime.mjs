import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { controlPlane, kubectlArguments, namespace, network } from './native-runtime.mjs';
import { dockerProgram, driverDirectory, driverMount, invoke, loadOdbcRuntime, odbcDirectory, odbcEnvironment, sapCertificateHost } from './odbc-runtime.mjs';

let stage = 'load_runtime';
try {
  if (process.argv.length !== 2) throw new Error('Unexpected configuration arguments');
  const runtime = await loadOdbcRuntime();
  const inspected = await invoke(dockerProgram, ['inspect', '--format', '{{json .NetworkSettings.Networks}}', controlPlane]);
  if (inspected.status !== 0 || !JSON.parse(inspected.stdout)[network]?.IPAddress) throw new Error('The existing kind node must already share the SAP network');
  stage = 'stage_driver';
  for (const args of [['exec', controlPlane, 'mkdir', '-p', driverMount], ['cp', `${driverDirectory}/.`, `${controlPlane}:${driverMount}`]]) {
    const result = await invoke(dockerProgram, args, { timeout: 90000 });
    if (result.status !== 0 || result.timed_out) throw new Error('Unable to stage driver in existing kind node');
  }
  const environment = odbcEnvironment(runtime.settings, runtime.manifest);
  const secret = environment.ABAP_ODBC_CONNECTION_STRING;
  delete environment.ABAP_ODBC_CONNECTION_STRING;
  const metadata = name => ({ name, namespace, labels: { 'app.kubernetes.io/part-of': 'sap-order-polling-lab' } });
  const items = [
    { apiVersion: 'v1', kind: 'ConfigMap', metadata: metadata('cds-odbc-config'), data: environment },
    { apiVersion: 'v1', kind: 'ConfigMap', metadata: metadata('cds-odbc-query'), data: { 'abap-cds-odbc.sql': runtime.sql } },
    { apiVersion: 'v1', kind: 'Secret', metadata: metadata('cds-odbc-credentials'), type: 'Opaque', data: { ABAP_ODBC_CONNECTION_STRING: Buffer.from(secret).toString('base64') } },
  ];
  const jobs = ['node', 'rust'].map(implementation => {
    const name = `poller-${implementation}-cds`;
    return { apiVersion: 'batch/v1', kind: 'Job', metadata: metadata(name), spec: {
      suspend: true, backoffLimit: 0, completions: 1, parallelism: 1, activeDeadlineSeconds: 150,
      template: { metadata: { labels: { 'app.kubernetes.io/name': name, 'app.kubernetes.io/part-of': 'sap-order-polling-lab' } }, spec: {
        restartPolicy: 'Never', automountServiceAccountToken: false,
        hostAliases: [{ ip: runtime.address, hostnames: [sapCertificateHost] }],
        securityContext: { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, seccompProfile: { type: 'RuntimeDefault' } },
        containers: [{ name: 'poller', image: `sap-polling-${implementation}:sql-odbc`, imagePullPolicy: 'Never',
          ...(implementation === 'node' ? { command: ['node', '--v8-pool-size=1', '/app/src/sql-cli.mjs'] } : {}), args: ['--transport', 'odbc'],
          envFrom: [{ configMapRef: { name: 'cds-odbc-config' } }, { secretRef: { name: 'cds-odbc-credentials' } }],
          ...(implementation === 'node' ? { env: [{ name: 'UV_THREADPOOL_SIZE', value: '1' }] } : {}),
          volumeMounts: [{ name: 'query', mountPath: '/run/sql', readOnly: true }, { name: 'driver', mountPath: driverMount, readOnly: true }, { name: 'scratch', mountPath: '/tmp' }],
          resources: { requests: { cpu: '1', memory: '256Mi' }, limits: { cpu: '1', memory: '256Mi' } },
          securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
        }],
        volumes: [{ name: 'query', configMap: { name: 'cds-odbc-query', defaultMode: 292 } },
          { name: 'driver', hostPath: { path: driverMount, type: 'Directory' } }, { name: 'scratch', emptyDir: { medium: 'Memory', sizeLimit: '16Mi' } }],
      } },
    } };
  });
  // Keep deployable public Job definitions separate from the runtime Secret.
  await mkdir(odbcDirectory, { recursive: true });
  await writeFile(resolve(odbcDirectory, 'jobs.json'), `${JSON.stringify({ apiVersion: 'v1', kind: 'List', items: jobs }, null, 2)}\n`);
  stage = 'apply_configuration';
  const applied = await invoke(process.env.KUBECTL_EXE || 'kubectl', [...kubectlArguments, 'apply', '-f', '-'], { input: JSON.stringify({ apiVersion: 'v1', kind: 'List', items }), timeout: 60000 });
  if (applied.status !== 0 || applied.timed_out) throw new Error('Unable to apply CDS ODBC runtime configuration');
  stage = 'create_jobs';
  for (const job of jobs) {
    const existing = await invoke(process.env.KUBECTL_EXE || 'kubectl', [...kubectlArguments, 'get', 'job', job.metadata.name, '--ignore-not-found', '-o', 'json']);
    if (existing.status !== 0) throw new Error('Unable to inspect CDS Job');
    if (existing.stdout.trim()) {
      if (JSON.parse(existing.stdout).metadata?.labels?.['app.kubernetes.io/part-of'] !== 'sap-order-polling-lab') throw new Error('Existing CDS Job does not belong to the lab');
      continue;
    }
    const created = await invoke(process.env.KUBECTL_EXE || 'kubectl', [...kubectlArguments, 'create', '-f', '-'], { input: JSON.stringify(job) });
    if (created.status !== 0) throw new Error('Unable to create suspended CDS Job');
  }
  const proof = { configured_at: new Date().toISOString(), namespace, control_plane: controlPlane, query_sha256: runtime.query_sha256,
    certificate_host: sapCertificateHost, sap_address: runtime.address, driver_directory_on_node: driverMount, driver_files: runtime.driver_files,
    jobs: jobs.map(job => job.metadata.name), new_jobs_suspended: true };
  await writeFile(resolve(odbcDirectory, 'kubernetes-configuration.json'), `${JSON.stringify(proof, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(proof, null, 2)}\n`);
} catch {
  process.stderr.write(`${JSON.stringify({ error: 'Unable to configure CDS ODBC Jobs', stage })}\n`);
  process.exitCode = 1;
}
