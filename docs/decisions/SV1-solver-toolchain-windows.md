# SV1 — Solver toolchain on a Windows 11 dev machine (SOLVER-VERIFY, 2026-10-20)

**Status:** recorded (install record + what it verified). **Owner authorisation:** the user authorised installing the full solver toolchain.

## Decision

Every external FE / kernel tool that the server suites skip without is installed per user, pinned, outside the repo, and pointed at through
the environment the server already reads. No repo default changes: the server still resolves `python3` / `ccx` / `solver/target/release`.

| Tool | Version (pin) | Source and install | Where | Provenance |
| --- | --- | --- | --- | --- |
| Miniforge | 26.7.2-0 | `winget install CondaForge.Miniforge3 --scope user` (`/InstallationType=JustMe /AddToPath=0`) | `%USERPROFILE%\miniforge3` | winget manifest hash verified |
| Python | 3.12.15 (conda-forge) | `conda create -n llull-fea python=3.12 calculix=2.21=h27aae45_3 numpy` | `...\envs\llull-fea\python.exe` | conda-forge |
| Gmsh | 4.15.2 | `pip install gmsh==4.15.2` (wheel) in `llull-fea` | same env | PyPI (the version `server/python/llull_mesh.py` reports) |
| pyNastran | 1.4.1 (pulls numpy 1.26.4) | `pip install pyNastran` in `llull-fea` | same env | PyPI |
| CalculiX ccx | 2.21 (`calculix 2.21 h27aae45_3`, conda-forge win-64, built 2023-07-29) | in `llull-fea` | `...\envs\llull-fea\Library\bin\ccx.exe` (needs `Library\bin` and `Library\mingw-w64\bin` on PATH) | sha256 `1cfaaed97f80ef56006d3ee1b325f708ed44c51a6268565d1de943c569427b43` |
| CadQuery | 2.8.0 | `conda create -n llull-cq python=3.12`, `pip install --only-binary :all: "cadquery>=2.4"` (server/python/requirements.txt) | `...\envs\llull-cq\python.exe` | PyPI wheels |
| CMake / Ninja | 4.4.4 / 1.13.2 | `conda create -n llull-build cmake ninja` | `...\envs\llull-build\Library\bin` | conda-forge |
| Rust | 1.97.0 (`solver/rust-toolchain.toml`), host toolchains msvc + gnu already installed | rustup (pre-existing) | `%USERPROFILE%\.cargo` | — |
| C++ compiler | GCC 16.2.0, w64devkit 2.10.1 (pre-existing, installed by an earlier session) | `%USERPROFILE%\tools\w64devkit` | g++.exe sha256 `671ca52a…728d2`, installer `w64devkit.7z.exe` sha256 `add1edf9…2896a` |
| OCCT | 7.9.2 shared, built from the pinned source by `node solver/scripts/build-occt.mjs` (sha256 `f6e272b6…7181`), with MinGW GCC | `LLULL_OCCT_DIR=%LOCALAPPDATA%\llull\occt-7.9.2-mingw` (NOT the default prefix, which stays for an MSVC build) | ~35 min on 22 threads |
| MFront / TFEL | not installed | no conda-forge win-64 build (`conda search tfel`: none); no other trivial install | — | 02 constitutive MTest transport stays unverified |

**MSVC is NOT available.** `winget install Microsoft.VisualStudio.2022.BuildTools` (C++ workload) needs elevation and the UAC prompt was never
answered (two attempts, from this and another session); a portable MSVC download script was refused by the permission policy. The native
binaries were therefore built with the GNU target `x86_64-pc-windows-gnu`:

