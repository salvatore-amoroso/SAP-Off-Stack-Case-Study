import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sapSettings } from '../../scripts/sap-runtime.mjs';
import { dockerProgram, invoke, network, projectRoot } from './native-runtime.mjs';

export { dockerProgram, invoke, projectRoot };
export const odbcDirectory = resolve(projectRoot, 'work/abap-odbc');
export const odbcQueryFile = resolve(projectRoot, 'contracts/abap-cds-odbc.sql');
export const driverDirectory = resolve(projectRoot, '../../Tools/abap-odbc/driver');
export const sapCertificateHost = 'a4h.wdf.sap.corp';
export const driverMount = '/opt/sap/abap-odbc';
export const servicePath = '/sap/bc/sql/sql1/sap/S_PRIVILEGED';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const value = text => `{${String(text).replaceAll('}', '}}')}}`;

export function connectionString(settings, host = sapCertificateHost) {
  if (!settings.local || settings.client !== '001' || !settings.username || !settings.password || host !== sapCertificateHost) throw new Error('Existing local trial/client 001 required');
  return Object.entries({
    Driver: `${driverMount}/ODBC_driver_for_ABAP.so`, Host: host, Port: '50001', Client: '001', Language: 'EN',
    ServicePath: servicePath, UidType: 'uid', TypeMap: 'native', AuthenticationType: 'UidPwd',
    CryptoLibrary: `${driverMount}/libsapcrypto.so`, TrustedCertificates: `${driverMount}/sap-trial-ca.pem`,
    TrustAll: 'false', UID: settings.username, PWD: settings.password,
  }).map(([key, item]) => `${key}=${value(item)};`).join('');
}

export function odbcEnvironment(settings, manifest) {
  return {
    ABAP_ODBC_CONNECTION_STRING: connectionString(settings), SQL_TRANSPORT: 'odbc', SQL_QUERY_FILE: '/run/sql/abap-cds-odbc.sql',
    LD_LIBRARY_PATH: driverMount, SAP_CLIENT: '001', EXPECTED_ROWS: String(manifest.expected_rows), EXPECTED_DIGEST: manifest.expected_digest,
    SCANS: '1', POLL_INTERVAL_MS: '1000', REQUEST_TIMEOUT_SECONDS: '30', SCAN_TIMEOUT_SECONDS: '120', MAX_PAGES: '10000', PAGE_SIZE: '100',
  };
}

export async function loadOdbcRuntime() {
  const settings = sapSettings();
  const manifest = JSON.parse(await readFile(resolve(projectRoot, 'contracts/seed-manifest.json'), 'utf8'));
  if (manifest.expected_rows !== 5000 || !/^[a-f0-9]{64}$/.test(manifest.expected_digest)) throw new Error('Frozen manifest required');
  const sql = await readFile(odbcQueryFile, 'utf8');
  if (!sql.trim() || sql.includes('\0')) throw new Error('Shared CDS SQL query required');
  const files = [];
  for (const name of (await readdir(driverDirectory)).sort()) {
    const path = resolve(driverDirectory, name);
    if (!(await stat(path)).isFile()) continue;
    const bytes = await readFile(path);
    files.push({ name, bytes: bytes.length, sha256: hash(bytes) });
  }
  for (const name of ['ODBC_driver_for_ABAP.so', 'libsapcrypto.so', 'sap-trial-ca.pem']) {
    if (!files.some(file => file.name === name)) throw new Error('Required driver or certificate file missing');
  }
  const inspected = await invoke(dockerProgram, ['inspect', '--format', '{{json .NetworkSettings.Networks}}', 'a4h']);
  if (inspected.status !== 0) throw new Error('Existing SAP network unavailable');
  const address = JSON.parse(inspected.stdout)[network]?.IPAddress;
  if (!address || !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(address) || address.split('.').some(part => Number(part) > 255)) throw new Error('Existing SAP network address invalid');
  return { settings, manifest, sql, query_sha256: hash(sql), driver_files: files, address };
}

export function odbcDockerCommand(implementation, address, { name, sourceDirectory } = {}) {
  if (!['node', 'rust'].includes(implementation)) throw new Error('Unknown ODBC client');
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(address)) throw new Error('Invalid SAP address');
  if (name !== undefined && !/^cds-odbc-(?:node|rust)-[a-z0-9-]+$/.test(name)) throw new Error('Invalid CDS client container name');
  const args = ['run', '--rm', '--cpus', '1', '--memory', '256m', '--memory-swap', '256m', '--network', network,
    '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m',
    '--add-host', `${sapCertificateHost}:${address}`];
  if (name) args.push('--name', name);
  for (const key of Object.keys(odbcEnvironment({ local: true, client: '001', username: 'placeholder', password: 'placeholder' }, { expected_rows: 5000, expected_digest: '' }))) args.push('--env', key);
  args.push('--mount', `type=bind,source=${driverDirectory},target=${driverMount},readonly`,
    '--mount', `type=bind,source=${odbcQueryFile},target=/run/sql/abap-cds-odbc.sql,readonly`);
  if (sourceDirectory) {
    if (implementation !== 'node' || sourceDirectory.includes(',')) throw new Error('Invalid CDS source mount');
    args.push('--mount', `type=bind,source=${sourceDirectory},target=/app/src,readonly`);
  }
  if (implementation === 'node') args.push('--env', 'UV_THREADPOOL_SIZE=1', '--entrypoint', 'node');
  args.push(`sap-polling-${implementation}:sql-odbc`);
  if (implementation === 'node') args.push('--v8-pool-size=1', '/app/src/sql-cli.mjs');
  args.push('--transport', 'odbc');
  return { program: dockerProgram, args };
}

export function cdsPayload(result) {
  return { schema_version: result.schema_version, scan_index: result.scan_index, outcome: result.outcome, rows: result.rows, digest: result.digest, error: result.error };
}
