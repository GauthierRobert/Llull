# 05 INS — Install once, works offline, stays updated — Functional specification

Status: specification only (2026-10-28). Nothing in this pack is built. Gap id `INS`. Template:
[`../../aerospace/TEMPLATE.md`](../../aerospace/TEMPLATE.md); track rules: [`../README.md`](../README.md); operator: a
professional engineer at the desktop app, and the IT administrator who deploys it. Readiness level: **PRL1** (installable
and observable): every other pack is validated on the product this pack ships.

## 1. Summary

An engineer, or their IT administrator, installs llull once. On a locked-down office PC with no internet and no
administrator rights it starts, runs the exact OCCT kernel, imports and exports STEP, reports in one command what works
and what does not, and later updates from a signed package without losing data. Today none of that is guaranteed:

| # | Limit found (code survey of origin/main f1351cff, §1 of the technical spec) | Effect for the engineer |
| - | ------------------------------------------------------------------------- | ----------------------- |
| 1 | `llull-kernel` that cannot start (missing binary, missing DLL, crash on spawn) is replaced by the Manifold mesh kernel with one `console.warn` and `kernel_info.fallbackReason` (`server/src/geometryKernel.ts:80-96`) | booleans, volumes and fillets silently become mesh results; nothing on screen says so |
| 2 | On Windows a dev-built `llull-kernel.exe` finds the OCCT `TK*.dll` only through `PATH` (`server/src/native/nativeBinary.ts:61-86`); the bundle smoke test runs the kernel with the build machine's `PATH` (`desktop/scripts/prepare-native.mjs` `smokeTest`) | a DLL missing from the bundle is not detected at build time and fails only on a clean PC |
| 3 | The `llull` CLI installed by Help > Install Command Line Tool runs with no `LLULL_NATIVE_DIR` and no `LLULL_PYTHON` (`desktop/src/cliShim.ts`); headless (`--doc`) it looks for `solver/target/release` and `python3` on `PATH` (`nativeBinary.ts:44-50`, `server/src/pythonExchange.ts:58`) | `llull --doc` on an installed PC runs Manifold and has no STEP export (inferred from code; VC-INS-07 confirms) |
| 4 | The desktop backend drops every inherited `LLULL_*` variable (`desktop/src/backendEnv.ts:50-54`), so `LLULL_ODA_CONVERTER` / `LLULL_DWG2DXF` cannot reach it; DWG works only when `dwg2dxf` is on `PATH` | DWG import cannot be configured in the app |
| 5 | No self-test: `llull status` only reports whether the app runs (`server/src/cli/main.ts` `runStatus`); `GET /health` gives the kernel name | support cannot tell a broken install from a user error |
| 6 | Unsigned by default: signing is "the usual electron-builder env" (`desktop/electron-builder.yml:1-3`); no MSI, no per-machine silent install documented, no updater (`electron-updater` not a dependency, `desktop/package.json`) | SmartScreen / Smart App Control warnings or blocks; IT cannot deploy; updates are manual reinstalls |
| 7 | No SBOM, no aggregated notice for the npm and Python parts (only `resources/native/licenses`); llull itself declares no licence (no `LICENSE`, no `license` field) | no CRA readiness; licence compliance of the bundle unproven |
| 8 | `server/python/requirements.txt` is `cadquery>=2.4`, unpinned; CadQuery master now pins `cadquery-ocp==8.0.1.1` [R25] | two builds a week apart can bundle different OCP / OCCT versions next to the native OCCT 7.9.2 |

## 2. Context and value

- **Who needs it.** Every user: nothing else in the readiness track can be validated on the shipped product without an
  installer that works everywhere ([`../README.md`](../README.md) "Order of delivery").
- **How incumbent tools do it.**
  - Published system requirements per release: AutoCAD 2026 lists 64-bit Windows 10/11, 8 GB RAM basic, 16 GB or more
    recommended, about 10 GB disk [R30]; SOLIDWORKS 2026 supports Windows 11 64-bit only, 16 GB RAM minimum, 32 GB
    recommended, certified graphics [R31].
  - Enterprise deployment by MSI with standard silent switches, per-machine into Program Files [R12].
