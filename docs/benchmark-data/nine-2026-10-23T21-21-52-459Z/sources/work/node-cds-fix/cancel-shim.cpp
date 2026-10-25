// Test-only interposition: delay the first fetch until SQLCancel reaches its handle.
#include <sql.h>
#include <dlfcn.h>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <thread>
static std::atomic<bool> cancelled{false};
static std::atomic<unsigned> fetches{0};
static std::atomic<SQLHSTMT> delayed{SQL_NULL_HSTMT};
static std::atomic<int> cancel_calls{0};
extern "C" SQLRETURN SQLFetch(SQLHSTMT statement) {
  using Fetch = SQLRETURN (*)(SQLHSTMT);
  static auto original = reinterpret_cast<Fetch>(dlsym(dlopen("libodbc.so.2", RTLD_NOW), "SQLFetch"));
  if (!original) return SQL_ERROR;
  const auto setting = std::getenv("ODBC_FAULT_FETCH");
  const unsigned target = setting ? std::strtoul(setting, nullptr, 10) : 1;
  if (++fetches == target) {
    delayed = statement;
    const auto start = std::chrono::steady_clock::now();
    while (!cancelled && std::chrono::steady_clock::now() - start < std::chrono::seconds(5))
      std::this_thread::sleep_for(std::chrono::milliseconds(5));
    delayed = SQL_NULL_HSTMT;
    auto file = std::fopen("/tmp/odbc-cancel-proof.json", "w");
    if (file) {
      std::fprintf(file, "{\"cancel_calls\":%d,\"cancel_reached_fetch\":%s}\n", cancel_calls.load(), cancelled ? "true" : "false");
      std::fclose(file);
    }
  }
  return original(statement);
}
extern "C" SQLRETURN SQLCancel(SQLHSTMT statement) {
  if (statement == delayed && statement != SQL_NULL_HSTMT) {
    ++cancel_calls;
    cancelled = true;
    return SQL_SUCCESS;
  }
  using Cancel = SQLRETURN (*)(SQLHSTMT);
  static auto original = reinterpret_cast<Cancel>(dlsym(dlopen("libodbc.so.2", RTLD_NOW), "SQLCancel"));
  if (!original) return SQL_ERROR;
  return original(statement);
}
