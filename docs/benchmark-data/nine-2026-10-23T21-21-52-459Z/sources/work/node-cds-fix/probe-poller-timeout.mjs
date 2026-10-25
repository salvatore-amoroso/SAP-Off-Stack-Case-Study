import { readFile } from 'node:fs/promises';
import { sqlConfig } from '/app/src/sql-config.mjs';
import { scanSql } from '/app/src/sql-poller.mjs';
import { createSqlSession } from '/app/src/sql-transport.mjs';
const config = await sqlConfig(['--transport', 'odbc']), session = createSqlSession();
const records = [];
try {
  records.push(await scanSql({ ...config, request_timeout_seconds: 30 }, session.createAdapter, 0));
  records.push(await scanSql({ ...config, request_timeout_seconds: 1 }, session.createAdapter, 1));
  records.push(await scanSql({ ...config, request_timeout_seconds: 30 }, session.createAdapter, 2));
} finally { await session.close(); }
console.log(JSON.stringify({ records, proof: JSON.parse(await readFile('/tmp/odbc-cancel-proof.json', 'utf8')) }));