- **What the platforms now require.**
  - Windows: Smart App Control "will block execution of unsigned files unless the file has a positive reputation" [R2];
    EV certificates no longer bypass SmartScreen since 2024 [R2][R3]; code-signing private keys must live in a hardware
    crypto module since 1 June 2023 [R1]; AppLocker default rules allow everyone to run only from `%PROGRAMFILES%` and
    `%WINDIR%` [R15].
  - macOS: software distributed with Developer ID must be notarized (macOS 10.15+), which requires the hardened runtime,
    a secure timestamp and a valid signature on every executable [R5][R6].
  - Linux: Ubuntu 24.04 restricts unprivileged user namespaces through AppArmor, which breaks the Chromium sandbox of
    Electron AppImages unless a profile allows it [R18].
- **What the law now requires (EU).** The Cyber Resilience Act applies from 11 December 2027, its reporting duty
  (Article 14) from 11 September 2026 [R20]. Manufacturers must ship an SBOM "covering at the very least the top-level
  dependencies" [R22], security updates installed automatically by default with an opt-out [R22], a support period of at
  least five years and each security update kept available for at least ten years [R21]. Whether llull is placed on the
  market "in the course of a commercial activity" is an owner / legal question (§11 of the technical spec).

## 3. Personas and user stories

- **Engineer (desktop, standard user).**
  - US-1: "I download one file, install it without asking IT, and it works on the train with Wi-Fi off."
  - US-2: "If something is broken, Help > Check installation tells me what, with a code I can send to support."
  - US-3: "When the exact kernel is not there, the app says so before I trust a volume."
  - US-4: "An update installs over my version; my documents and autosave survive; I can go back if it breaks."
- **IT administrator.**
  - US-5: "I push one signed MSI to 200 PCs with Intune / SCCM / GPO, silently, per-machine, and remove it the same way."
  - US-6: "I can turn the update check off by policy and distribute updates myself from our share."
  - US-7: "I get an SBOM and a licence list I can hand to security and legal."
- **Agent (CLI).**
  - US-8: "`llull doctor --json` tells me, in one call, whether exact geometry, STEP and DWG are available before I plan."
- **Owner / support.**
  - US-9: "A user sends me `llull doctor --bundle`; I see versions, codes and logs, never their documents."

## 4. Scope

| Phase | Content |
| ----- | ------- |
| **MVP (M0–M3)** | M0 self-contained runtime (no `PATH` dependence, dependency closure check, pinned Python) · M1 no silent kernel fallback + `check_installation` / `llull doctor` · M2 signed Windows NSIS per-user + per-machine, signed and notarized macOS, Linux deb + AppImage with checksums · M3 clean-VM install matrix in CI |
| **V1 (M4–M6)** | M4 MSI for IT + policy · M5 update channel (online, offline package, rollback) · M6 SBOM, notices, CRA file |
| **V2** | DWG converter bundling if the owner / legal answer allows it (§11 D3); delta updates for the offline package |
| Out of scope | Microsoft Store / Mac App Store (sandboxing, per-store review); Windows on ARM and Linux arm64 (owner decision, §11 D8); licence keys and seats (removed by LC1); telemetry |

## 5. Functional requirements

