// The static data of LEMON's `base.cc` that the vendored headers declare (tolerance defaults and `INVALID`); the rest of `base.cc` is the
// time-measure format, which the pipeline does not use (and whose header needs POSIX `unistd.h`).
#include <lemon/core.h>
#include <lemon/tolerance.h>

namespace lemon {

float Tolerance<float>::def_epsilon = static_cast<float>(1e-4);
double Tolerance<double>::def_epsilon = 1e-10;
long double Tolerance<long double>::def_epsilon = 1e-14;

const Invalid INVALID = Invalid();

}  // namespace lemon
