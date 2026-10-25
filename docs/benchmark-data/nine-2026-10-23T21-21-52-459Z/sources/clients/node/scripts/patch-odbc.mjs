import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const rollback = `      return_code =
        SQLEndTran(SQL_HANDLE_DBC, odbcConnectionObject->hDBC, SQL_ROLLBACK);
      if (!SQL_SUCCEEDED(return_code)) {
        uv_mutex_unlock(&ODBC::g_odbcMutex);
        this->errors =
          GetODBCErrors(SQL_HANDLE_DBC, odbcConnectionObject->hDBC);
        SetError(
          "[odbc] Error ending potential transactions when closing the "
          "connection\\0"
        );
        return;
      }`;

const replacement = `      // The ABAP driver advertises SQL_TC_NONE and has no SQLEndTran.
      SQLUSMALLINT transaction_capability = SQL_TC_NONE;
      return_code = SQLGetInfo(
        odbcConnectionObject->hDBC, SQL_TXN_CAPABLE, &transaction_capability,
        sizeof(transaction_capability), NULL
      );
      if (!SQL_SUCCEEDED(return_code)) {
        uv_mutex_unlock(&ODBC::g_odbcMutex);
        this->errors = GetODBCErrors(SQL_HANDLE_DBC, odbcConnectionObject->hDBC);
        SetError("[odbc] Error reading transaction support when closing the connection\\0");
        return;
      }
      if (transaction_capability != SQL_TC_NONE) {
${rollback.split('\n').map(line => `  ${line}`).join('\n')}
      }`;

export function patchOdbcSource(source) {
  if (source.split(rollback).length !== 2) throw new Error('Pinned ODBC close implementation changed');
  return source.replace(rollback, replacement);
}

export const fetchCall = '    return_code = fetch_and_store(data, true, &alloc_error);';

export function patchOdbcCursorSource(source) {
  if (source.split(fetchCall).length !== 2 || source.includes('RegisterActiveStatement')) throw new Error('Pinned ODBC cursor implementation changed');
  // node-odbc registers queries for cancellation, but omits cursor fetches.
  return source.replace(fetchCall, `    cursor->odbcConnection->RegisterActiveStatement(data->hstmt);
${fetchCall}
    cursor->odbcConnection->UnregisterActiveStatement(data->hstmt);`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const packageRoot = new URL('../node_modules/odbc/', import.meta.url);
  const metadata = JSON.parse(await readFile(new URL('package.json', packageRoot), 'utf8'));
  if (metadata.version !== '2.6.0') throw new Error('ODBC compatibility patch requires version 2.6.0');
  const path = new URL('src/odbc_connection.cpp', packageRoot);
  await writeFile(path, patchOdbcSource(await readFile(path, 'utf8')));
  const cursorPath = new URL('src/odbc_cursor.cpp', packageRoot);
  await writeFile(cursorPath, patchOdbcCursorSource(await readFile(cursorPath, 'utf8')));
}