| Id | Pri | Requirement | Rationale | Source |
| -- | --- | ----------- | --------- | ------ |
| FR-INS-01 | MUST | llull publishes its supported platforms per release: Windows 11 x64; Windows 10 22H2 x64 while Microsoft ships security updates for it; macOS 12 or later on Apple silicon and Intel; Ubuntu 22.04 and 24.04 x64 (deb; AppImage best effort). Anything else is "unsupported" in the install guide and in `llull doctor` | Electron 38 needs Windows 10+ and macOS 12+ | [R26][R27][R28][R29] |
| FR-INS-02 | MUST | llull publishes minimum and recommended hardware measured on the VM profiles of the validation README (CPU cores, RAM, disk, GPU or none), never copied from incumbents; `llull doctor` warns below the minimum | incumbents publish both | [R30][R31]; measured |
| FR-INS-03 | MUST | A standard Windows user with no administrator rights and no network installs llull per-user, starts it and passes `llull doctor` with every MUST component `pass` | US-1 | [R10] |
| FR-INS-04 | MUST | IT installs llull per-machine and silently: an MSI (`msiexec /i … /quiet`, fixed UpgradeCode, Program Files) and the NSIS installer with `/S` and an all-users switch; both uninstall silently; exit codes documented | US-5 | [R10][R11][R12][R13] |
| FR-INS-05 | MUST | Self-contained runtime: on a clean OS with no Python, Node, OCCT, compiler runtime or redistributable installed, with `PATH` reduced to the OS default and no `LLULL_*` variable set, every bundled component works. A DLL / shared library is always loaded from the install or the OS, never from `PATH` or the current folder | field issue: OCCT on `PATH` | [R16][R17] |
| FR-INS-06 | MUST | The exact kernel never falls back silently. In an installed build, when `llull-kernel` is missing or fails its start self-test, the backend reports kernel status `unavailable` with a stable code and the reason; the UI shows a persistent banner; commands that need the exact kernel refuse with that code. The mesh kernel replaces it only after an explicit user or policy choice, which `kernel_info`, the status bar and every affected command summary state | field issue: silent Manifold | KI7; LC1 |
| FR-INS-07 | MUST | The installed `llull` CLI uses the same bundled kernel, Python and native tools as the app, headless (`--doc`) as with `--app` | §1 row 3 | code survey |
| FR-INS-08 | MUST | `check_installation` (command) / `llull doctor` (CLI verb) checks every component and returns per component `pass` / `warn` / `fail` / `skip`, a stable code, a measured value and a one-line remediation; `--json`; exit code 0 when every MUST component passes, else 1. Fully offline, no document change. The desktop runs it after first install and after each update and shows failures; Help > Check installation runs it on demand | US-2, US-8 | AF-11, AF-41 |
| FR-INS-09 | MUST | STEP import and export work offline right after install: the doctor round-trips a box through the bundled Python bridge (export, re-import, volume within tolerance) | field issue: STEP needs the bridge | KI6 |
| FR-INS-10 | MUST | DWG import uses an optional, separately installed converter (LibreDWG `dwg2dxf` or ODA File Converter) that the user or IT points to in Settings or by policy (no environment variable needed). The doctor reports `absent` (info), `ok` with version, or `fail`. Without a converter, DWG import refuses with a stable code that names both converters and the DXF alternative. llull bundles neither converter until §11 D3 is answered | field issue: DWG converter | [R33][R34][R35] |
| FR-INS-11 | MUST | Every shipped artifact is signed: Windows installer, MSI and every PE file in the install (exe, dll, pyd, node) Authenticode-signed and timestamped; macOS app, every Mach-O inside it and the dmg signed with Developer ID, hardened runtime, notarized and stapled; Linux deb and AppImage published with SHA-256 checksums and a detached signature | Smart App Control, Gatekeeper | [R1][R2][R5][R6] |
| FR-INS-12 | MUST | Signed update channel: the app checks a configured update source (opt-out in Settings, off by policy, silent when offline), downloads, verifies the publisher signature and checksum before installing, and installs on restart. An offline update package (signed installer + signed manifest) installs from a file or a share with the same verification | US-4, US-6; CRA Annex I | [R7][R8][R9][R22] |
| FR-INS-13 | MUST | Rollback: the previous signed release reinstalls over a newer one without losing user data; the app warns before opening documents saved by a newer format version | US-4 | [R7] |
| FR-INS-14 | MUST | Uninstall is clean: program files, shortcuts, file association, registry / desktop entries, the CLI launcher and any `PATH` entry the app added are removed; user documents, autosave, vault and crash reports are kept unless the user ticks "also remove my llull data" (interactive) or passes a documented switch (silent) | IT hygiene | [R10][R11] |
| FR-INS-15 | MUST | Each release publishes a CycloneDX SBOM per platform covering every bundled component (npm, Electron, Rust crates, OCCT, Netgen, CPython, pip packages, fonts), transitive dependencies included, with versions, hashes and licences; the same file ships inside the app | CRA Annex I Part II (1) | [R22][R23][R24] |
| FR-INS-16 | MUST | The app shows every third-party licence and required notice (Help > About > Licences, `llull licenses`), the OCCT "makes use of Open CASCADE Technology" notice, the LGPL relink and source information, the PSF notice, and llull's own licence | LGPL, PSF, Apache | [R32][R36][R37][R38] |
| FR-INS-17 | MUST | CRA file: declared support period and end-of-support date, single point of contact, coordinated vulnerability disclosure policy, vulnerability monitoring of the SBOM, security updates kept downloadable for ten years, an actively-exploited-vulnerability reporting procedure (Article 14), and the technical documentation outline — scoped by the owner / legal decision on CRA applicability | CRA Art. 13, 14, 71 | [R20][R21][R22] |
| FR-INS-18 | MUST | On a locked-down PC (AppLocker default rules or equivalent, Smart App Control on, no admin, outbound network blocked) the per-machine install runs; at run time llull writes nothing under its install folder, needs no elevation, opens no non-loopback port and triggers no firewall prompt | US-5 | [R2][R15] |
| FR-INS-19 | SHOULD | Release candidates show zero detections by Microsoft Defender on the reference VM; false positives are submitted before release | unsigned Electron / NSIS installers are flagged | [R4][R19] |
| FR-INS-20 | SHOULD | Size and time budgets: unpacked install ≤ 1.5 GB (08 ASC FR-ASC-01); install time and first-start time measured per VM profile and published | download and disk on office PCs | [ASC] |
| FR-INS-21 | SHOULD | Enterprise policy: an admin-owned policy (Windows `HKLM\Software\Policies\llull`, macOS managed preferences, Linux `/etc/llull/policy.json`) sets the update source and check, the DWG converter path and the code-execution switch; users cannot override it; the doctor reports the effective policy | US-6 | [R12] |
| FR-INS-22 | MUST | `llull doctor --bundle <file>` writes a support archive: doctor JSON, versions, install and backend logs, crash report names, effective policy; never documents, autosave, vault content or tokens | US-9 | — |
| FR-INS-23 | MUST | Every installation check, refusal and warning has a stable `INS_*` code (§7 of the technical spec), works offline and is deterministic | AF-11, AF-13, AF-41 | AGENT_FIRST |

