import test from 'node:test';
import assert from 'node:assert/strict';
import { patchOdbcSource, patchOdbcCursorSource, rollback, fetchCall } from '../scripts/patch-odbc.mjs';

test('ODBC compatibility patch guards rollback and preserves real disconnect/cleanup', () => {
  const original = `before\n${rollback}\nSQLDisconnect(connection);\nSQLFreeHandle(SQL_HANDLE_DBC, connection);\nafter`;
  const patched = patchOdbcSource(original);
  assert.match(patched, /SQLGetInfo\([\s\S]*SQL_TXN_CAPABLE/);
  assert.match(patched, /if \(transaction_capability != SQL_TC_NONE\) \{[\s\S]*SQLEndTran/);
  assert.match(patched, /Error reading transaction support/);
  assert.ok(patched.endsWith('SQLDisconnect(connection);\nSQLFreeHandle(SQL_HANDLE_DBC, connection);\nafter'));
  assert.throws(() => patchOdbcSource('unknown implementation'));
  assert.throws(() => patchOdbcSource(`${original}\n${original}`));
  assert.throws(() => patchOdbcSource(patched));
});

test('ODBC cursor fetch is registered for cancellation until the native call returns', () => {
  const original = `before\n${fetchCall}\nif (alloc_error) return;\nafter`;
  const patched = patchOdbcCursorSource(original);
  assert.ok(patched.indexOf('RegisterActiveStatement(data->hstmt)') < patched.indexOf(fetchCall));
  assert.ok(patched.indexOf('UnregisterActiveStatement(data->hstmt)') > patched.indexOf(fetchCall));
  assert.ok(patched.indexOf('UnregisterActiveStatement(data->hstmt)') < patched.indexOf('if (alloc_error)'));
  assert.ok(patched.endsWith('if (alloc_error) return;\nafter'));
  assert.throws(() => patchOdbcCursorSource('unknown implementation'));
  assert.throws(() => patchOdbcCursorSource(`${original}\n${original}`));
  assert.throws(() => patchOdbcCursorSource(patched));
});
