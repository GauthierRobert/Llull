# SV1 — Solver toolchain on a Windows 11 dev machine (SOLVER-VERIFY, 2026-10-20)

**Status:** recorded (install record + what it verified). **Owner authorisation:** the user authorised installing the full solver toolchain.

> Superseded in part: the previous mesher (its row and environment variable, removed here) is replaced by Netgen in `llull-mesh` ([NG1](NG1-netgen-mesher.md)); the rest of the record stands.

## Decision

Every external FE / kernel tool that the server suites skip without is installed per user, pinned, outside the repo, and pointed at through
the environment the server already reads. No repo default changes: the server still resolves `python3` / `ccx` / `solver/target/release`.

| Tool | Version (pin) | Source and install | Where | Provenance |
| --- | --- | --- | --- | --- |
| Miniforge | 26.7.2-0 | `winget install CondaForge.Miniforge3 --scope user` (`/InstallationType=JustMe /AddToPath=0`) | `%USERPROFILE%\miniforge3` | winget manifest hash verified |
| Python | 3.12.15 (conda-forge) | `conda create -n llull-fea python=3.12 calculix=2.21=h27aae45_3 numpy` | `...\envs\llull-fea\python.exe` | conda-forge |
| pyNastran | 1.4.1 (pulls numpy 1.26.4) | `pip install pyNastran` in `llull-fea` | same env | PyPI |
| CalculiX ccx | 2.21 (`calculix 2.21 h27aae45_3`, conda-forge win-64, built 2023-07-29) | in `llull-fea` | `...\envs\llull-fea\Library\bin\ccx.exe` (needs `Library\bin` and `Library\mingw-w64\bin` on PATH) | sha256 `1cfaaed97f80ef56006d3ee1b325f708ed44c51a6268565d1de943c569427b43` |
| CadQuery | 2.8.0 | `conda create -n llull-cq python=3.12`, `pip install --only-binary :all: "cadquery>=2.4"` (server/python/requirements.txt) | `...\envs\llull-cq\python.exe` | PyPI wheels |
| build123d | 0.12.0 (the newest on OCP 7.9: 0.13.0 needs `cadquery-ocp-proxy` 8.0, which would replace CadQuery 2.8.0's OCP 7.9.3.1.1) | in `llull-cq`: its dependencies with `ocpsvg==0.6.0 ocp_gordon==0.2.2 "cadquery-ocp-proxy==7.9.3.1.1" "cadquery-ocp==7.9.3.1.1"` pinned, then `pip install --no-deps build123d==0.12.0` (0.12.0 requires `cadquery-ocp-novtk`, the same OCP 7.9.3.1.1 without VTK; `cadquery-ocp` provides that module, so `pip check` names the missing novtk wheel and nothing else) | same env (`LLULL_TEST_BUILD123D_PYTHON` / `LLULL_PYTHON_BUILD123D`) | wheel sha256 `c3ced4e2…a234f` |
| CMake / Ninja | 4.4.4 / 1.13.2 | `conda create -n llull-build cmake ninja` | `...\envs\llull-build\Library\bin` | conda-forge |
| Rust | 1.97.0 (`solver/rust-toolchain.toml`), host toolchains msvc + gnu already installed | rustup (pre-existing) | `%USERPROFILE%\.cargo` | — |
| C++ compiler | GCC 16.2.0, w64devkit 2.10.1 (pre-existing, installed by an earlier session) | `%USERPROFILE%\tools\w64devkit` | g++.exe sha256 `671ca52a…728d2`, installer `w64devkit.7z.exe` sha256 `add1edf9…2896a` |
| OCCT | 7.9.2 shared, built from the pinned source by `node solver/scripts/build-occt.mjs` (sha256 `f6e272b6…7181`), with MinGW GCC | `LLULL_OCCT_DIR=%LOCALAPPDATA%\llull\occt-7.9.2-mingw-fix` (recipe 2, `-fno-ipa-cp-clone`; the older `occt-7.9.2-mingw` / `-mingw-iges` prefixes carry the GCC miscompile, see the last addendum; NOT the default prefix, which stays for an MSVC build) | ~25-35 min on 20-22 threads |
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
`LLULL_TEST_FEA_PYTHON` / `LLULL_PYNASTRAN_PYTHON` = the `llull-fea` python; `LLULL_PYTHON` = the `llull-cq` python
(STEP / code exchange); `LLULL_CCX` = the ccx above; `LLULL_OCCT_DIR` as above for `cargo`.

## What ran (all with the tools present)

| Suite | Result |
| --- | --- |
| `cargo test` default members (gnu) | pass; `llull-raster` / `llull-gpu` / `llull-compute` with `--features gpu`: pass |
| `cargo test -p llull-kernel-occt -p llull-kernel` (gnu, MinGW OCCT) | 44 / 44 and 9 / 9 when it does not crash; `shells_hollow_and_open` crashed the test process about 1 run in 2 — a GCC 16.2 `-O3` wrong-code bug in OCCT, fixed (addendum "MinGW OCCT access violation") |
| `cargo fmt --check`, `cargo clippy --workspace --all-targets -D warnings` | pass (after `cargo fmt` of the never-compiled SRF-3 Rust) |
| Server FE suites without the kernel (feaPipeline, feaThermal* (6), feaThermomech*, feaNonlinear*, feaSolve*, feaRoutes, physics packs) | pass |
| Server FE suites with the kernel (feaEigen, feaThermomechTransient incl. bimetal VC-TMC-04, feaThermomechT1 NAFEMS T1, feaMeshBridge STEP + conformal) | pass |
| New: feaShellSolve, feaBucklingPreload, feaThermomechOrtho, nativeKernelSurfacing (VC-SRF-11 / 22) | pass |
| nativeTransports / nativeExchange / nativeRender (CPU twin and wgpu GPU path) / nativeBinary | pass; nativeComputeJob: 3 POSIX-only tests skip by design |
| nativeKernel*, NIST VC-KRN-25 (corpus fetched: 28 / 28 files) | pass |
| pyNastran `read_bdf(xref=True)` round trip (`tests/unit/cae/bdfWriter.test.ts`) | pass |
| Python exchange (CadQuery 2.8.0): pythonExchange, cadExchange, cliExchange, exchangeEndpoints | pass |

~~Not trustworthy on this toolchain (MinGW OCCT)~~ — **root-caused and fixed, see the addendum "MinGW OCCT access violation" below.** The
`llull-kernel` sidecar died with an access violation (`NATIVE_DIED 0xC0000005`) in distance queries and shells; the red server tests
(occtAnalysis, occtChamferShell, nativeKernelFeatures, occtCheckAssembly, occtSheetMetal, brepCodeExchange) all followed from it and pass
with an OCCT built by the fixed recipe.

Also red on this checkout, unrelated to the tools: `exchangeHardening` symlink confinement (EPERM: no symlink privilege for a normal Windows
account; the block now skips with a logged reason when the OS refuses symlinks) and the `RESULTS.md is rendered` contract test of pack 07
(CRLF working copy).

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

## Addendum 2026-10-20: NIST STEP File Analyzer (SFA) for 03 GD&T VC-GDT-22

| Tool | Version (pin) | Source | Where | Provenance |
| --- | --- | --- | --- | --- |
| SFA (`sfa-cl.exe`, `STEP-File-Analyzer.exe`) | 5.51 (updated 14 Sep 2026) | `https://raw.githubusercontent.com/usnistgov/SFA/master/Release/SFA-5.51.zip`, unzipped | `%USERPROFILE%\tools\sfa-5.51` (user scope, no installer) | zip sha256 `d7d06e24…a13c` (76 988 894 bytes); `sfa-cl.exe` sha256 `df1202ea…7dca`; `STEP-File-Analyzer.exe` sha256 `5bfa1382…4ba6`; NIST public-domain software, redistribution terms in its README FIRST |
| IFCsvr toolkit (SFA's STEP reader, a 32-bit ActiveX component) | 3.0.0.8 (`ifcsvrr300_setup_1008_en-update.msi`, unpacked by SFA into `%TEMP%\SFA`) | shipped inside `sfa-cl.exe` | **NOT installed** | the installer registers a COM component under `C:\Program Files (x86)\IFCsvrR300` and needs administrator rights; running it unattended was refused by the permission policy, so it is left for the owner |

Consequence: without IFCsvr `sfa-cl.exe` only offers the geometry viewer, not the semantic-PMI and validation-property spreadsheets. `server/tests/sfaPmi.test.ts` probes
for the toolkit and skips with a logged reason until it is installed (run the `.msi` as administrator once, then `npm --prefix server test -- sfaPmi`). Override the
binary with `LLULL_SFA`.

## Addendum 2026-10-20: MinGW OCCT access violation — root cause and fix

**Cause: a GCC 16.2 wrong-code bug at `-O3` (IPA-CP cloning), not the stack, the runtime DLLs or the exception model.** In
`BRepClass3d_SClassifier.cxx` GCC emits two IPA-CP clones of the self-recursive `NCollection_UBTree<int, Bnd_Box>::Select(TreeNode,
Selector&)`, `.constprop.0` and `.constprop.1`, both devirtualised to the line selector (`Bnd_Box::IsOut(gp_Lin)`,
`BRepClass3d_BndBoxTreeSelectorLine::Accept`). The point query `aTree.Select(aSelectorPoint)` (`SClassifier.cxx:218`) recurses into
`.constprop.1` (objdump of the object: `call .constprop.1` with `rdx` = the point selector), so the line selector's `Reject` / `Accept` run on
the 48-byte point selector and read `myLC` 0xa8 bytes into it, i.e. the classifier's stack. Every solid classification is affected:
`BRepClass3d_SolidClassifier` (distance / `faceQuery.distance` inside test, `shape_distance_json`), `BOPTools_AlgoTools::ComputeState` (every
boolean that splits solids, so the cut of a shell, `BRepOffsetAPI_MakeThickSolid`'s result, sheet-metal face picks). Intermittent because
whether a box survives the wrong `Reject` depends on that stack garbage and on the heap layout (ASLR; shape-map hashing by address).

Evidence (gdb from w64devkit, `solver` debug test binary, `shells_hollow_and_open`):

| Step | Result |
| --- | --- |
| Reproduce | 7 crashes in 8 runs (exit 139 = 0xC0000005); never under gdb (a process started by a debugger gets the NT debug heap); `_NO_DEBUG_HEAP=1` crashes on the first try |
| Faulting frame | `Extrema_ExtCC::Perform` → `myC[1]->GetType()` through a vtable `0x524e7d6c914d4f2b` (the same value in every crash) ← `BRepClass3d_BndBoxTreeSelectorLine::Accept` ← `NCollection_UBTree::Select` ← `BRepClass3d_SClassifier::Perform` ← `BOPTools_AlgoTools::ComputeState` ← `BOPAlgo_BuilderSolid` (the cut in `shell_hollow`) |
| Who wrote the "vtable" | hardware watchpoint on that slot during the failing `SClassifier::Perform`: never written by a constructor; last writer `std::mt19937::_M_gen_rand` in `BRepClass3d_SolidExplorer::InitShape` (its random-ray state), i.e. stale stack |
| Stack size | `RUST_MIN_STACK=64 MiB`: still 6 crashes in 8; the frames are far from the guard page |
| Runtime DLLs on PATH | none involved: the OCCT DLLs, the test binary and `llull-kernel.exe` import only `KERNEL32` / `msvcrt` / system DLLs (w64devkit links libstdc++, libgcc and winpthreads statically) |
| Exceptions / signals | `catch throw` never fires before the fault; no structured exception is converted |
| Optimisation level | OCCT RelWithDebInfo (`-O2 -g`): 0 crashes in 10; only `libTKTopAlgo.dll` from the Release build: crashes; TKTopAlgo rebuilt `-O3 -g`: crashes; `-O2 -DNo_Exception`: 0 in 10 |
| Translation unit / flag | only `BRepClass3d_SClassifier.cxx` at `-O3`: 4 crashes in 8; the same with `-fno-ipa-cp-clone`: 0 in 10; with `-fno-ipa-icf`: 4 in 10 |

**Fix.** `solver/scripts/build-occt.mjs` injects `add_compile_options(-fno-ipa-cp-clone)` for GCC through `CMAKE_PROJECT_INCLUDE` (MSVC and
Clang untouched; Linux GCC builds get it too, harmless) and stamps `recipe: 2` in `llull-occt.json`, so a prefix built by the old recipe is
rebuilt; `solver/crates/llull-kernel-occt/build.rs` passes the same flag to the cxx facade when the compiler is GCC. The Linux CI kernel is
built by an older GCC, which is why the same tests always passed there. llvm-mingw was not needed. Noted, not changed: OCCT compiles with
`-DOCC_CONVERT_SIGNALS -std=gnu++17`, the facade without the define and with `-std=c++17`; the only header difference is the inline no-op
`Standard_ErrorHandler::Callback` of the facade, and the class layouts are identical (sizeof checked for the extrema / adaptor classes).

Verification, with OCCT rebuilt by the fixed script (`%LOCALAPPDATA%\llull\occt-7.9.2-mingw-fix`, IGES included, ~25 min on 20 jobs):
`shells_hollow_and_open` 30 / 30; `cargo test -p llull-kernel-occt -p llull-kernel` 62 / 62 and 13 / 13, three times; each formerly red
server suite three times, no `NATIVE_DIED`: occtAnalysis 8 / 8, occtChamferShell 11 / 11, nativeKernelFeatures 42 / 42, occtCheckAssembly
6 / 6, occtSheetMetal 14 / 14, brepCodeExchange.integration 5 / 5. Then once with every tool present (build123d 0.12.0 included,
`--maxWorkers=2`, 22 min): 144 files, 1339 passed, 16 skipped, 1 todo, 1 failed — `sfaPmi` (VC-GDT-22): with IFCsvr now answering, SFA
reports a real AP242 finding on llull's plate export, "Datum Reference Frames for 'datum_system' should be unique for the same
product_definition_shape" (open; the test's own false match on SFA's progress line "checking for syntax errors" is fixed). Skips: symlink
confinement (4, EPERM), nativeComputeJob (3, POSIX-only), dwgImport (3, no DWG converter), MTest (1, not installed), the build123d `#!/bin/sh`
wrapper (1, POSIX-only). `cargo test --workspace -- --test-threads=1` (gnu): 164 passed, 2 ignored; clippy `-D warnings` and `fmt --check`
clean.