## 6. Workflows

**Engineer (per-user, offline).**

```text
1. double-click llull-Setup-<v>.exe        (signed; no UAC prompt; installs to %LOCALAPPDATA%\Programs\llull)
2. first start → check_installation runs   → "All checks passed (kernel OCCT 7.9.2, STEP, compute, mesher; DWG: no converter)"
3. Help > Check installation                → same table, Copy report / Save support bundle
```

**IT administrator (per-machine, silent).**

```text
msiexec /i llull-<v>-x64.msi /quiet /l*v install.log      # FR-INS-04
reg add HKLM\Software\Policies\llull /v UpdateSource /d \\fs01\llull\updates   # FR-INS-21
"%ProgramFiles%\llull\llull.exe" --doctor --json > doctor.json     # exit 0 = every MUST passes
msiexec /x {ProductCode} /quiet                            # FR-INS-14
```

**Agent (CLI).**

```text
llull doctor --json                       # before a plan: kernel exact? STEP? DWG?
llull kernel_info --app                   # status, fallback state and reason (FR-INS-06)
```

**Update.** Online: the app checks the source, shows "llull <v> is ready, restart to install", verifies the signature,
installs on restart, runs the doctor. Offline: File > Install update from file… (or IT pushes the MSI) with the same
verification. Rollback: install the previous signed package.

## 7. Acceptance criteria

| Given | When | Then | VC |
| ----- | ---- | ---- | -- |
| a clean Windows 11 VM, standard user, network off | run the per-user installer, start llull | installed without UAC; `llull doctor` exit 0; kernel `occt` 7.9.2 | VC-INS-01, 03 |
| the same VM, `PATH` = OS default, no VC++ redistributable | spawn every native binary from the install | each starts; every imported DLL resolves inside the install or `System32` | VC-INS-05, 06 |
| `llull-kernel.exe` deleted from the install | start the app | banner + `INS_KERNEL_MISSING`; `boolean` refuses with that code; `kernel_info.active` ≠ `manifold` unless opted in | VC-INS-08, 09 |
| the installed CLI, no app running | `llull --doc a.llull kernel_info` and `export_step` | kernel `occt`; STEP written | VC-INS-07 |
| the MSI | silent install, doctor, silent uninstall on a domain-joined VM with AppLocker default rules | exit codes 0; doctor exit 0; nothing left in Program Files / HKLM / Start menu | VC-INS-04, 16, 19 |
| a release build | verify signatures of every PE / Mach-O; notarization staple | all valid; `spctl` accepts; Smart App Control does not block | VC-INS-12, 13 |
| version N installed with documents and autosave | update to N+1 from an offline package, then roll back to N | data intact both ways; tampered package refused with `INS_UPDATE_SIGNATURE` | VC-INS-14, 15 |
| a release | read the SBOM and notices | every bundled component present with licence and hash; notices complete | VC-INS-17, 18 |
| no DWG converter | import a DWG | refusal `INS_DWG_CONVERTER_ABSENT` naming both converters and DXF; doctor shows `info` | VC-INS-11 |

