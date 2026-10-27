#ifndef LLULL_PRELUDE_H_
#define LLULL_PRELUDE_H_

// llull: force-included in every translation unit of the crate (build.rs), before any Eigen header.
//  (1) printf is silenced: llull-compute reads stdout as NDJSON events.
//  (2) QFLOW_FAIL, QFLOW_ASSERT, eigen_assert and LEMON_ASSERT (LEMON_ASSERT_CUSTOM) throw QuadFlowError instead of the upstream
//      `printf(...); exit(0)`, assert() and the Eigen / LEMON abort(): a failure on a bad mesh (singular system, inconsistent field) reaches the
//      Rust caller as an Err and never ends the process.

#include <cstdio>
#include <stdexcept>
#include <string>

#define printf(...) ((void)0)

namespace qflow {
struct QuadFlowError : std::runtime_error {
    explicit QuadFlowError(const std::string& what) : std::runtime_error(what) {}
};

[[noreturn]] inline void assertion_failed(const char* expression, const char* file, int line) {
    throw QuadFlowError(std::string("assertion failed: ") + expression + " (" + file + ":" + std::to_string(line) + ")");
}

[[noreturn]] inline void lemon_assertion_failed(const char* file, int line, const char* function, const char* message, const char* assertion) {
    throw QuadFlowError(std::string("LEMON assertion failed: ") + message + " (" + assertion + ", " + function + ", " + file + ":" + std::to_string(line) + ")");
}
}  // namespace qflow

#define QFLOW_FAIL(message) throw qflow::QuadFlowError(message)
#define QFLOW_ASSERT(condition) ((condition) ? (void)0 : ::qflow::assertion_failed(#condition, __FILE__, __LINE__))
#define LEMON_ASSERT_CUSTOM
#define LEMON_CUSTOM_ASSERT_HANDLER ::qflow::lemon_assertion_failed
#define eigen_assert(x) ((x) ? (void)0 : ::qflow::assertion_failed(#x, __FILE__, __LINE__))

#endif
