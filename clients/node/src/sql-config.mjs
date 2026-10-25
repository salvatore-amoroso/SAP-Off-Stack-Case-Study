import { readFile } from 'node:fs/promises';
import { liveConfig } from './config.mjs';
import { normalizeSqlConfig } from './sql-poller.mjs';
import { PollError } from './poller.mjs';
import { validateSqlEnvironment } from './sql-transport.mjs';

export async function sqlConfig(args) {
  const seen = new Set();
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (!['--transport', '--config'].includes(flag) || seen.has(flag) || typeof value !== 'string' || value.startsWith('--')) throw new Error('Invalid SQL arguments');
    seen.add(flag);
    options[flag.slice(2)] = value;
  }
  const file = options.config ? JSON.parse(await readFile(options.config, 'utf8')) : {};
  const transport = options.transport ?? process.env.SQL_TRANSPORT;
  if (transport === 'odbc' && !process.env.SQL_QUERY_FILE) throw new PollError('CONFIG', 'SQL_QUERY_FILE is required for ODBC');
  const sql = await readFile(process.env.SQL_QUERY_FILE || new URL('../../../contracts/native-hana.sql', import.meta.url), 'utf8');
  const config = normalizeSqlConfig({ ...liveConfig(file), transport, sql });
  validateSqlEnvironment(config.transport, process.env);
  return config;
}