## 8. Standards alignment

- Authenticode signing with keys in a hardware crypto module (CA/B Forum Baseline Requirements for Code Signing,
  §6.2.7.4) [R1]; Apple notarization requirements [R5][R6].
- Windows Installer (MSI) silent switches [R12]; NSIS command line [R13].
- SBOM: CycloneDX (ECMA-424) [R23]; SPDX (ISO/IEC 5962:2021) as an optional second export [R24].
- EU Cyber Resilience Act, Regulation (EU) 2024/2847, Articles 13, 14, 71 and Annex I [R20][R21][R22].

## 9. KPIs

| KPI | Today | Target |
| --- | ----- | ------ |
| Clean-VM install matrix profiles passing (8 profiles, validation README) | not run | 8 / 8 |
| Native binaries that need anything from `PATH` | unknown (smoke test uses build `PATH`) | 0 |
| Silent kernel fallbacks in installed builds | possible | 0 (fallback only by opt-in) |
| Unsigned PE / Mach-O files in a release | all unsigned unless `CSC_LINK` set | 0 |
| Doctor components with a stable code | 0 (no doctor) | all (§7 technical spec) |
| Bundled components missing from the SBOM | no SBOM | 0 |
| Data loss across update + rollback | not tested | 0 |

## 10. Risks and assumptions

- Signing identity depends on the owner's legal form and country (§11 D1): Azure Artifact Signing is open to organisations
  in the USA, Canada, the EU and the UK, and to individuals only in the USA and Canada [R3].
- New signed files still start without SmartScreen reputation; first users may see a prompt [R2].
- Signing third-party binaries (python-build-standalone, pip wheels) with llull's certificate makes llull vouch for them;
  the SBOM and the dependency audit must come first.
- Ubuntu 24.04 AppImage needs an AppArmor allowance or `--no-sandbox`; only the deb can install a profile [R18].
- The CRA applicability and the product category are legal questions; this pack prepares the evidence, it does not
  decide them.

## 11. References

See [`validation/sources.md`](validation/sources.md) for grades and what was taken from each.

