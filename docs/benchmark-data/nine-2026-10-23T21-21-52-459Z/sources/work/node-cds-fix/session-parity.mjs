import { sqlConfig } from '/app/src/sql-config.mjs';
import { scanSql } from '/app/src/sql-poller.mjs';
import { createSqlSession } from '/app/src/sql-transport.mjs';
const config = await sqlConfig(process.argv.slice(2));
const session = createSqlSession();
let passed = true;
try {
  for (let index = 0; index < 2; index++) {
    const result = await scanSql(config, session.createAdapter, index);
    console.log(JSON.stringify(result));
    passed &&= result.outcome === 'ok';
  }
} finally {
  try { await session.close(); console.log(JSON.stringify({ stage: 'session-close', outcome: 'ok' })); }
  catch { passed = false; console.log(JSON.stringify({ stage: 'session-close', outcome: 'error' })); }
}
process.exitCode = passed ? 0 : 1;
