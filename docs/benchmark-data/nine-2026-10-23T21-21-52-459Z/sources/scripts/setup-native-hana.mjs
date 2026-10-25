import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { projectRoot } from './sap-runtime.mjs';

// Local trial only. Privileged credentials stay inside the existing SAP container.
const runtimeDir = resolve(projectRoot, 'work/native-hana');
const settingsFile = resolve(runtimeDir, 'runtime.json');
const user = 'ZBL_BENCH_RO';
const schema = 'ZBL_BENCH_SQL';
const view = 'ORDER_POSITIONS_001';
mkdirSync(runtimeDir, { recursive: true });
const hadSettings = existsSync(settingsFile);
const settings = hadSettings ? JSON.parse(readFileSync(settingsFile, 'utf8')) : {
  HANA_SERVER: 'sap-a4h:30215', HANA_DATABASE: 'HDB', HANA_USER: user,
  HANA_PASSWORD: `Bl_${randomBytes(24).toString('hex')}9!`,
};
if (settings.HANA_USER !== user || settings.HANA_DATABASE !== 'HDB' ||
    !/^[A-Za-z0-9_!]{20,100}$/.test(settings.HANA_PASSWORD)) throw new Error('Invalid private native HANA settings');

function docker(args, input) {
  return new Promise((accept, reject) => {
    const processHandle = spawn(process.env.DOCKER_EXE || 'docker', args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    processHandle.stdout.on('data', chunk => { output += chunk; });
    processHandle.stderr.on('data', chunk => { output += chunk; });
    const timeout = setTimeout(() => processHandle.kill(), 180000);
    processHandle.on('error', () => { clearTimeout(timeout); reject(new Error('Local Docker command failed')); });
    processHandle.on('close', code => {
      clearTimeout(timeout);
      const clean = output.replaceAll(settings.HANA_PASSWORD, '[REDACTED]');
      if (code !== 0 || /^\* \d+:/m.test(clean)) reject(new Error(`Local HANA setup failed: ${clean.slice(-2500)}`));
      else accept(clean);
    });
    processHandle.stdin.on('error', () => {});
    processHandle.stdin.end(input);
  });
}

async function sql(text, principal = 'schema') {
  // Neither the master password nor CREATE USER's generated password is put in argv.
  const script = `set -eu
umask 077
sql_file="$(mktemp /tmp/zbl-native-XXXXXX.sql)"
trap 'rm -f -- "$sql_file"' EXIT
cat > "$sql_file" <<'ZBL_NATIVE_SQL'
${text}
ZBL_NATIVE_SQL
${principal === 'schema' ? '/usr/sap/HDB/HDB02/exe/hdbsql -U DEFAULT -a -x -I "$sql_file"' : `. /etc/abaptrial.env.sh
case "$ABAP_TRIAL_MASTER_PWD" in *'"'*|*'\\'*|*$'\\n'*|*$'\\r'*) exit 65 ;; esac
printf -- '-p "%s"\\n' "$ABAP_TRIAL_MASTER_PWD" | /usr/sap/HDB/HDB02/exe/hdbsql -n localhost:30215 -d HDB -u SYSTEM -stdin -a -x -I "$sql_file"`}
`;
  return docker(['exec', '--interactive', ...(principal === 'schema' ? ['--user', 'a4hadm'] : []), 'a4h', '/bin/bash'], script);
}

try {
  const before = await sql(`SELECT 'USER', COUNT(*) FROM SYS.USERS WHERE USER_NAME='${user}';
SELECT 'SCHEMA', COUNT(*) FROM SYS.SCHEMAS WHERE SCHEMA_NAME='${schema}';
SELECT 'VIEW', COUNT(*) FROM SYS.VIEWS WHERE SCHEMA_NAME='${schema}' AND VIEW_NAME='${view}';
SELECT 'DATA', COUNT(*) FROM SAPA4H.ZBL_ORD_POS WHERE CLIENT='001';`);
  const count = key => {
    const match = before.match(new RegExp(`"${key}",([0-9]+)`));
    if (!match) throw new Error('Unrecognized local HANA discovery output');
    return Number(match[1]);
  };
  const existingUser = count('USER'), existingSchema = count('SCHEMA'), existingView = count('VIEW');
  if (count('DATA') !== 5000) throw new Error('Expected frozen 5000-row fixture is absent; setup will not reseed it');
  if (!hadSettings && (existingUser || existingSchema || existingView)) throw new Error('Native SQL object collision; inspect existing ownership before setup');
  // Save before provisioning so an interrupted run can resume without rotating a live password.
  if (!hadSettings) writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  if (!existingUser) await sql(`CREATE RESTRICTED USER ${user} PASSWORD "${settings.HANA_PASSWORD}" NO FORCE_FIRST_PASSWORD_CHANGE;`, 'system');
  await sql(`ALTER USER ${user} ENABLE CLIENT CONNECT;`, 'system');
  if (!existingSchema) await sql(`CREATE SCHEMA ${schema} OWNED BY SAPA4H;`, 'system');
  if (!existingView) await sql(readFileSync(resolve(projectRoot, 'sap/setup/native-hana-view.sql'), 'utf8'));
  await sql(`GRANT SELECT ON "${schema}"."${view}" TO ${user};`);
  const proof = await sql(`SELECT COUNT(*) FROM "${schema}"."${view}";
SELECT TOP 1 "ORDERID", "POSITIONNUMBER", "ORDERDATE", "QUANTITY", "NETAMOUNT" FROM "${schema}"."${view}" ORDER BY "ORDERID", "POSITIONNUMBER";`);
  writeFileSync(resolve(runtimeDir, 'runtime.env'), Object.entries(settings).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600 });
  const record = { schema_version: 1, observed_at: new Date().toISOString(), container: 'a4h', tenant: 'HDB',
    source_schema: 'SAPA4H', schema, view, user, restricted_user: true, sap_client: '001', expected_rows: 5000,
    granted_object_privilege: 'SELECT', proof: proof.trim() };
  writeFileSync(resolve(runtimeDir, 'setup-proof.json'), `${JSON.stringify(record, null, 2)}\n`);
  console.log(JSON.stringify(record));
} catch (error) {
  console.error(String(error.message).replaceAll(settings.HANA_PASSWORD, '[REDACTED]'));
  process.exitCode = 1;
}
