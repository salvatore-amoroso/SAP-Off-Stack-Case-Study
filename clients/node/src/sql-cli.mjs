#!/usr/bin/env node
import { sqlConfig } from './sql-config.mjs';
import { runSql, scanSql } from './sql-poller.mjs';
import { createSqlSession } from './sql-transport.mjs';

try {
  const config = await sqlConfig(process.argv.slice(2));
  const session = createSqlSession();
  try { process.exitCode = await runSql(config, session.createAdapter); }
  finally {
    await session.close().catch(() => {
      process.stderr.write('Unable to close the SQL session.\n');
      process.exitCode ||= 1;
    });
  }
} catch {
  process.stdout.write(`${JSON.stringify(await scanSql({}))}\n`);
  process.stderr.write('Unable to configure or execute the SQL poller.\n');
  process.exitCode = 2;
}
