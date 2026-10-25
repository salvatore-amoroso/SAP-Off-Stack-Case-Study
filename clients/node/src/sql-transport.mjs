import { PollError } from './poller.mjs';
import { sqlFetchSize } from './sql-poller.mjs';

const callback = (object, method, ...args) => new Promise((resolve, reject) => {
  object[method](...args, (error, value) => error ? reject(error) : resolve(value));
});

export function validateSqlEnvironment(transport, env) {
  const required = transport === 'hana' ? ['HANA_SERVER', 'HANA_DATABASE', 'HANA_USER', 'HANA_PASSWORD'] : ['ABAP_ODBC_CONNECTION_STRING'];
  if (required.some(name => typeof env[name] !== 'string' || !env[name] || env[name].includes('\0'))) throw new PollError('CONFIG', 'SQL runtime connection settings are required');
}

async function sqlDriver(config, env, loadDriver) {
  validateSqlEnvironment(config.transport, env);
  try {
    const loaded = await loadDriver(config.transport === 'hana' ? '@sap/hana-client' : 'odbc');
    return loaded.default ?? loaded;
  } catch { throw new PollError('CONFIG', 'Optional SQL driver is unavailable'); }
}

export async function createSqlAdapter(config, env = process.env, loadDriver = name => import(name), diagnostics = {}) {
  const driver = await sqlDriver(config, env, loadDriver);
  return config.transport === 'hana' ? hanaAdapter(driver, config, env, undefined, diagnostics) : odbcAdapter(driver, config, env);
}

export function createSqlSession(env = process.env, loadDriver = name => import(name), diagnostics = {}) {
  let driver, transport, session;
  return {
    async createAdapter(config) {
      if (transport && transport !== config.transport) throw new PollError('CONFIG', 'SQL session cannot change transport');
      if (!session) {
        driver = await sqlDriver(config, env, loadDriver);
        transport = config.transport;
        session = { connection: transport === 'hana' ? driver.createConnection() : undefined, connected: false };
      }
      return transport === 'hana' ? hanaAdapter(driver, config, env, session, diagnostics) : odbcAdapter(driver, config, env, session);
    },
    async close() {
      if (!session?.connection) return;
      const connection = session.connection;
      session.connection = undefined;
      session.connected = false;
      if (transport === 'hana') await callback(connection, 'disconnect');
      else await connection.close();
    },
  };
}

function serverTimes(resource) {
  const read = method => {
    try {
      const value = resource?.[method]?.();
      return Number.isFinite(value) && value > 0 ? value : null;
    } catch { return null; }
  };
  return { cpu_us: read('getServerCPUTime'), processing_us: read('getServerProcessingTime') };
}

