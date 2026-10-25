import assert from 'node:assert/strict';
import net from 'node:net';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The disposable proxy drops only this test client's connection; SAP stays running.
async function worker() {
  const { sqlConfig } = await import('/app/src/sql-config.mjs');
  const { scanSql } = await import('/app/src/sql-poller.mjs');
  const { createSqlSession } = await import('/app/src/sql-transport.mjs');
  const target = new URL(`tcp://${process.env.HANA_SERVER}`), sockets = new Set();
  let connections = 0;
  const proxy = net.createServer(socket => {
    connections++;
    const upstream = net.createConnection({ host: target.hostname, port: Number(target.port) });
    for (const stream of [socket, upstream]) { sockets.add(stream); stream.on('close', () => sockets.delete(stream)); stream.on('error', () => { socket.destroy(); upstream.destroy(); }); }
    socket.pipe(upstream); upstream.pipe(socket);
  });
  await new Promise(accept => proxy.listen(0, '127.0.0.1', accept));
  const config = await sqlConfig(['--transport', 'hana']);
  const session = createSqlSession({ ...process.env, HANA_SERVER: `127.0.0.1:${proxy.address().port}` });
  const scan = index => scanSql(config, () => session.createAdapter(config), index);
  try {
    const first = await scan(0); assert.equal(first.outcome, 'ok');
    const before = connections;
    for (const socket of sockets) socket.destroy();
    await new Promise(accept => setTimeout(accept, 100));
    const failed = await scan(1);
    assert.equal(failed.outcome, 'error'); assert.equal(failed.digest, null);
    assert(['TRANSPORT', 'TIMEOUT'].includes(failed.error?.code));
    const recovered = await scan(2);
    assert.equal(recovered.outcome, 'ok'); assert.equal(recovered.rows, 5000); assert.equal(recovered.digest, first.digest);
    assert(connections > before, 'A new HANA connection must be established after failure');
    return { passed: true, healthy_rows: first.rows, failure: { outcome: failed.outcome, code: failed.error.code, digest: failed.digest },
      recovered_rows: recovered.rows, recovered_digest: recovered.digest, proxy_connections: connections,
      sap_restarted: false, scope: 'Real SAP HANA driver; established client TCP connection dropped through a disposable local proxy. Three verification scans; not performance measurements.' };
  } finally {
    await session.close().catch(() => {});
    for (const socket of sockets) socket.destroy();
    await new Promise(accept => proxy.close(accept));
  }
}
async function main() {
  if (process.argv.includes('--worker')) { console.log(JSON.stringify(await worker())); return; }
  assert.equal(process.argv.length, 2, 'Usage: node scripts/check-hana-recovery.mjs');
  const { projectRoot, loadRuntime, nativeEnvironment, invoke, network } = await import('../deploy/sql/native-runtime.mjs');
  const runtime = await loadRuntime(), environment = { ...process.env, ...nativeEnvironment(runtime.settings, runtime.manifest) };
  const file = fileURLToPath(import.meta.url); assert(!file.includes(',') && !projectRoot.includes(','));
  const args = ['run', '--rm', '--network', network, '--cpus', '1', '--memory', '256m', '--memory-swap', '256m',
    ...Object.keys(nativeEnvironment(runtime.settings, runtime.manifest)).flatMap(key => ['--env', key]),
    '--mount', `type=bind,source=${resolve(projectRoot, 'contracts/native-hana.sql')},target=/run/sql/native-hana.sql,readonly`,
    '--mount', `type=bind,source=${file},target=/run/hana-recovery.mjs,readonly`,
    '--entrypoint', 'node', 'sap-polling-node:nine-sql', '/run/hana-recovery.mjs', '--worker'];
  const result = await invoke('docker', args, { env: environment, timeout: 150000 });
  assert.equal(result.status, 0, 'HANA recovery worker failed');
  const proof = JSON.parse(result.stdout.trim()); assert.equal(proof.passed, true);
  const output = resolve(projectRoot, 'work/native-hana/recovery-verification.json');
  await mkdir(resolve(projectRoot, 'work/native-hana'), { recursive: true });
  await writeFile(output, JSON.stringify({ checked_at_utc: new Date().toISOString(), ...proof }, null, 2) + '\n');
  console.log(JSON.stringify(proof));
}
await main().catch(() => { console.error('HANA recovery verification failed; no credential-bearing diagnostics are printed'); process.exitCode = 1; });
