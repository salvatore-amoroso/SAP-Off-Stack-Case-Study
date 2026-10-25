import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { context, controlPlane, dockerProgram, invoke, kubectlArguments, loadRuntime, namespace, network, runtimeDirectory, runtimeObjects } from './native-runtime.mjs';

let stage = 'runtime', lastCommand;
try {
  if (process.argv.length !== 2) throw new Error('Unexpected configuration arguments');
  const { settings, manifest, sql, query_sha256 } = await loadRuntime();
  async function networks(container) {
    const result = await invoke(dockerProgram, ['inspect', '--format', '{{json .NetworkSettings.Networks}}', container]);
    lastCommand = result;
    if (result.status !== 0 || result.timed_out) throw new Error('Unable to inspect the existing lab network');
    return JSON.parse(result.stdout);
  }
  stage = 'inspect_sap_network';
  const sapNetworks = await networks('a4h');
  stage = 'inspect_kind_network';
  const kindNetworks = await networks(controlPlane);
  const address = sapNetworks[network]?.IPAddress;
  if (!address || !kindNetworks[network]?.IPAddress) throw new Error('The existing lab network must connect SAP and the lab kind control plane');
  stage = 'validate_network';
  const objects = runtimeObjects(settings, manifest, sql, address);
  stage = 'apply_runtime';
  const result = await invoke(process.env.KUBECTL_EXE || 'kubectl', [...kubectlArguments, 'apply', '-f', '-'], { input: JSON.stringify(objects), timeout: 60000 });
  lastCommand = result;
  if (result.status !== 0 || result.timed_out) throw new Error('Unable to apply isolated native HANA runtime configuration');
  const proof = { schema_version: 1, configured_at: new Date().toISOString(), context, namespace, network, control_plane: controlPlane, hana_server: `${address}:30215`, query_sha256, expected_rows: manifest.expected_rows, job_policy: 'suspended_on_initial_apply' };
  stage = 'save_proof';
  await mkdir(runtimeDirectory, { recursive: true });
  await writeFile(resolve(runtimeDirectory, 'kubernetes-configuration.json'), `${JSON.stringify(proof, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(proof, null, 2)}\n`);
} catch {
  process.stderr.write(`${JSON.stringify({ error: 'Unable to configure native HANA Jobs', stage, exit_code: lastCommand?.status ?? null, timed_out: lastCommand?.timed_out ?? false, oversized_output: lastCommand?.oversized ?? false })}\n`);
  process.exitCode = 1;
}
