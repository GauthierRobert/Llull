# Vendored sources of `llull-quadflow` (07 MSH M6, TECHNICAL_SPEC 13.6)

Nothing here is downloaded at build time: the crate builds offline (AF-41). Licence texts: `licenses/` (also staged into the desktop bundle by
`desktop/scripts/prepare-native.mjs`).

| Component | Version / origin | Licence | Where |
| --------- | ---------------- | ------- | ----- |
| QuadriFlow | https://github.com/hjwdzh/QuadriFlow commit `810b7a0967c35b0dc85b4464e3835e26a756c967` (2019-12-07, master) | BSD-3-Clause plus the "Enhancements" grant (`licenses/QuadriFlow-LICENSE.txt`); it is not the MIT licence the spec first assumed | `quadriflow/src` |
| Eigen | 3.4.0 (`eigen-3.4.0.tar.gz`, sha256 `8586084f71f9bde545ee7fa6d00288b264a2b7ac3607b974e54d13e7162c1c72`), only the headers the build includes | MPL-2.0; built with `EIGEN_MPL2_ONLY`, which turns any LGPL include into a compile error (`licenses/Eigen-COPYING.*`); `BFloat16.h` is Apache-2.0 | `eigen/Eigen` |
| LEMON | 1.3.1 as vendored by QuadriFlow (`3rd/lemon-1.3.1`), only the headers the build includes, a hand-written `lemon/config.h` | Boost Software License 1.0 (`licenses/LEMON-LICENSE.txt`) | `lemon/lemon` |
| pcg32 | Wenzel Jakob's single header, as vendored by QuadriFlow (`3rd/pcg32`) | Apache-2.0 (`licenses/Eigen-COPYING.APACHE`) | `pcg32/pcg32.h` |

Not vendored (QuadriFlow's optional parts): Boost, TBB, OpenMP, CUDA (`Optimizer.cu`), Gurobi, ceres, the MapleCOMSPS SAT solver, parallel stable
sort (`pss`), `main.cpp`, the OBJ loader.

## Changes to QuadriFlow (all in `quadriflow/src`)

1. `llull_prelude.hpp` (force-included in every translation unit by `build.rs`, before any Eigen or LEMON header): `printf` is silenced (`llull-compute` reads stdout as NDJSON events); `QFLOW_FAIL`, `QFLOW_ASSERT`, `eigen_assert` and `LEMON_ASSERT` (`LEMON_ASSERT_CUSTOM`) throw `QuadFlowError` where upstream printed and called `exit(0)`, called `assert` or aborted (`hierarchy.cpp`, `optimizer.cpp`, `parametrizer-sing.cpp`, `subdivide.cpp`, `field-math.hpp`, `flow.hpp`), so a failure reaches Rust as an `Err`. `assert` itself is shadowed by `shim/assert.h` and `shim/cassert` (first on the include path), so the plain asserts of Eigen (`BDCSVD`, `Meta.h`) and pcg32 throw too.
2. `flow.hpp`, `optimizer.cpp`: the Boost Boykov-Kolmogorov max-flow helper is replaced by `LemonMaxFlowHelper` (LEMON Edmonds-Karp). A push-relabel flow
   (tried first) carries circulations, which the edge-difference update turns into wrong integer offsets: the result had a third of the requested quads.
   The Gurobi helper is removed.
3. The `-sat` option is removed (`localsat.*`, `Hierarchy::FixFlipSat`, `Parametrizer::FixFlipSat`): it ran the external `minisat` through `system()`.
4. `parametrizer-mesh.cpp`, `parametrizer.hpp`: `sharp_cos_threshold` replaces the fixed 60 degree sharp-edge angle; boundary edges are skipped by the
   sharp-edge test (upstream read `E2E[e] == -1` as a face index); the OBJ `Load` is removed (the facade fills `V` / `F` from memory).
5. `dedge.cpp`: `std::cout` progress lines become `lprintf`; `optimizer.cpp`: dead debug code after a `return` is removed; `post-solver.hpp` is removed (its
   function was never called).
6. `cpp/lemon_statics.cxx` (llull) defines the static data of LEMON's `base.cc` that the headers declare.
7. `hierarchy.cpp`, `parametrizer-int.cpp`: the random numbers come from pcg32 (initial orientation / position fields) and a Fisher-Yates on pcg32 (flow variable shuffle) instead of `srand` / `rand` / `RAND_MAX`, `std::mt19937` and `std::shuffle`, whose sequences differ between C++ libraries. `hierarchy.cpp`: the call of upstream's `pcg32::shuffle` on the colouring order is removed, together with the permutation vector it acted on (that function has a reversed bounds test and returns at once, so the order was always the identity and stays so; the loop reads `ip = i`).
8. `parametrizer.cpp`: after `FixValence`, an empty compact mesh (a target too small for the mesh, e.g. a tetrahedron asked for 6 quads) is `QFLOW_FAIL`; upstream went on to solve an empty position system and Eigen's sparse LU divided by zero (exit code 0xC0000094, the process died). Found by bisecting probes through `ComputeIndexMap` (no debugger is installed): `n=0 nnz=0` at the factorization.