function hanaAdapter(driver, config, env, shared, diagnostics = {}) {
  const session = shared ?? { connected: false };
  const connection = session.connection ??= driver.createConnection();
  let statement, cursor, done = false, cursorClosed = false, statementClosed = false, connectionClosed = false, unusable = false;
  const invalidate = () => { unusable = true; };
  const guard = async action => {
    try { return await action(); }
    catch (error) { invalidate(); throw error; }
  };
  const statistics = diagnostics.statistics ? {
    driver_calls: { prepare: 0, execute_query: 0, logical_fetch: 0, next_can_block: 0, next_sync: 0, next_async: 0, get_values_can_block: 0, get_values_sync: 0, get_values_async: 0 },
    server: { units: 'microseconds', prepare: null, execute: null, fetch: null, scope: 'Prepare and execution are separate statement reports; execution includes initially returned rows. Result-set fetch statistics exclude execution. Zero/unavailable reports are null; client calls are not wire round trips.' },
  } : null;
  return {
    invalidate,
    async open() { return guard(async () => {
      if (!session.connected) {
        const timeout = Math.min(config.request_timeout_seconds, config.scan_timeout_seconds) * 1000;
        await callback(connection, 'connect', {
          serverNode: env.HANA_SERVER, databaseName: env.HANA_DATABASE, uid: env.HANA_USER, pwd: env.HANA_PASSWORD,
          connectTimeout: timeout, communicationTimeout: timeout, prefetch: false, resultSetRowSetLimitKB: 128,
          reconnect: false, allowReconnectOnSelect: false, pooling: false,
        });
        connection.setAutoCommit(true);
        connection.setRowSetSize(sqlFetchSize);
        session.connected = true;
      }
      statement = await callback(connection, 'prepare', config.sql);
      if (statistics) {
        statistics.driver_calls.prepare++;
        statistics.server.prepare = serverTimes(statement);
      }
      statement.setTimeout(config.request_timeout_seconds);
      cursor = await callback(statement, 'executeQuery');
      if (statistics) {
        statistics.driver_calls.execute_query++;
        statistics.server.execute = serverTimes(statement);
      }
      cursor.setAsArrayDefault(false);
    }); },
    async fetch() { return guard(async () => {
      const rows = [];
      if (statistics) statistics.driver_calls.logical_fetch++;
      while (!done && rows.length < sqlFetchSize) {
        const nextAsync = cursor.nextCanBlock();
        if (statistics) { statistics.driver_calls.next_can_block++; statistics.driver_calls[nextAsync ? 'next_async' : 'next_sync']++; }
        const hasRow = nextAsync ? await callback(cursor, 'next') : cursor.next();
        if (!hasRow) { done = true; break; }
        const valuesAsync = cursor.getValuesCanBlock();
        if (statistics) { statistics.driver_calls.get_values_can_block++; statistics.driver_calls[valuesAsync ? 'get_values_async' : 'get_values_sync']++; }
        rows.push(valuesAsync ? await callback(cursor, 'getValues') : cursor.getValues());
      }
      return { rows, done };
    }); },
    statistics() {
      if (statistics) statistics.server.fetch = serverTimes(cursor);
      return statistics;
    },
    async cancel() { invalidate(); await callback(connection, 'abort'); },
    async close() {
      let failure;
      if (cursor && !cursorClosed) {
        cursorClosed = true;
        try { await callback(cursor, 'close'); }
        catch (error) { invalidate(); failure = error; }
      }
      if (statement && !statementClosed) {
        statementClosed = true;
        try { await callback(statement, 'drop'); }
        catch (error) { invalidate(); failure ??= error; }
      }
      if (!connectionClosed && (!shared || unusable)) {
        connectionClosed = true;
        if (session.connection === connection) { session.connection = undefined; session.connected = false; }
        try { await callback(connection, 'disconnect'); }
        catch (error) { invalidate(); failure ??= error; }
      }
      if (failure) throw failure;
    },
  };
}

function odbcAdapter(driver, config, env, shared) {
  let connection, cursor, cursorClosed = false, connectionClosed = false, unusable = false;
  const invalidate = () => { unusable = true; };
  const guard = async action => {
    try { return await action(); }
    catch (error) { invalidate(); throw error; }
  };
  return {
    invalidate,
    async open() { return guard(async () => {
      if (shared?.connected) connection = shared.connection;
      else {
        const timeout = Math.min(config.request_timeout_seconds, config.scan_timeout_seconds);
        connection = await driver.connect({ connectionString: env.ABAP_ODBC_CONNECTION_STRING, connectionTimeout: timeout, loginTimeout: timeout });
        if (shared) { shared.connection = connection; shared.connected = true; }
      }
      cursor = await connection.query(config.sql, { cursor: true, fetchSize: sqlFetchSize, timeout: config.request_timeout_seconds });
    }); },
    async fetch() { return guard(async () => ({ rows: await cursor.fetch(), done: cursor.noData })); },
    async cancel() {
      // A deadline cancellation makes the connection's subsequent state uncertain.
      invalidate();
      if (connection) await connection.cancel();
    },
    async close() {
      let failure;
      if (cursor && !cursorClosed) {
        cursorClosed = true;
        try { await cursor.close(); }
        catch (error) { invalidate(); failure = error; }
      }
      if (connection && !connectionClosed && (!shared || unusable)) {
        connectionClosed = true;
        if (shared?.connection === connection) { shared.connection = undefined; shared.connected = false; }
        try { await connection.close(); }
        catch (error) { invalidate(); failure ??= error; }
      }
      if (failure) throw failure;
    },
  };
}