- [R1] Baseline Requirements for Code Signing — CA/Browser Forum — https://cabforum.org/working-groups/code-signing/requirements/ (accessed 2026-10)
- [R2] SmartScreen reputation for Windows app developers — Microsoft — https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation (accessed 2026-10)
- [R3] Code signing options for Windows app developers — Microsoft — https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options (accessed 2026-10)
- [R4] NSIS False Positives — NSIS wiki — https://nsis.sourceforge.io/NSIS_False_Positives (accessed 2026-10)
- [R5] Notarizing macOS software before distribution — Apple — https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution (accessed 2026-10)
- [R6] Hardened Runtime — Apple — https://developer.apple.com/documentation/security/hardened-runtime (accessed 2026-10)
- [R7] Auto Update — electron-builder — https://www.electron.build/docs/features/auto-update (accessed 2026-10)
- [R8] NsisUpdater API — electron-builder — https://www.electron.build/docs/api/electron-updater.Class.NsisUpdater (accessed 2026-10)
- [R9] Code signing tutorial — Electron — https://www.electronjs.org/docs/latest/tutorial/code-signing (accessed 2026-10)
- [R10] nsisOptions.d.ts (app-builder-lib 26.15.3) — electron-builder — https://unpkg.com/app-builder-lib@26.15.3/out/targets/nsis/nsisOptions.d.ts (accessed 2026-10)
- [R11] NSIS configuration — electron-builder — https://www.electron.build/configuration/nsis (accessed 2026-10)
- [R12] MSI target — electron-builder — https://www.electron.build/docs/msi (accessed 2026-10)
- [R13] Command line usage (Chapter 3) — NSIS — https://nsis.sourceforge.io/Docs/Chapter3.html (accessed 2026-10)
- [R14] Silent install switches for electron-builder NSIS apps — Wingetly / community — https://wingetly.io/apps/vladimir-yakovlev/electron-mail/silent-install (accessed 2026-10)
- [R15] Executable rules in AppLocker — Microsoft — https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/applocker/executable-rules-in-applocker (accessed 2026-10)
- [R16] Dynamic-link library search order — Microsoft — https://learn.microsoft.com/en-us/windows/win32/dlls/dynamic-link-library-search-order (accessed 2026-10)
- [R17] dyld install names, `@rpath` / `@loader_path` — Apple Developer Forums; Kitware — https://developer.apple.com/forums/thread/736719 ; https://www.kitware.com//upcoming-in-cmake-2-8-12-osx-rpath-support (accessed 2026-10)
- [R18] Electron AppImage sandboxing; Ubuntu 24.04 security — AppImage docs; Canonical — https://docs.appimage.org/user-guide/troubleshooting/electron-sandboxing.html ; https://ubuntu.com/blog/whats-new-in-security-for-ubuntu-24-04-lts (accessed 2026-10)
- [R19] Defender ML detections of new unsigned installers — forum reports — https://forum.makemkv.com/forum/viewtopic.php?p=201246 (accessed 2026-10)
- [R20] Regulation (EU) 2024/2847 (Cyber Resilience Act), Article 71 — EUR-Lex — https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32024R2847 (accessed 2026-10)
- [R21] Regulation (EU) 2024/2847, Article 13 — EUR-Lex — same URL (accessed 2026-10)
- [R22] Regulation (EU) 2024/2847, Annex I — EUR-Lex — https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:02024R2847-20241120 (accessed 2026-10)
- [R23] ECMA-424 CycloneDX Bill of Materials specification — Ecma International — https://ecma-international.org/publications-and-standards/standards/ecma-424/ (accessed 2026-10)
- [R24] SPDX, ISO/IEC 5962:2021 — Linux Foundation / ISO — https://spdx.dev/ ; https://www.iso.org/standard/81870.html (accessed 2026-10)
- [R25] CadQuery setup.py (install requirements) — CadQuery — https://raw.githubusercontent.com/CadQuery/cadquery/master/setup.py (accessed 2026-10)
- [R26] Electron README v38.0.0, Platform support — Electron — https://github.com/electron/electron/blob/v38.0.0/README.md (accessed 2026-10)
- [R27] Electron 38.0.0 release notes — Electron — https://www.electronjs.org/blog/electron-38-0 (accessed 2026-10)
- [R28] Windows 10 end of support and consumer ESU extension — secondary press — https://www.helpnetsecurity.com/2026/06/26/microsoft-windows-10-free-security-updates-esu-program/ (accessed 2026-10)
- [R29] Ubuntu 24.04 AppImage FUSE package rename (libfuse2t64) — Ubuntu users list — https://lists.ubuntu.com/archives/ubuntu-users/2024-May/312458.html (accessed 2026-10)
- [R30] System requirements for AutoCAD 2026 — Graitec (reseller summary of Autodesk) — https://graitec.com/ca-en/blog/system-requirements-autocad-2026/ (accessed 2026-10)
- [R31] System requirements — Dassault Systèmes SOLIDWORKS — https://www.solidworks.com/support/system-requirements (accessed 2026-10)
- [R32] OCCT licensing; OCCT_LGPL_EXCEPTION.txt — Open Cascade — https://occt3d.com/open-cascade-technology/index.html ; https://github.com/Open-Cascade-SAS/OCCT/blob/master/OCCT_LGPL_EXCEPTION.txt (accessed 2026-10)
- [R33] LibreDWG README (licence GPL-3.0-or-later, status) — GNU — https://github.com/LibreDWG/libredwg/blob/master/README (accessed 2026-10)
- [R34] What are ODA Viewer and ODA File Converter? — Open Design Alliance — https://www.opendesign.com/faq/question/what-are-oda-viewer-and-oda-file-converter (accessed 2026-10)
- [R35] GPL FAQ, "mere aggregation" — FSF — https://www.gnu.org/licenses/gpl-faq.html#MereAggregation (accessed 2026-10)
- [R36] History and License (PSF License Agreement, incorporated software) — Python — https://docs.python.org/3/license.html (accessed 2026-10)
- [R37] CadQuery LICENSE (Apache-2.0) — CadQuery — https://github.com/CadQuery/cadquery/blob/master/LICENSE (accessed 2026-10)
- [R38] GCC Runtime Library Exception 3.1 — FSF — https://www.gnu.org/licenses/gcc-exception-3.1.html (accessed 2026-10)
- [R39] CasADi licence (LGPL-3.0) — Debian copyright file — https://metadata.ftp-master.debian.org/changelogs/main/c/casadi/testing_copyright (accessed 2026-10)
- [ASC] [`../../design/08-assembly-scale/FUNCTIONAL_SPEC.md`](../../design/08-assembly-scale/FUNCTIONAL_SPEC.md) FR-ASC-01, 02 (installer build defects)
