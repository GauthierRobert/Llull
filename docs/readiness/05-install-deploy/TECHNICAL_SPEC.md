# 05 INS — Install, dependencies, updates — Technical specification

Status: specification only (2026-10-28). Functional view: [`FUNCTIONAL_SPEC.md`](FUNCTIONAL_SPEC.md). Validation:
[`validation/README.md`](validation/README.md). Laws: [`.claude/rules/architecture.md`](../../../.claude/rules/architecture.md).
Product directive: [`CLAUDE.md`](../../../CLAUDE.md) (local only, offline AF-41, native first).

## 1. Current state in llull (code survey of origin/main f1351cff, 2026-10-28)

| Area | Where | Behaviour today | Gap |
| ---- | ----- | --------------- | --- |
| Packaging | `desktop/electron-builder.yml` | `appId app.llull.desktop`; NSIS `oneClick: false`, `perMachine: false`, `allowToChangeInstallationDirectory: true` (install-mode page: the user picks per-user or per-machine [R10]); mac `hardenedRuntime: true`, dmg + zip; Linux AppImage + deb; fuses: `runAsNode` on (CLI shim), asar integrity on, `NODE_OPTIONS` / inspect off | no MSI, no entitlements file, no signing / notarization config beyond env, no publish / update config |
| Bundled parts | `extraResources`: `web`, `server` (bundle + prod `node_modules` + Python bridge script + fonts, `desktop/scripts/stage-server.mjs`), `python` (python-build-standalone CPython 3.12.8 + `pip install -r server/python/requirements.txt`, `prepare-python.mjs`), `native` (`llull-compute`, `llull-kernel`, `llull-mesh`, OCCT 7.9.2 and Netgen shared libs, `licenses/`, `LLULL_NATIVE.json`, `prepare-native.mjs`), `skills` | self-contained by intent | Python deps unpinned (`cadquery>=2.4`); CadQuery master now requires `cadquery-ocp==8.0.1.1`, `casadi`, `trame*`, `numba`, `scipy` [R25] |
| Native discovery | `server/src/native/nativeBinary.ts:35-51` | per-binary override → `LLULL_NATIVE_DIR` → `solver/target/{compute,release}` | in an install only `LLULL_NATIVE_DIR` can work |
| Windows DLLs | `nativeBinary.ts:61-86` (`nativeRuntimeEnv`); `prepare-native.mjs` `stageOcct` | bundle: OCCT / Netgen DLLs copied next to the `.exe` (loader searches the app folder before `PATH` [R16]); dev build: OCCT `bin` prepended to `PATH` | compiler runtime DLLs (MSVC in CI `native-bundle`, MinGW on the owner's machine, SV1) are not staged; `smokeTest` runs `llull-kernel --version` with the build machine's `PATH` (only `llull-mesh` gets `PATH=System32`), so a missing DLL passes the build |
| Kernel choice | `server/src/geometryKernel.ts:75-101`; `desktop/src/backendEnv.ts:38-40,70-71` | desktop always passes `LLULL_KERNEL=occt-native`; native start failure ⇒ Manifold installed, one `console.warn`, `info().fallbackReason` | silent for the UI user (FR-INS-06) |
| Kernel report | `packages/core/src/commands/document/kernelInfo.ts:53-110`; `server/src/index.ts:51-60` (`GET /health` → `{ kernel }`) | `KRN_KERNEL_FALLBACK` warn issue with the reason; remediation "restart the app and report the reason" | no remediation per cause, no doctor |
| Backend env | `desktop/src/backendEnv.ts:49-77` | strips every inherited `LLULL_*`, sets `LLULL_PYTHON`, `LLULL_NATIVE_DIR` (only when a binary is present), autosave in `userData`, loopback + per-launch token | `LLULL_DWG2DXF` / `LLULL_ODA_CONVERTER` cannot be set for the app |
| CLI launcher | `desktop/src/cliShim.ts`; `desktop/src/main.ts:227-235` | `~/.llull/bin/llull(.cmd)` runs `resources/server/dist/cli.js` with `ELECTRON_RUN_AS_NODE=1`, nothing else; prints a `PATH` hint | headless CLI has no `LLULL_NATIVE_DIR` / `LLULL_PYTHON` (falls back to Manifold and `python3`, `pythonExchange.ts:58`); `skills.ts:41` already reads `process.resourcesPath` |
| Status | `server/src/cli/main.ts` `runStatus` | app running? which document? | no component checks |
| DWG | `server/src/dwgConvert.ts:3-4,51-58,96-107` | `dwg2dxf` (default on `PATH`) or `LLULL_ODA_CONVERTER`; 503 without either; argv-only spawn, temp dir, timeout | message still mentions "the llull Docker image" (removed by LC1) |
| Python bridge | `server/src/pythonExchange.ts:56-65` | `LLULL_PYTHON` (default `python3`), bridge script `../python/llull_bridge.py` | `export_step` / `import_step` exchange tools use Python although the native kernel has `exportStep` (`server/src/isolatedKernel.ts:290`) |
| User data | Electron `userData` (`autosave.json`, `desktop-settings.json`); `~/.llull/` (`desktop.json`, `bin/`, `vault/`); crash reports in `%LOCALAPPDATA%` / `~/Library/Application Support` / XDG data (`server/src/crashReports.ts:76-85`); skills copied to `~/.claude/skills` | spread over four roots | uninstall leaves the launcher and its `PATH` entry |
| Updates | none (`desktop/package.json` has no `electron-updater`); LC1 removed the web update banner | "upgrading is installing the new build over the old one" (`docs/DEPLOYMENT.md` §5) | no channel, no verification, no rollback |
| Licences | `resources/native/licenses/` (OCCT LGPL + exception + relink notice, Netgen, fdlibm / V8, QuadriFlow / Eigen / LEMON / pcg32, Rust crates); fonts with OFL | native side thorough | no aggregated notice for npm, Electron / Chromium, CPython and pip packages; no SBOM; no llull licence (no `LICENSE`, `"private": true`, no `license` field) |
| CI | `.github/workflows/check.yml` `native-bundle` (`windows-latest`, MSVC, macOS deferred by the owner 2026-10-19) | runs native suites against `desktop/build/native` with `LLULL_REQUIRE_NATIVE_KERNEL=1` | no installer build, no clean-machine run |
| Known build defects | 08 ASC FR-ASC-01 / 02 | `file:..` dependency packs the repo (16 GB); Git `tar` breaks `prepare-python` on Windows | owned by ASC M0; prerequisite here |

Docs out of date, to fix with M1: `desktop/README.md` still describes the retired WASM `occt` kernel; `docs/DEPLOYMENT.md` §4
and `dwgConvert.ts:26-30` mention the Docker image.

## 2. Target architecture

| Milestone | Layer | Placement | Laws |
| --------- | ----- | --------- | ---- |
| M0 self-contained runtime | `desktop/scripts/*`, `solver/` (import walker), `server/src/native/*` | pinned Python lock; dependency closure check at build; sanitized spawn env; one install-layout resolver shared by desktop and CLI | L6, C7 (walker in Rust) |
| M1 kernel status + doctor | core `commands/document/checkInstallation.ts` + port `ctx.installation`; `server/src/install/*` probes; CLI verb `llull doctor`; desktop first-run hook | read-only command over an injected host port (like `ctx.raster`); probes live in the host | L1, L2, L5, L9 |
| M2 signed installers | `desktop/electron-builder.yml`, `desktop/build/entitlements.mac.plist`, `desktop/build/apparmor/llull`, CI release workflow | signing in CI with keys in an HSM / cloud signing service | L6 |
| M3 clean-VM matrix | `scripts/installMatrix/*`, CI or a self-hosted runner | drives `validation/plans/*` on VM images | — |
| M4 MSI + policy | builder `msi` target; `server/src/install/policy.ts` | policy read by the host, passed to the backend explicitly | L6 |
| M5 updates | `desktop/src/updates.ts` (`electron-updater`), offline package verifier | main process only; the backend is unaware | L6 |
| M6 SBOM + notices + CRA | `desktop/scripts/sbom.mjs`, `resources/licenses/`, `SECURITY.md`, `docs/CRA.md` | build artefacts and docs | — |

No architecture law changes. The doctor is a registered read-only command (`check_installation`) whose effect lives in
the host behind a port, exactly like `capture_viewport` in 08 ASC; `llull doctor` is a CLI alias that also works when the
backend cannot start (it builds the probe in-process).

### Technical requirements

| Id | Pri | Requirement | FR |
| -- | --- | ----------- | -- |
| TR-INS-01 | MUST | Build-time **dependency closure check** (`desktop/scripts/check-bundle.mjs` calling a Rust import walker, `llull-compute inspect-deps`): for every PE / ELF / Mach-O in the staged app (Electron, `native/`, `python/`, `.node` / `.pyd` / `.so` modules) every imported library resolves inside the install or to an OS allowlist (Windows: API sets + `KnownDLLs` + `System32` modules present on every supported Windows; Linux: glibc family + the deb `Depends`; macOS: `/usr/lib`, `/System/Library`). Any other import fails the build with the binary and module name (§5.1) | 05 |
| TR-INS-02 | MUST | Compiler runtimes are part of the bundle: the Windows native binaries either link the C/C++ runtime statically or ship the runtime DLLs app-local next to the `.exe` (whichever the vendor's redistribution terms allow, §11 D6); the closure check proves it on a VM without any Visual C++ redistributable | 05 |
| TR-INS-03 | MUST | Native sidecars are spawned with a sanitized environment: Windows `PATH = <native dir>;%SystemRoot%\System32`; Linux `LD_LIBRARY_PATH` / `LD_PRELOAD` removed, `RUNPATH=$ORIGIN/occt/lib:$ORIGIN/netgen/lib`; macOS `DYLD_*` removed, install names `@rpath/…` with `LC_RPATH @loader_path/occt/lib` [R17]. Each sidecar calls `SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_APPLICATION_DIR \| LOAD_LIBRARY_SEARCH_SYSTEM32)` first thing in `main` on Windows, which removes `PATH` and the current folder from run-time `LoadLibrary` searches [R16]. `nativeRuntimeEnv`'s `PATH` prepend stays for dev builds only (not packaged) | 05 |
| TR-INS-04 | MUST | `prepare-native` smoke test runs every bundled binary with the TR-INS-03 environment (today only `llull-mesh`) and decodes a Windows exit status `0xC0000135` (STATUS_DLL_NOT_FOUND) / `0xC000007B` into `INS_NATIVE_DLL_MISSING` with the importer list from TR-INS-01 | 05 |
| TR-INS-05 | MUST | One **install layout** resolver (`server/src/install/layout.ts`), used by `desktop/src/layout.ts` and by the CLI when `process.resourcesPath` is defined (the shim's `ELECTRON_RUN_AS_NODE` runtime; `skills.ts` already relies on it): `nativeDir`, `python`, `web`, `licenses`, `sbom`. The installed CLI headless path gets the same kernel, Python and native tools as the app | 07 |
| TR-INS-06 | MUST | Python lock: `server/python/requirements.lock` with exact versions and `--require-hashes`, generated per platform; `prepare-python` installs with `pip install --no-deps --require-hashes`; the bundled OCP major.minor equals the native OCCT major.minor or the mismatch is listed in `LLULL_NATIVE.json` and reported by `kernel_info` (§11 D5) | 05, 09, 15 |
| TR-INS-07 | MUST | Kernel fallback policy `LLULL_KERNEL_FALLBACK = deny \| allow`: packaged desktop and installed CLI default `deny`; repo / dev default `allow` (today's behaviour, tests unchanged). `deny` + native start failure ⇒ no geometry kernel in the backend (`setGeometryKernel(null)`), kernel status `unavailable` with an `INS_KERNEL_*` code; `requiresKernel` commands refuse through `kernelRefusal.ts` with that code in the summary; the renderer status bar shows a persistent red "Exact kernel unavailable — Help > Check installation". `allow` (Settings "Use the mesh kernel when the exact kernel is unavailable", or policy) installs Manifold and keeps `KRN_KERNEL_FALLBACK` on every affected summary | 06 |
| TR-INS-08 | MUST | Kernel start self-test inside `startNativeKernel`: handshake (`--version` reports `OCCT 7.9.2`), then a box 10 mm minus a through cylinder r = 3 mm, volume compared to the closed form 1000 − 90π mm³ within 1e-9 relative (§5.3). Failure ⇒ `INS_KERNEL_SELFTEST_FAILED` and the TR-INS-07 policy applies | 06, 08 |
| TR-INS-09 | MUST | `check_installation` command + `llull doctor` verb per §4 and §5.2; JSON report per §3; exit codes 0 / 1 / 2 (usage); offline (the probe set makes no network call; asserted by a test with the network stubbed to throw) | 08, 23 |
| TR-INS-10 | MUST | Desktop first-run hook: after install or version change (`desktop-settings.json` `lastDoctorVersion`), run the doctor in the backend once, store the report in `userData/doctor/<version>.json`, show a dialog only when a MUST component fails or the kernel is unavailable | 08 |
| TR-INS-11 | MUST | STEP probe: export a box through the configured STEP path, re-import, compare volume within 1e-6 relative; STEP import / export go through the native kernel first (`exportStep` / `importShapes` capabilities), the Python bridge stays for CadQuery / build123d code exchange (§11 D4) | 09 |
| TR-INS-12 | MUST | DWG converter setting: Settings > Exchange > DWG converter (path + kind `libredwg` / `oda`), stored in `desktop-settings.json`, overridden by policy, passed to the backend as `LLULL_DWG2DXF` / `LLULL_ODA_CONVERTER` explicitly (the `LLULL_*` strip stays). Probe: run the converter on a 1-entity DWG fixture (`validation/data`, to be authored with a licence-clean tool, §11 D3), compare the DXF entity count. Refusal code `INS_DWG_CONVERTER_ABSENT`; the message drops the Docker reference | 10 |
| TR-INS-13 | MUST | Windows signing: every PE in the app (Electron exe, `native/*.exe`/`*.dll`, `python/**/*.exe`/`*.dll`/`*.pyd`, `server/**/*.node`) and the installers are Authenticode-signed (SHA-256, RFC 3161 timestamp) by a CI step with the key in an HSM or a cloud signing service [R1][R3]; files already validly signed by their vendor keep their signature. `signtool verify /pa /all` over the install is a release gate | 11 |
| TR-INS-14 | MUST | macOS: every Mach-O (app, helpers, `native/*`, `python/**/*.so` and `*.dylib`) signed with Developer ID, hardened runtime, secure timestamp; `entitlements.mac.plist` holds only the runtime exceptions a test proves necessary (start from the JIT exception V8 needs and remove each other one unless a test fails without it) [R5][R6]; notarize with `notarytool`, staple the dmg and the app; `spctl --assess` and `stapler validate` are release gates. Native mac bundle (`@loader_path` rpath) is a prerequisite (deferred today, `desktop/README.md`) | 11 |
| TR-INS-15 | MUST | Linux: deb with `Depends` derived from the closure check, an AppArmor profile `/etc/apparmor.d/llull` granting `userns` to the Electron binary on Ubuntu 24.04 [R18]; AppImage documented with the FUSE 2 package name per release (`libfuse2` / `libfuse2t64`) [R29] and the sandbox limitation; SHA-256 sums file signed (detached signature) for both | 01, 11 |
| TR-INS-16 | MUST | Installers: NSIS keeps `oneClick: false` + install-mode page (per-user default, no elevation), fixed `nsis.guid` (changing `appId` must never break upgrades [R10]); silent `/S` with `/currentuser` or `/allusers` verified on the built installer (third-party docs only [R14]); MSI target `perMachine: true`, explicit `upgradeCode`, `msiexec /quiet` [R12]; both register a silent uninstall | 03, 04, 14 |
| TR-INS-17 | MUST | Runtime writes only to per-user locations (`userData`, `~/.llull`, the crash dir); a test makes the install folder read-only and runs the doctor plus a save / autosave cycle | 18 |
| TR-INS-18 | MUST | Update channel per §5.4: `electron-updater` NSIS / AppImage / deb / mac zip targets [R7], `generic` provider at a configurable URL, `verifyUpdateFileAuthenticodeSignature` default verifier with `publisherName` set [R8], mac update requires the signed app [R7]; `stagingPercentage` for staged rollouts [R7]; no check when policy disables it or the machine is offline (no error shown) | 12 |
| TR-INS-19 | MUST | Offline update package: `llull-<v>-<platform>-update.zip` = signed installer + `latest*.yml` + blockmap + `llull-update.json` (version, sha512 per file, minimum compatible document format) signed with the release key (detached signature, public key pinned in the app). File > Install update from file… and `llull update --from <path>` verify signature, checksum and Authenticode / Developer ID before running the installer | 12 |
| TR-INS-20 | MUST | Rollback: `allowDowngrade` only for a package chosen explicitly by the user or IT (never from the online channel); before downgrading, the app snapshots `userData` to `userData/backups/<from>-<to>/`; a document whose format is newer than the running app opens read-only with `INS_DOCUMENT_NEWER` | 13 |
| TR-INS-21 | MUST | Uninstall per §5.5; the app records every file it writes outside `userData` and `~/.llull` (CLI launcher, `PATH` entry, skills it copied) in `~/.llull/installed-artifacts.json`, which the uninstaller and `llull uninstall-cli` read | 14 |
| TR-INS-22 | MUST | SBOM per §5.6: CycloneDX 1.6 or later JSON per platform, merged from npm (`server`, Electron app), Cargo metadata (already walked by `prepare-native` `rustLicences`), `LLULL_NATIVE.json`, python-build-standalone + `pip inspect` of the bundled interpreter, fonts; every component with name, version, purl, sha256 of the shipped file(s), licence (SPDX id); shipped at `resources/sbom/` and published with the release; SPDX export COULD | 15 |
| TR-INS-23 | MUST | Notices: `resources/licenses/THIRD-PARTY-NOTICES.txt` generated from the SBOM plus the licence texts; build fails when a component has no licence text or an SPDX id outside an allowlist reviewed by the owner (§11 D2); `llull licenses [--json]` and Help > About > Licences read it | 16 |
| TR-INS-24 | MUST | CRA file per §5.7 (`SECURITY.md`, `docs/CRA.md`, support-period field in `LLULL_NATIVE.json` / About box, SBOM vulnerability scan in the release workflow with an offline advisory database snapshot) | 17 |
| TR-INS-25 | SHOULD | Release gate: Microsoft Defender scan of the installers and the unpacked app on the reference VM (`MpCmdRun -Scan -ScanType 3 -File …`), zero detections; false positives submitted through the Microsoft Security Intelligence portal [R2] before publishing | 19 |
| TR-INS-26 | SHOULD | Policy reader per §3 `InstallPolicy`; invalid policy ⇒ `INS_POLICY_INVALID` and safe defaults (updates off, code execution off) | 21 |
| TR-INS-27 | MUST | `llull doctor --bundle <zip>` per §5.2; a test asserts no `.llull`, `autosave*`, vault object or token value in the archive | 22 |
| TR-INS-28 | SHOULD | Size and timing collection in the install matrix: unpacked size, installer size, install seconds, first-start-to-ready seconds, doctor seconds per VM profile | 02, 20 |

## 3. Data model

```ts
// Host-side report (server/src/install/report.ts); returned in check_installation data and by llull doctor --json
type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip';
type ComponentId =
  | 'app' | 'integrity' | 'signature' | 'backend' | 'web' | 'kernel' | 'compute' | 'mesher' | 'gpu'
  | 'python' | 'step' | 'dwg' | 'fonts' | 'userData' | 'disk' | 'memory' | 'platform' | 'cli' | 'policy'
  | 'updates' | 'licenses' | 'sbom';
interface ComponentCheck {
  id: ComponentId;
  required: 'must' | 'should' | 'optional';   // must ⇒ a fail makes the exit code 1
  status: CheckStatus;
  code: string;                               // INS_* (pass: INS_OK)
  value?: string | number;                    // e.g. "OCCT 7.9.2", 0.000 rel. error, "dwg2dxf 0.13.3"
  detail?: string;                            // measured facts, never a stack trace
  remediation?: string;                       // one line, the fix for this code
  millis: number;
}
interface InstallationReport {
  schema: 'llull-doctor/1';
  llullVersion: string; platform: string; arch: string; osVersion: string;
  installKind: 'per-user' | 'per-machine' | 'portable' | 'dev';
  installDir: string;                         // paths reported, never file contents
  kernel: { status: 'occt' | 'manifold-opted-in' | 'unavailable'; code: string; reason?: string; occtVersion?: string };
  policy: Partial<InstallPolicy> & { source: 'none' | 'registry' | 'managed-preferences' | 'file' };
  checks: ComponentCheck[];
  summary: { must: { pass: number; fail: number }; warn: number };
}

// Admin policy (FR-INS-21); every field optional
interface InstallPolicy {
  updates: { check: boolean; source?: string /* https URL or UNC / file path */; channel?: 'stable' | 'beta' };
  kernelFallback: 'deny' | 'allow';
  dwg?: { kind: 'libredwg' | 'oda'; path: string };
  allowCodeExecution: boolean;                // import_code (default false, as LLULL_ALLOW_CODE_EXECUTION today)
}

// Offline update manifest (TR-INS-19), signed detached (llull-update.json.sig)
interface UpdateManifest {
  schema: 'llull-update/1';
  version: string; platform: string; arch: string; releaseDate: string;
  files: { name: string; sha512: string; size: number }[];
  documentFormat: { writes: number; readsAtLeast: number };   // rollback guard (TR-INS-20)
  supportEnds: string;                                         // CRA Art. 13(19) end-of-support month (YYYY-MM)
}
```

Document model: unchanged. `kernelSettings` provenance already records the OCCT version (KI7).

## 4. Commands and CLI

| Surface | Kind | Params / flags | Behaviour |
| ------- | ---- | -------------- | --------- |
| `check_installation` | read-only command, toolset `core` | `{ components?: ComponentId[], refresh?: boolean }` | returns `data: InstallationReport` from `ctx.installation` (host port, §2). The host refreshes probes when `refresh` or the cached report is older than the running version; without the port: `INS_PROBE_UNAVAILABLE` (renderer-local mode). `@invariant read-only` `@failure no port -> INS_PROBE_UNAVAILABLE` |
| `kernel_info` | read-only (existing) | unchanged | adds `data.status` (`occt` / `manifold-opted-in` / `unavailable`), `data.code` (INS_*), `data.fallbackPolicy`; the remediation text comes from the INS code table, not the generic "restart the app" |
| `llull doctor` | CLI verb | `--json`, `--bundle <zip>`, `--component <id>`, `--strict` (warn ⇒ exit 1), `--app` | without `--app`: builds the probe in-process from the install layout (works when the backend cannot start); with `--app`: `check_installation` on the running backend |
| `llull licenses` | CLI verb | `--json`, `--component <name>` | reads `resources/licenses` and the SBOM; no document |
| `llull update` | CLI verb | `--from <path>`, `--check` | offline package install / online check, same verifier as the app (TR-INS-19) |
| `llull uninstall-cli` | CLI verb | — | removes the launcher and the `PATH` entry it added (TR-INS-21) |
| `llull.exe --doctor` | Electron main argv | `--json` | runs the CLI doctor with the app runtime and exits; for IT scripts without the shim |

Registry: one new command (`check_installation`); the CLI verbs are host verbs like `status`, `skills`, `crashes`.

## 5. Algorithms and procedures

### 5.1 Dependency closure (TR-INS-01, 02, 04)

1. Walk every file of the staged app; keep PE (`MZ` + `PE\0\0`), ELF, Mach-O (incl. fat).
2. Read its import table (PE import + delay-import directory; ELF `DT_NEEDED`, `DT_RUNPATH`; Mach-O `LC_LOAD_DYLIB`,
   `LC_RPATH`), resolve each name the way the platform loader does for this file: Windows app folder of the importing
   module's process, then `System32` (the loader's order puts the application folder before `PATH` [R16]); ELF
   `$ORIGIN` runpaths; Mach-O `@rpath` / `@loader_path` [R17].
3. A name resolved inside the install ⇒ recurse; resolved to the OS allowlist ⇒ stop; else ⇒ error
   `INS_NATIVE_DLL_MISSING <importer> -> <module>`.
4. Output `build/closure.json` (every edge) for the SBOM and the VM test.

The walker lives in Rust (`llull-compute inspect-deps`, C7): no `dumpbin` / `otool` / `ldd` dependency, same code at build
time and in the doctor (`integrity` check re-runs it on the installed tree, budget §8).

### 5.2 Doctor components (TR-INS-09)

| Component | Required | Check (offline) | Fail / warn codes |
| --------- | -------- | --------------- | ----------------- |
| `platform` | must | OS name / version / arch against FR-INS-01 | `INS_PLATFORM_UNSUPPORTED` (fail), `INS_PLATFORM_EOL` (warn: Windows 10 after its security updates end) |
| `memory`, `disk` | should | RAM and free space of `userData` volume against the published minimum (FR-INS-02) | `INS_MEMORY_BELOW_MIN`, `INS_DISK_LOW` (warn) |
| `app`, `integrity` | must | version, asar integrity fuse on; sha256 of every file against `resources/install-manifest.json`; closure walk | `INS_BUNDLE_MODIFIED`, `INS_NATIVE_DLL_MISSING` |
| `signature` | must (Windows, macOS) | Authenticode of every PE / codesign + staple of the app | `INS_SIGNATURE_INVALID`, `INS_NOT_NOTARIZED` |
| `backend` | must | backend starts on loopback, `/health` with the token challenge | `INS_BACKEND_START` |
| `web` | must | `web/index.html` and the hashed assets present | `INS_WEB_BUNDLE` |
| `kernel` | must | TR-INS-08 self-test; reports `occtVersion` | `INS_KERNEL_MISSING`, `INS_KERNEL_START_FAILED`, `INS_NATIVE_DLL_MISSING`, `INS_KERNEL_VERSION_MISMATCH`, `INS_KERNEL_SELFTEST_FAILED`; `INS_KERNEL_FALLBACK_OPTED` (warn) |
| `compute` | must | `llull-compute --version` + a 10-sample field job against its CPU twin | `INS_COMPUTE_MISSING`, `INS_COMPUTE_FAILED` |
| `mesher` | should | `llull-mesh --version` reports Netgen + OCCT; mesh a 10 mm cube, element count > 0 | `INS_MESHER_MISSING`, `INS_MESHER_FAILED` |
| `gpu` | optional | wgpu adapter present? (raster, topopt) | `INS_GPU_CPU_FALLBACK` (info) |
| `python` | must | bundled interpreter runs `-I -c` import of the bridge modules; versions vs lock | `INS_PYTHON_MISSING`, `INS_PYTHON_PACKAGE` |
| `step` | must | TR-INS-11 round trip | `INS_STEP_ROUNDTRIP` |
| `dwg` | optional | TR-INS-12 | `INS_DWG_CONVERTER_ABSENT` (info), `INS_DWG_CONVERTER_FAILED` (warn) |
| `fonts` | must | bundled fonts readable (`server/src/fontProvider.ts`) | `INS_FONTS_MISSING` |
| `userData` | must | create / fsync / rename / delete a temp file in `userData`, `~/.llull`, crash dir | `INS_USERDATA_NOT_WRITABLE` |
| `cli` | optional | launcher installed and on `PATH`? | `INS_CLI_NOT_ON_PATH` (info) |
| `policy` | should | parse policy | `INS_POLICY_INVALID` (warn) |
| `updates` | optional | effective channel and source; last check result (no network call by the doctor) | `INS_UPDATES_DISABLED` (info) |
| `licenses`, `sbom` | must | files present and parse | `INS_LICENSES_MISSING`, `INS_SBOM_MISSING` |

`--bundle`: `doctor.json`, `LLULL_NATIVE.json`, `closure.json`, the installer log if found, the last 2 MB of the backend
log, names (not contents) of crash reports, effective policy. Nothing else.

### 5.3 Kernel self-test closed form (TR-INS-08)

Cube of edge a = 10 mm minus a cylinder of radius r = 3 mm through it along z: V = a³ − π r² a = 1000 − 90π
= 717.256661… mm³ (derived). Pass when |V_kernel − V| / V ≤ 1e-9 (the VC-KRN-01 volume tolerance class, KI7).

### 5.4 Update flow (TR-INS-18..20)

1. Check: only when policy and setting allow; source = policy, else release config; a failed request is logged, never
   shown as an error.
2. Download with blockmap differential download where the target supports it [R7].
3. Verify: Windows `publisherName` + Authenticode of the downloaded installer (default verifier rejects what it cannot
   verify [R8]); macOS: Squirrel.Mac requires the signed app [R7]; Linux: sha512 from the signed manifest.
4. Install on quit / restart; the next start runs the doctor (TR-INS-10).
5. Offline: same steps 3–4 from a package (TR-INS-19). IT channel: MSI is not updatable by electron-updater [R12]; IT
   pushes the next MSI (same `upgradeCode` ⇒ major upgrade) and sets policy `updates.check = false`.
6. Rollback: the user picks an older signed package; TR-INS-20 snapshot first.

CRA Annex I asks for security updates installed automatically by default with an opt-out [R22]. Per-user installs from
the public download therefore default to "check and install on restart"; managed installs set it by policy. This is the
one network use of llull and it is optional (AF-41 holds: nothing needs it).

### 5.5 Uninstall (TR-INS-21)

| Item | Per-user NSIS | Per-machine NSIS / MSI | macOS | deb / AppImage |
| ---- | ------------- | ---------------------- | ----- | -------------- |
| program files | `%LOCALAPPDATA%\Programs\llull` removed | `%ProgramFiles%\llull` removed | drag to Trash (documented) | package files / the AppImage |
| shortcuts, file association, uninstall key | removed (HKCU) | removed (HKLM) | — | `.desktop`, MIME entries removed |
| CLI launcher + `PATH` entry, copied skills | removed via `installed-artifacts.json` | same, per user at next login (documented limit) | `llull uninstall-cli` | same |
| `userData`, `~/.llull/vault`, crash reports, autosave | kept; removed when "also remove my llull data" is ticked / `/removedata` (custom NSIS page; electron-builder's `deleteAppDataOnUninstall` is one-click only [R10]) | kept for every user (documented) | kept | kept |

### 5.6 SBOM (TR-INS-22)

Inputs already present: `cargo metadata` walk (`prepare-native.mjs` `rustLicences`), `LLULL_NATIVE.json` (OCCT /
Netgen versions + source sha256), python-build-standalone release + `pip inspect`, `server` and `desktop` lock files,
Electron version (Chromium version from its release notes), `server/fonts`. Output: one CycloneDX JSON per platform
[R23] with `metadata.component` = llull, `components[]` with purl (`pkg:npm`, `pkg:cargo`, `pkg:pypi`, `pkg:generic` for
OCCT / Netgen / CPython), `hashes` of the shipped files, `licenses` (SPDX ids), and `dependencies` from the closure and the
package graphs. CRA minimum is "at the very least the top-level dependencies" [R22]; llull ships the full graph.

### 5.7 CRA file (TR-INS-24) — prepared, applicability to be decided (§11 D7)

- Support period and end-of-support month in the About box and the update manifest (Art. 13(8), 13(19): at least five
  years unless expected use is shorter [R21]).
- `SECURITY.md`: single point of contact, CVD policy, supported versions (Art. 13(17), Annex I Part II [R21][R22]).
- Vulnerability handling: release workflow scans the SBOM against an advisory database snapshot (offline at build time);
  findings tracked per release.
- Security updates kept downloadable ≥ 10 years or the support period (Art. 13(9) [R21]).
- Reporting: a written procedure for actively exploited vulnerabilities and severe incidents (Art. 14, applicable from
  11 September 2026 [R20]).
- Technical documentation outline (Art. 31, Annex VII) and the risk assessment (Art. 13(2)-(3)); conformity route and
  product category are left to the legal review.

## 6. Packaging configuration (target, `desktop/electron-builder.yml`)

```yaml
win:
  target: [nsis, msi]
  signtoolOptions: { publisherName: [<legal name on the certificate>] }   # also the updater's publisherName
nsis: { oneClick: false, perMachine: false, guid: <fixed GUID>, include: build/uninstall-data-page.nsh }
msi:  { perMachine: true, upgradeCode: <fixed GUID> }
mac:  { hardenedRuntime: true, entitlements: build/entitlements.mac.plist, notarize: true, target: [dmg, zip] }
linux: { target: [deb, AppImage], deb: { afterInstall: build/apparmor/postinst.sh } }
publish: { provider: generic, url: <release URL, overridable by policy> }
```

Placeholders in `<…>` are owner decisions (§11 D1).

## 7. Stable codes

| Code | Severity | Raised by | Remediation (shown verbatim) |
| ---- | -------- | --------- | ---------------------------- |
| `INS_OK` | pass | doctor | — |
| `INS_PLATFORM_UNSUPPORTED` / `INS_PLATFORM_EOL` | fail / warn | doctor | list of supported platforms |
| `INS_MEMORY_BELOW_MIN` / `INS_DISK_LOW` | warn | doctor | published minimum |
| `INS_BUNDLE_MODIFIED` | fail | doctor | reinstall; file list in detail |
| `INS_SIGNATURE_INVALID` / `INS_NOT_NOTARIZED` | fail | doctor, updater | reinstall from the official package |
| `INS_BACKEND_START` / `INS_WEB_BUNDLE` / `INS_FONTS_MISSING` | fail | doctor | reinstall; support bundle |
| `INS_KERNEL_MISSING` | fail | backend, doctor, refusals | reinstall; the exact kernel is part of the app |
| `INS_KERNEL_START_FAILED` / `INS_NATIVE_DLL_MISSING` | fail | backend, doctor, build | names the binary and module; reinstall; support bundle |
| `INS_KERNEL_VERSION_MISMATCH` / `INS_KERNEL_SELFTEST_FAILED` | fail | backend, doctor | support bundle |
| `INS_KERNEL_FALLBACK_OPTED` | warn | kernel_info, every exact-kernel command summary | mesh results are approximate; turn the setting off after fixing the kernel |
| `INS_COMPUTE_MISSING` / `INS_COMPUTE_FAILED` / `INS_MESHER_MISSING` / `INS_MESHER_FAILED` | fail / warn | doctor | reinstall |
| `INS_GPU_CPU_FALLBACK` | info | doctor | none needed (CPU twin is bit-exact) |
| `INS_PYTHON_MISSING` / `INS_PYTHON_PACKAGE` / `INS_STEP_ROUNDTRIP` | fail | doctor, exchange | reinstall |
| `INS_DWG_CONVERTER_ABSENT` | info (doctor) / refusal (import) | doctor, `import_dwg` | install LibreDWG `dwg2dxf` or ODA File Converter, set it in Settings > Exchange, or save as DXF |
| `INS_DWG_CONVERTER_FAILED` | warn | doctor | check the converter path / version |
| `INS_USERDATA_NOT_WRITABLE` | fail | doctor | folder named in detail |
| `INS_CLI_NOT_ON_PATH` / `INS_UPDATES_DISABLED` | info | doctor | hint |
| `INS_POLICY_INVALID` | warn | doctor, host | fix the policy; safe defaults in force |
| `INS_UPDATE_SIGNATURE` / `INS_UPDATE_CHECKSUM` | refusal | updater, `llull update` | package rejected; obtain it from the official source |
| `INS_UPDATE_DOWNGRADE_BLOCKED` | refusal | online channel | downgrade only from an explicit package |
| `INS_DOCUMENT_NEWER` | warn | load | opened read-only; update llull |
| `INS_LICENSES_MISSING` / `INS_SBOM_MISSING` | fail | doctor, build | reinstall |
| `INS_PROBE_UNAVAILABLE` | refusal | `check_installation` without a host | use `llull doctor` |

CLI: every code appears in `--json`; exit 1 iff a `must` check fails (or any warn with `--strict`).

## 8. Budgets (spec targets; measured values replace them in `validation/expected_results.json`)

| Operation | Today | Budget |
| --------- | ----- | ------ |
| `llull doctor` full run, reference VM | — | ≤ 20 s cold, ≤ 5 s without `integrity` re-hash |
| Kernel start self-test (TR-INS-08) | start 12 ms measured on Linux (KI7 / RS1) | ≤ 2 s including spawn on the 4 GB-RAM VM profile |
| Unpacked install | 16 GB (broken build, ASC) | ≤ 1.5 GB (FR-ASC-01) |
| Per-user install time, reference VM | — | TBD — measure with the install matrix (TR-INS-28) |
| First start to ready window | — | TBD — measure with the install matrix |
| Network calls on a run with updates off | — | 0 (asserted) |

## 9. Test strategy

| Level | What | VC |
| ----- | ---- | -- |
| unit (core) | `check_installation` with a fake `ctx.installation`: report pass-through, missing port refusal, purity | VC-INS-08 |
| server tests | kernel fallback policy (`installGeometryKernel` with injected `startNative` failing: `deny` ⇒ null kernel + code; `allow` ⇒ Manifold + warn), self-test closed form, doctor probes with fakes, offline assertion, DWG setting plumbing, bundle content of `--bundle` | VC-INS-08, 09, 10, 11, 22, 23 |
| desktop tests | layout shared with CLI, settings → backend env for DWG, first-run hook, `installed-artifacts.json`, read-only install dir | VC-INS-07, 10, 16 |
| packaging scripts | closure walker on fixtures (missing DLL, `$ORIGIN`, `@rpath`), lock install, SBOM completeness against the closure | VC-INS-05, 17, 18 |
| release workflow | signature verification of every PE / Mach-O, notarization staple, Defender scan | VC-INS-12, 13, 21 |
| install-vm matrix (`validation/plans/`) | §validation VM profiles × install / doctor / work / update / rollback / uninstall | VC-INS-01..07, 14..16, 19, 20 |
| review | licence allowlist, CRA file, platform list | VC-INS-24, 25 |

## 10. Delivery plan

| Milestone | Content | Depends on | Effort (agent-days) |
| --------- | ------- | ---------- | ------------------- |
| M0 | ASC M0 (installer builds); install layout resolver; sanitized spawn env; Rust import walker + closure check; compiler runtime staging; pinned Python lock | ASC M0 | 4 |
| M1 | kernel fallback policy + self-test; `check_installation` + `llull doctor` + `--bundle`; first-run hook; Settings DWG path; doc fixes | M0 | 5 |
| M2 | signing pipeline (Windows, macOS incl. native mac bundle + notarization), Linux deb + AppArmor + checksums | M0, owner D1 | 4 (+ certificate lead time) |
| M3 | VM images + matrix runner + plans; size / time collection | M1, M2 | 3 |
| M4 | MSI + policy reader; NSIS silent switches verified; uninstall data page | M2 | 2 |
| M5 | updater (online, offline package, rollback, staged rollout) | M2, M4 | 3 |
| M6 | SBOM + notices + licence allowlist + CRA file + Defender gate | M0; owner D2, D7 | 3 |

Total ≈ 24 agent-days plus certificate and notarization account lead time. Order: M0 → M1 → M2 → M3 → M6 → M4 → M5.
Pack 06 E2E reuses the M3 VM images; every pack's `install-vm` cases run on them.

## 11. Open questions and proposed decisions

| # | Question | Proposed | Owner / legal |
| - | -------- | -------- | ------------- |
| D1 | Signing identity: who signs (legal entity, country)? | **Windows:** Azure Artifact Signing if llull is published by an organisation in the EU / UK / USA / Canada (≈ USD 9.99 / month, no hardware token, CI-friendly) [R3]; else an OV certificate on a cloud HSM (keys must be in a hardware crypto module [R1]). **No EV**: it no longer changes SmartScreen [R2][R3]. **macOS:** Apple Developer ID (Developer Program membership). | owner |
| D2 | llull's own licence (none declared today) | decide before the first public installer; it fixes what may be bundled (D3), the notice text and the CRA "commercial activity" question (D7) | **owner + legal** |
| D3 | DWG: bundle a converter? | **Not now.** ODA File Converter: non-members may use it for non-commercial applications only and ODA does not distribute it [R34] ⇒ never bundle; user installs it under their own terms. LibreDWG: GPL-3.0-or-later [R33]; shipping `dwg2dxf` as a separate executable called by argv may be "mere aggregation" [R35], but that depends on llull's licence and distribution form ⇒ legal review; until then optional, user-installed, configured in Settings. Long-term native DWG reading belongs to pack 08 XCH | **legal** |
| D4 | STEP through Python or the native kernel? | native kernel first (one OCCT, no Python dependency for STEP); Python only for code exchange — coordinate with pack 08 XCH | owner (agreed with XCH) |
| D5 | Python payload: CadQuery now pulls `cadquery-ocp 8.0.1.1`, `casadi` (LGPL-3.0 [R39]), `trame*`, `numba`, `scipy` [R25] | pin the version validated in SV1 (CadQuery 2.8.0 / OCP 7.9.3.1) and install `--no-deps` with only what the bridge imports; record each licence in the SBOM | owner |
| D6 | Windows C/C++ runtime: static or app-local DLLs? | static CRT for the Rust / C++ sidecars where OCCT and Netgen build with it; else app-local runtime DLLs if the Visual C++ redistributable terms allow (not verified here — TBD read the current Microsoft redistribution list); MinGW builds ship `libstdc++` / `libgcc` / `winpthread` app-local under the GCC Runtime Library Exception [R38] | owner (build) |
| D7 | Does the CRA apply to llull, and in which category / conformity route? | prepare the full file (§5.7) now; Article 14 reporting already applies since 11 September 2026 if llull is on the EU market in a commercial activity [R20] | **legal** |
| D8 | Windows 10 and arm64 | Windows 10 22H2 x64 supported while Microsoft ships security updates for it (end of support 14 October 2025, consumer ESU reported extended to October 2027 [R28]); arm64 out of scope until OCCT / Python wheels are proven | owner |
| D9 | Auto-update default for direct downloads | on, opt-out (CRA Annex I [R22]); off by policy for managed installs | owner |
| D10 | Linux distribution format priority | deb (can install the AppArmor profile) primary; AppImage best effort | owner |

## 12. References

[R1]–[R39] as in [`FUNCTIONAL_SPEC.md`](FUNCTIONAL_SPEC.md) §11; grades and extracts in [`validation/sources.md`](validation/sources.md).
