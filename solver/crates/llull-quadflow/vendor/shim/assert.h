// llull: shadows the C library header so that every assert() in the vendored code (QuadriFlow, Eigen, pcg32) throws QuadFlowError instead of aborting.
#include "llull_prelude.hpp"
#undef assert
#define assert(condition) QFLOW_ASSERT(condition)
