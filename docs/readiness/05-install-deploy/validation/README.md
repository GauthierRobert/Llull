# 05 INS — Validation plan

What is proven: a llull release installs on a clean office PC (per-user without admin, per-machine silently by IT),
runs offline with the exact kernel and STEP, tells the truth about every component through `llull doctor`, updates and
rolls back from signed packages without data loss, uninstalls cleanly, and ships an SBOM and complete notices.

Grades follow [`../../../plant/TEMPLATE.md`](../../../plant/TEMPLATE.md): **A** primary source read or measured in
llull; **B** one secondary extract; **C** located, not confirmed. Targets are budgets of this spec (grade `target`,
gating). Baselines below come from the code survey of origin/main f1351cff (technical spec §1); none of the VM cases
has been run yet. Index: [`expected_results.json`](expected_results.json) (schema
[`../../vc.schema.json`](../../vc.schema.json)); sources: [`sources.md`](sources.md).

## Readiness level

Pack default **PRL1** (installable + observable): every other pack's validation runs on the product these cases ship.
Cases about enterprise adoption and legal file (MSI policy, CRA, licence review) are marked **PRL4** (adoptable): they
do not block PRL1–PRL3 work but block adoption by an office.

## VM images (referenced centrally by `install-vm` cases of every pack)

All images: fresh vendor install media, current patches at image creation, **no** Python, Node, Git, OCCT, Visual C++
redistributable, compiler, CAD software or llull trace; English locale plus one non-English locale variant (path with
non-ASCII user name, see profile notes); snapshot before each run, reverted after. Installers are copied in through a
mounted ISO, then the virtual NIC is disconnected unless the row says "host-only".

