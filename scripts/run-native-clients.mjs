import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { abapEvidence, dockerProgram, invoke, loadRuntime, mountedSource, nativeDockerCommand, nativeEnvironment, parityReport, projectRoot, runtimeDirectory, scanResult, validScan } from '../deploy/sql/native-runtime.mjs';

try {
  let args = process.argv.slice(2);
  const sourceMount = args.includes('--source-mount');
  if (sourceMount) {
    if (args.filter(argument => argument === '--source-mount').length !== 1) throw new Error('Duplicate source mount argument');
    args = args.filter(argument => argument !== '--source-mount');
  }
  if (args.length && !(args.length === 2 && args[0] === '--implementation' && ['node', 'rust'].includes(args[1]))) throw new Error('Invalid native client selection');
  const selected = args.length ? [args[1]] : ['node', 'rust'];
  if (sourceMount && !(selected.length === 1 && selected[0] === 'node')) throw new Error('Source mount requires the Node driver check');
  const { settings, manifest, query_sha256 } = await loadRuntime();
  const environment = { ...process.env, ...nativeEnvironment(settings, manifest) };
  const implementations = Object.fromEntries(['node', 'rust'].map(name => [name, { status: 'pending', passed: false, reason: 'Client not selected for this finite run' }]));
  await mkdir(runtimeDirectory, { recursive: true });
  for (const name of selected) {
    const container = `native-hana-${name}-${randomUUID().slice(0, 8)}`;
    const sourceDirectory = sourceMount ? resolve(projectRoot, 'clients/node/src') : undefined;
    const source = sourceMount ? await mountedSource(sourceDirectory) : { mode: 'image' };
    const command = nativeDockerCommand(name, { name: container, sourceDirectory });
    const started = new Date().toISOString();
    const execution = await invoke(command.program, command.args, { env: environment, timeout: 150000 });
    if (execution.timed_out || execution.oversized) await invoke(dockerProgram, ['rm', '--force', container]);
    try {
      const result = scanResult(execution.stdout);
      await writeFile(resolve(runtimeDirectory, `${name}-result.json`), `${JSON.stringify(result, null, 2)}\n`);
      const passed = execution.status === 0 && !execution.timed_out && validScan(result, manifest);
      implementations[name] = { status: passed ? 'passed' : 'failed', passed, source, started_at: started, finished_at: new Date().toISOString(), exit_code: execution.status, timed_out: execution.timed_out, result };
    } catch {
      implementations[name] = { status: 'failed', passed: false, source, started_at: started, finished_at: new Date().toISOString(), exit_code: execution.status, timed_out: execution.timed_out, reason: 'Client did not return one valid native HANA scan result' };
      await writeFile(resolve(runtimeDirectory, `${name}-result.json`), `${JSON.stringify(implementations[name], null, 2)}\n`);
    }
  }
  try {
    const result = scanResult(await readFile(resolve(runtimeDirectory, 'abap-result.json'), 'utf8'));
    let proof;
    try { proof = JSON.parse(await readFile(resolve(runtimeDirectory, 'abap-proof.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    implementations.abap = abapEvidence(result, proof, manifest, query_sha256);
  } catch (error) {
    implementations.abap = error.code === 'ENOENT' ? { status: 'pending', passed: false, reason: 'ABAP native HANA result has not been captured' } : { status: 'failed', passed: false, reason: 'ABAP native HANA result is invalid' };
  }
  const report = parityReport(implementations, manifest, query_sha256);
  await writeFile(resolve(runtimeDirectory, 'native-client-parity-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.status === 'passed' ? 0 : report.status === 'pending' ? 2 : 1;
} catch {
  process.stderr.write('Unable to configure or execute the finite native HANA clients.\n');
  process.exitCode = 1;
}
