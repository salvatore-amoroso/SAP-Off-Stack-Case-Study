import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadOdbcRuntime, odbcDockerCommand, odbcEnvironment, invoke, projectRoot } from '../../deploy/sql/odbc-runtime.mjs';
const runtime = await loadOdbcRuntime(), here = resolve(projectRoot, 'work/node-cds-fix');
const source = (await readFile(resolve(projectRoot, 'work/odbc-node/capabilities.cpp'), 'utf8'))
  .replaceAll('SQL_API_SQLENDTRAN', 'SQL_API_SQLCANCEL').replaceAll('transaction_function_', 'cancel_function_');
await writeFile(resolve(here, 'cancel-capabilities.cpp'), source);
const build = await invoke('docker', ['run', '--rm', '--network', 'none', '--entrypoint', 'g++', '--mount', `type=bind,source=${here},target=/proof`,
  'sap-polling-node:nine-fixed-sql', '/proof/cancel-capabilities.cpp', '-o', '/proof/cancel-capabilities', '-lodbc']);
assert.equal(build.status, 0, 'Capability probe compilation failed');
const command = odbcDockerCommand('node', runtime.address), index = command.args.indexOf('sap-polling-node:sql-odbc');
command.args[command.args.indexOf('--entrypoint') + 1] = '/proof/cancel-capabilities';
command.args.splice(index, command.args.length - index, '--mount', `type=bind,source=${here},target=/proof,readonly`, 'sap-polling-node:nine-fixed-sql');
const result = await invoke(command.program, command.args, { env: { ...process.env, ...odbcEnvironment(runtime.settings, runtime.manifest) }, timeout: 60000 });
assert.equal(result.status, 0, 'Capability probe failed');
const report = { checked_at_utc: new Date().toISOString(), ...JSON.parse(result.stdout) };
await writeFile(resolve(here, 'cancel-capabilities.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