| Id | OS | vCPU / RAM / disk / GPU | User and policy | Used for |
| -- | -- | ----------------------- | --------------- | -------- |
| `vm-win11-std` | Windows 11 Pro x64, current GA release | 4 / 8 GB / 64 GB / none (basic display adapter, software rendering) | local **standard** user `Jürgen Müller` (non-ASCII profile path); UAC default; Smart App Control on where the image allows it (it blocks unsigned files without reputation [R2]; how to force it on in an image: TBD — check Microsoft's Smart App Control documentation) | per-user install, doctor, work, update, rollback, uninstall |
| `vm-win11-locked` | Windows 11 Enterprise x64 | 4 / 8 GB / 64 GB / none | admin installs per-machine; daily user is standard; **AppLocker default rules enforced** for exe, msi, script [R15]; outbound network blocked; host-only NIC to a local update server for update rows | MSI silent install, policy, locked-down run, update channel |
| `vm-win11-min` | Windows 11 Pro x64 | 2 / 4 GB / 64 GB / none | standard user | minimum hardware measurement (FR-INS-02) |
| `vm-win10-std` | Windows 10 22H2 x64 | 4 / 8 GB / 64 GB / none | standard user | Windows 10 support while it receives security updates |
| `vm-macos-arm` | macOS current release, Apple silicon | 4 / 8 GB / 64 GB / virtual GPU | standard (non-admin) user; Gatekeeper default; network off **before first launch** (proves the stapled ticket) | dmg install, notarization offline, doctor |
| `vm-macos-12-x64` | macOS 12 Monterey, Intel | 4 / 8 GB / 64 GB / virtual GPU | standard user | minimum macOS (Electron 38 floor [R27]) |
| `vm-ubuntu-2404` | Ubuntu 24.04 LTS desktop x64 | 4 / 8 GB / 64 GB / none | sudo only for `apt install ./llull.deb`; AppArmor user-namespace restriction at its default [R18] | deb install, sandbox on, doctor |
| `vm-ubuntu-2204` | Ubuntu 22.04 LTS desktop x64 | 4 / 8 GB / 64 GB / none | as above; `libfuse2` present for the AppImage row | deb + AppImage |

Reference machine for timings outside VMs: `ref-win11` (the owner's Windows 11 workstation), as in the other packs.

## Use cases

1. **UC-1 Engineer installs alone.** Per-user installer, no admin, offline; doctor passes; exact kernel; STEP works.
2. **UC-2 IT deploys.** Per-machine MSI, silent, AppLocker, policy; silent uninstall.
3. **UC-3 Something is broken.** A DLL or the kernel is missing: the app says so with a code; nothing silently degrades.
4. **UC-4 Update and rollback.** Online and offline packages, signature checked, data kept.
5. **UC-5 Compliance.** SBOM, notices, signatures, CRA file reviewed.

## Validation cases

| VC | PRL | Proves | Driver | Input / procedure | Expected | Tolerance | Source / grade |
| -- | --- | ------ | ------ | ----------------- | -------- | --------- | -------------- |
| VC-INS-01 | PRL1 | FR-INS-01, 03, 08; TR-INS-10, 16 | install-vm | `vm-win11-std`, network off: run `llull-Setup-<v>.exe` as the standard user (per-user default), start the app, `llull.exe --doctor --json` ([`plans/win-install-check.ps1`](plans/win-install-check.ps1) `-Mode PerUser`) | no UAC prompt; doctor exit 0; every `must` check `pass`; `kernel.status = occt`, `occtVersion = 7.9.2` | exact | target |
| VC-INS-02 | PRL1 | FR-INS-01, 03 | install-vm | same on `vm-win10-std` | same as VC-INS-01; `INS_PLATFORM_EOL` warn allowed | exact | target |
| VC-INS-03 | PRL1 | FR-INS-01, 11 | install-vm | `vm-macos-arm` and `vm-macos-12-x64`, network off: open the dmg, copy to /Applications, first launch, doctor ([`plans/posix-install-check.sh`](plans/posix-install-check.sh) `mac`) | Gatekeeper opens without "unidentified developer"; doctor exit 0; kernel `occt` | exact | target; [R5][R6] |
| VC-INS-04 | PRL1 | FR-INS-01; TR-INS-15 | install-vm | `vm-ubuntu-2404`, `vm-ubuntu-2204`: `apt install ./llull_<v>_amd64.deb` offline, launch **without** `--no-sandbox`, doctor | app window opens with the Chromium sandbox on; doctor exit 0 | exact | target; baseline B: Electron AppImages fail on 24.04 without an AppArmor allowance [R18] |
| VC-INS-05 | PRL1 | FR-INS-05; TR-INS-01, 02 | unit | closure walker on fixtures (PE importing a DLL absent from the tree; ELF with `$ORIGIN`; Mach-O with `@rpath`) and on the staged app of a release build | fixtures: the missing import is reported as `INS_NATIVE_DLL_MISSING <importer> -> <module>`; release tree: 0 unresolved imports | exact | target |
| VC-INS-06 | PRL1 | FR-INS-05; TR-INS-03, 04 | install-vm | `vm-win11-std` without any VC++ redistributable: run each `resources/native/*.exe --version` with `PATH=%SystemRoot%\System32`; then put a folder holding a fake `TKernel.dll` first on `PATH` and in the current folder and run the kernel self-test | all start (no exit 0xC0000135); the bundled `TKernel.dll` is the one loaded (module path reported by the self-test) | exact | target; [R16] |
| VC-INS-07 | PRL1 | FR-INS-07; TR-INS-05 | install-vm | after VC-INS-01: Help > Install Command Line Tool; app closed; `llull new --doc a.llull`, `llull add_box size=[10,10,10] --doc a.llull`, `llull kernel_info --doc a.llull --json`, `llull export_step --doc a.llull --save a.step` | `active = occt`; `a.step` written and non-empty | exact | target; baseline (code survey, not run): headless CLI resolves no `LLULL_NATIVE_DIR` and `python3` |
| VC-INS-08 | PRL1 | FR-INS-06, 08; TR-INS-07, 09 | unit | server test: `installGeometryKernel` with an injected native start failure under `LLULL_KERNEL_FALLBACK=deny` and `allow`; then `boolean` and `kernel_info` | `deny`: no kernel, `kernel_info.data.status = unavailable`, code `INS_KERNEL_START_FAILED`, `boolean` refused with that code; `allow`: Manifold, `INS_KERNEL_FALLBACK_OPTED` in `kernel_info` and in the `boolean` summary | exact | target; baseline A (code): Manifold with one `console.warn` (`geometryKernel.ts:80-96`) |
| VC-INS-09 | PRL1 | FR-INS-06 | install-vm | `vm-win11-std`: delete `resources/native/TKBO.dll`, start the app | status bar banner "Exact kernel unavailable"; doctor `fail` `INS_NATIVE_DLL_MISSING llull-kernel.exe -> TKBO.dll`; `boolean` refuses; no Manifold result produced | exact | target |
| VC-INS-10 | PRL1 | FR-INS-08, 23; TR-INS-09 | unit | doctor with fake probes for every component and status; network functions stubbed to throw | JSON matches `llull-doctor/1`; every check has an `INS_*` code and remediation when not `pass`; exit 0 / 1 per `must`; `--strict` turns warn into 1; no network call | exact | target |
| VC-INS-11 | PRL1 | FR-INS-10; TR-INS-12 | unit + install-vm | (a) unit: no converter ⇒ `import_dwg` refusal; Settings path ⇒ backend env carries `LLULL_ODA_CONVERTER`; (b) `vm-win11-std` with LibreDWG `dwg2dxf` installed by the user and set in Settings: doctor `dwg` pass, import the fixture DWG | (a) `INS_DWG_CONVERTER_ABSENT` naming LibreDWG, ODA and DXF; doctor `dwg` = info; (b) fixture imports with its entity count | exact | target; baseline A (code): desktop strips `LLULL_*` (`backendEnv.ts:50-54`) |
| VC-INS-12 | PRL1 | FR-INS-11, 18; TR-INS-13 | install-vm | `vm-win11-std`: `Get-AuthenticodeSignature` over every PE in the install and the installers; launch with Smart App Control on | unsigned or invalid = 0; every signature timestamped; Smart App Control does not block any process | exact | target; [R2] |
| VC-INS-13 | PRL1 | FR-INS-11; TR-INS-14 | install-vm | `vm-macos-arm`: `codesign --verify --deep --strict`, `spctl --assess --type execute`, `xcrun stapler validate` on app and dmg; list Mach-O files without a Developer ID signature | all pass; unsigned Mach-O = 0; entitlements = the reviewed minimal set | exact | target; [R5][R6] |
| VC-INS-14 | PRL1 | FR-INS-12; TR-INS-18, 19 | install-vm | `vm-win11-std` + `vm-win11-locked` (host-only update server): N with a saved document and an autosave; update to N+1 (online generic source; then offline package from a file); repeat with a package whose installer has one byte changed and with a manifest signed by another key | N+1 runs, doctor exit 0, document and autosave intact (sha256 equal); tampered ⇒ `INS_UPDATE_SIGNATURE` / `INS_UPDATE_CHECKSUM`, N untouched | exact | target; [R7][R8] |
| VC-INS-15 | PRL1 | FR-INS-13; TR-INS-20 | install-vm | after VC-INS-14: install N from its signed package; open a document saved by N+1 with a newer format | N runs; `userData/backups/<N+1>-<N>/` exists; data intact; newer document opens read-only with `INS_DOCUMENT_NEWER`; online channel refuses the downgrade (`INS_UPDATE_DOWNGRADE_BLOCKED`) | exact | target |
| VC-INS-16 | PRL1 | FR-INS-14; TR-INS-21 | install-vm | file-system + registry (HKCU, HKLM) snapshot before install and after uninstall, for per-user NSIS, per-machine MSI, and per-user NSIS with "also remove my llull data" | leftovers outside the documented kept list = 0; with the data option: 0 llull paths left; CLI launcher and its `PATH` entry gone | exact | target |
| VC-INS-17 | PRL1 | FR-INS-15; TR-INS-06, 22 | unit | release SBOM vs `closure.json`, the npm / Cargo / pip lock data and the staged file list | validates against the CycloneDX JSON schema; every shipped binary and every package present with version, sha256 and SPDX licence; missing = 0 | exact | target; [R23][R22] |
| VC-INS-18 | PRL1 | FR-INS-16; TR-INS-23 | unit | `THIRD-PARTY-NOTICES.txt` vs SBOM; `llull licenses --json` | one licence text per component; OCCT notice contains "makes use of Open CASCADE Technology" wording; PSF notice; llull licence present; build fails on an unlisted SPDX id | exact | target; [R32][R36] |
| VC-INS-19 | PRL4 | FR-INS-04, 18 | install-vm | `vm-win11-locked`: `msiexec /i llull.msi /quiet /l*v`, policy set, log in as standard user, run, doctor, `msiexec /x {ProductCode} /quiet`; also `llull-Setup.exe /S /allusers` | exit codes 0; app runs under AppLocker default rules; doctor exit 0 with `policy.source = registry`; silent uninstall leaves nothing in Program Files / HKLM / Start menu | exact | target; [R12][R13][R15] |
| VC-INS-20 | PRL1 | FR-INS-02, 20; TR-INS-28 | install-vm | every profile: installer size, unpacked size, install seconds, first-start-to-ready seconds, doctor seconds; `vm-win11-min` runs the 08 ASC `fidelity.lld` plan | unpacked ≤ 1.5 GB; other values recorded and published as the minimum / recommended table | 10 % on timings | target; FR-ASC-01 |
| VC-INS-21 | PRL1 | FR-INS-19; TR-INS-25 | install-vm | `vm-win11-std`: Defender full scan of installers and install folder with current offline signatures | detections = 0 | exact | target; risk B/C: [R4][R19] |
| VC-INS-22 | PRL1 | FR-INS-22; TR-INS-27 | unit | `llull doctor --bundle` on a fixture user profile holding a `.llull`, an autosave, a vault object and a token file | archive lists only the documented files; none of the fixture contents or the token value inside | exact | target |
| VC-INS-23 | PRL1 | FR-INS-23, 08 | install-vm | `vm-win11-std` with updates off by setting: start, doctor, one modelling session ([`plans/win-install-check.ps1`](plans/win-install-check.ps1) `-Mode Offline`), firewall logging on | outbound connection attempts = 0 | exact | target; AF-41 |
| VC-INS-24 | PRL4 | FR-INS-16, 17 | review | recorded owner + legal review: llull licence chosen; licence allowlist approved; DWG bundling answer (D3); CRA applicability (D7) | review record signed and dated in `docs/decisions/` | — | target |
| VC-INS-25 | PRL4 | FR-INS-17; TR-INS-24 | review | check `SECURITY.md`, `docs/CRA.md`, support period in About box and update manifest, Art. 14 procedure, SBOM vulnerability scan step in the release workflow | every item of technical spec §5.7 present | — | target; [R20][R21][R22] |
| VC-INS-26 | PRL4 | FR-INS-21; TR-INS-26 | unit | policy fixtures: updates off, DWG path, code execution off; an invalid policy | effective values reported by the doctor; user setting cannot override; invalid ⇒ `INS_POLICY_INVALID` with updates off and code execution off | exact | target |
| VC-INS-27 | PRL1 | FR-INS-09; TR-INS-11 | install-vm | `vm-win11-std`, `vm-macos-arm`, `vm-ubuntu-2404`, network off: doctor `step` probe and a manual export / import of a 10 mm cube | re-imported volume = 1000 mm³ | 1e-6 rel. | closed form (A) |
| VC-INS-28 | PRL1 | FR-INS-06; TR-INS-08 | unit | server native test: kernel self-test solid (cube a = 10 mm minus through cylinder r = 3 mm) | V = 1000 − 90π = 717.2566611769186 mm³ | 1e-9 rel. | closed form (A), derived §5.3 |
| VC-INS-29 | PRL1 | FR-INS-18; TR-INS-17 | install-vm | `vm-win11-locked` per-machine install (folder not writable by the user): doctor, save a document, wait for autosave, quit; diff of the install folder | doctor exit 0; save and autosave succeed; files created or changed under the install folder = 0 | exact | target |
| VC-INS-30 | PRL1 | FR-INS-01 | install-vm | `vm-ubuntu-2204`: AppImage with `libfuse2`; `vm-ubuntu-2404`: AppImage with `libfuse2t64` | 22.04 runs with the sandbox; 24.04 runs or shows the documented AppArmor message (best effort) | exact | target; [R18][R29] |

Every FR maps to at least one VC: FR-01→01, 02, 03, 04, 30; 02→20; 03→01, 02; 04→19; 05→05, 06; 06→08, 09, 28;
07→07; 08→01, 08, 10, 23; 09→27; 10→11; 11→03, 12, 13; 12→14; 13→15; 14→16; 15→17; 16→18, 24; 17→24, 25; 18→12,
19, 29; 19→21; 20→20; 21→26; 22→22; 23→10, 23.

## Plans and scripted checks

| File | Runs today | Purpose |
| ---- | ---------- | ------- |
| [`plans/win-install-check.ps1`](plans/win-install-check.ps1) | partly: the signature, `PATH`-sanitized spawn and snapshot steps run on any build; doctor steps need M1 | Windows rows (VC-INS-01, 02, 06, 07, 09, 12, 16, 19, 23, 29) |
| [`plans/posix-install-check.sh`](plans/posix-install-check.sh) | partly: codesign / spctl / stapler and the Linux sandbox launch run on any build | macOS and Ubuntu rows (VC-INS-03, 04, 13, 27, 30) |
| [`plans/matrix.json`](plans/matrix.json) | data | VM profile × scenario × VC list, read by the matrix runner (M3) |
| `data/` (not yet authored, M3) | — | `fake-TKernel.dll` (a DLL exporting nothing, for the planting test of VC-INS-06) and a one-entity DWG fixture made with a licence-clean tool (VC-INS-11), each with sha256 and licence |

Invocation: `win-install-check.ps1 -VmProfile <id> -Mode <scenario> -Installer <path> [-UpdatePackage <path>]`;
`posix-install-check.sh <mac|deb|appimage> <id> <artifact>`. The `Uninstall` scenarios compare against the
`<profile>-before.snapshot.json` written by the install scenario of the same snapshot.

The scripts never install anything from the network and never modify anything outside the VM. They write a result
JSON next to themselves (`<profile>-<scenario>.result.json`) that the matrix runner compares with `expected_results.json`.
