#include <sql.h>
#include <sqlext.h>
#include <cstdlib>
#include <cstdio>
int main() {
  SQLHENV environment = SQL_NULL_HENV;
  SQLHDBC connection = SQL_NULL_HDBC;
  SQLAllocHandle(SQL_HANDLE_ENV, SQL_NULL_HANDLE, &environment);
  SQLSetEnvAttr(environment, SQL_ATTR_ODBC_VERSION, (void*)SQL_OV_ODBC3, 0);
  SQLAllocHandle(SQL_HANDLE_DBC, environment, &connection);
  SQLRETURN connected = SQLDriverConnect(connection, nullptr, (SQLCHAR*)std::getenv("ABAP_ODBC_CONNECTION_STRING"), SQL_NTS, nullptr, 0, nullptr, SQL_DRIVER_NOPROMPT);
  if (!SQL_SUCCEEDED(connected)) { std::puts("{\"outcome\":\"connection-error\"}"); return 1; }
  SQLUSMALLINT transaction_capability = 999, end_transaction = 999;
  SQLRETURN info = SQLGetInfo(connection, SQL_TXN_CAPABLE, &transaction_capability, sizeof(transaction_capability), nullptr);
  SQLRETURN functions = SQLGetFunctions(connection, SQL_API_SQLCANCEL, &end_transaction);
  SQLRETURN disconnected = SQLDisconnect(connection);
  SQLRETURN freed = SQLFreeHandle(SQL_HANDLE_DBC, connection);
  SQLFreeHandle(SQL_HANDLE_ENV, environment);
  std::printf("{\"outcome\":\"ok\",\"transaction_info_rc\":%d,\"transaction_capability\":%u,\"cancel_function_rc\":%d,\"cancel_function_supported\":%u,\"disconnect_rc\":%d,\"free_rc\":%d}\n", info, transaction_capability, functions, end_transaction, disconnected, freed);
  return SQL_SUCCEEDED(disconnected) && SQL_SUCCEEDED(freed) ? 0 : 1;
}
