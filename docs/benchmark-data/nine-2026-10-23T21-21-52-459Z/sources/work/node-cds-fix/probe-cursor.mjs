import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import odbc from '/app/node_modules/odbc/lib/odbc.js';
let connection, cursor, timer;
try {
  connection = await odbc.connect({ connectionString: process.env.ABAP_ODBC_CONNECTION_STRING, connectionTimeout: 30, loginTimeout: 30 });
  cursor = await connection.query(await readFile(process.env.SQL_QUERY_FILE, 'utf8'), { cursor: true, fetchSize: 100, timeout: 10 });
  const start = performance.now();
  timer = setTimeout(() => connection.cancel().catch(() => {}), 500);
  const rows = await cursor.fetch();
  clearTimeout(timer);
  console.log(JSON.stringify({ outcome: 'ok', fetch_elapsed_ms: performance.now() - start, rows: rows.length,
    injected_fault: 'Five-second client-side fetch stall, released only when SQLCancel reaches its statement handle',
    proof: JSON.parse(await readFile('/tmp/odbc-cancel-proof.json', 'utf8')) }));
} catch {
  console.log(JSON.stringify({ outcome: 'error', diagnostic: 'Cursor probe failed; driver details omitted to protect credentials' }));
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  if (cursor) await cursor.close().catch(() => {});
  if (connection) await connection.close().catch(() => {});
}