- `RUSTFLAGS=-L <dir with an empty libgcc_eh.a>` (w64devkit puts the unwinder in `libgcc.a`; rustc's GNU target links `-lgcc_eh`);
- `CXXFLAGS=-I <dir holding a junction llull-kernel-occt -> solver/crates/llull-kernel-occt>`: cxx-build links the crate directory into
  `OUT_DIR` with a symlink, which a non-elevated Windows account cannot create, so `#include "llull-kernel-occt/cpp/facade.hxx"` failed;
- `build.rs` changes kept in the repo (portable, no effect on MSVC / Linux): accept `lib<TK>.dll.a` import libraries, and name the OCCT
  toolkits after the static facade (a single-pass GNU ld otherwise leaves the facade's OCCT symbols undefined).

Run environment of the suites (PowerShell): `PATH` += `llull-fea`, its `Library\bin`, `Library\mingw-w64\bin`, the OCCT `bin`, w64devkit `bin`;
`LLULL_GMSH_PYTHON` / `LLULL_TEST_FEA_PYTHON` / `LLULL_PYNASTRAN_PYTHON` = the `llull-fea` python; `LLULL_PYTHON` = the `llull-cq` python
(STEP / code exchange); `LLULL_CCX` = the ccx above; `LLULL_OCCT_DIR` as above for `cargo`.

## What ran (all with the tools present)

| Suite | Result |
| --- | --- |
| `cargo test` default members (gnu) | pass; `llull-raster` / `llull-gpu` / `llull-compute` with `--features gpu`: pass |
| `cargo test -p llull-kernel-occt -p llull-kernel` (gnu, MinGW OCCT) | 44 / 44 and 9 / 9 when it does not crash; `shells_hollow_and_open` crashes the test process about 1 run in 2 (access violation inside `BRepOffsetAPI_MakeThickSolid`) |
| `cargo fmt --check`, `cargo clippy --workspace --all-targets -D warnings` | pass (after `cargo fmt` of the never-compiled SRF-3 Rust) |
| Server FE suites without the kernel (feaPipeline, feaThermal* (6), feaThermomech*, feaNonlinear*, feaSolve*, feaRoutes, physics packs) | pass |
| Server FE suites with the kernel (feaEigen, feaThermomechTransient incl. bimetal VC-TMC-04, feaThermomechT1 NAFEMS T1, feaMeshBridge STEP + conformal) | pass |
| New: feaShellSolve, feaBucklingPreload, feaThermomechOrtho, nativeKernelSurfacing (VC-SRF-11 / 22) | pass |
| nativeTransports / nativeExchange / nativeRender (CPU twin and wgpu GPU path) / nativeBinary | pass; nativeComputeJob: 3 POSIX-only tests skip by design |
| nativeKernel*, NIST VC-KRN-25 (corpus fetched: 28 / 28 files) | pass |
| pyNastran `read_bdf(xref=True)` round trip (`tests/unit/cae/bdfWriter.test.ts`) | pass |
| Python exchange (CadQuery 2.8.0): pythonExchange, cadExchange, cliExchange, exchangeEndpoints | pass |

**Not trustworthy on this toolchain (MinGW OCCT), so NOT reported as llull defects:** the `llull-kernel` sidecar dies with an access
violation (`NATIVE_DIED 0xC0000005`) inside `BRepExtrema_DistShapeShape` on curved faces and inside `MakeThickSolid`; every remaining red
server test follows from it: occtAnalysis (distance), occtChamferShell / nativeKernelFeatures (sealed shells), occtCheckAssembly, occtSheetMetal
(face pick by distance), brepCodeExchange (shell). The same tests pass on the Linux CI kernel. Consequences: the FE face map (TR-FEA-32,
`faceQuery.distance`) falls back to the nearest-surface resolution here, and `create_composite_part` on an OCC (non-entity) conical face
could not be run (the cone face itself is exact: area 74509.412 = pi (r1 + r2) s of VC-CMP-15). Re-run these with an MSVC build
(`npm --prefix server test` with `LLULL_REQUIRE_NATIVE_KERNEL=1`) once the Build Tools are installed.

Also red on this checkout, unrelated to the tools: `exchangeHardening` symlink confinement (EPERM: no symlink privilege for a normal Windows
account) and the `RESULTS.md is rendered` contract test of pack 07 (CRLF working copy).

## Defects found and fixed (each with a regression test)

1. Child-process environment allowlist case-sensitive: on Windows ccx ran without `Path` (exit 0xC0000135) and Python without `SystemRoot`
   (`server/src/pythonExchange.ts`). FE suites ran a bare `python3` / `ccx` instead of the probed tools (`server/tests/feaTestSupport.ts`).
2. Shell pressure sign inverted (05): ccx 2.21 moves a shell along its normal under a positive `P`.
3. `TOTAL EFFECTIVE MASS` is the model mass, not the extracted-mode sum (05): `fractionOfModelMass`.
4. Buckling preload (05): the factors multiply preload + reference (`factorsMultiply`), the preload is not held constant.
5. Pre-heated transient coupled deck did not run in ccx (04): `*TEMPERATURE` in the coupled step refused; energy output must be requested in
   the first step.
6. B-spline loft sections (02 SRF-3, first compile): exact solid but OCC's Gauss rule under-integrated faces bounded by one multi-span edge
   (NACA wing 12 % low); each knot span is now its own edge. A first fix in mass properties was reverted because it moved the NIST
   reference (VC-KRN-25) by up to 1.3e-4.
