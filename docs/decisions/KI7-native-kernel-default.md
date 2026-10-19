# KI7 — The native OCCT kernel is the desktop default

Status: accepted (2026-10-19). Completes the desktop part of RS1 (native OCCT kernel); the measurements TR-KRN-02 asks for are below.

## Problem

The desktop backend ran the exact OCC kernel as opencascade.js 1.1.1 (OCCT 7.4.0p1, 2020) in a worker. RS1 built the native
`llull-kernel` sidecar (OCCT 7.9.2, shared, `LLULL_KERNEL=occt-native`) and bundled it in `resources/native`, but kept it opt-in
until it reproduced the OCP 7.9.3 numbers of the 01 KRN validation pack (TR-KRN-05, VC-KRN-25). Two OCCT versions in one product
(7.4 in the kernel, 7.9.3 in the bundled CadQuery) was the version skew TR-KRN-02 asked to remove.

## Evidence (VC-KRN-25, `server/tests/nativeKernelReference*.test.ts`, 01 TECHNICAL_SPEC §13.D, validation/README.md §6)

- 10 analytic solids incl. two at body station x = 70 m, an arc-profile revolution against its closed form, the behaviour probe and
  the 28 NIST PMI STEP files (R20): counts, validity and max tolerance equal; worst volume 1.6e-12, area 2.0e-12, centroid
  4.0e-10 mm, inertia 7.6e-13 against the OCP 7.9.3.1 reference (VC-KRN-01 tolerances: 1e-9 / 1e-6 mm); plate − cylinder face
  signature `1125f7464525c4f6` equal to the reference; inertia at 70 m 1.7e-16 against the closed form.
- 7.9.2 vs 7.9.3: the reference procedure run on plain OCCT 7.9.2 reproduces every NIST row bit for bit; no deviation to carry.
- Two native defects found by the suite and fixed with tests: the adaptive mass integration (also used by the WASM kernel) drifted up
  to 2.7e-4 in inertia on curved faces — the native kernel now uses the reference's default Gauss rule; and AP242 tessellated-only
  files, which OCCT 7.9 transfers as surface-less faces, are refused as `tessellated_only` like on 7.4.
- The existing native suites (`server/tests/native*`, 248 tests incl. the native vs WASM parity cases) stay green; where they now differ (inertia of two curved revolutions) the native
  value is the closed form and the WASM value is the documented error.
- Cost measured in RS1 (4-core Xeon, Linux, §13.D): cold start 12 ms / 9 MB RSS vs 1.73 s / +371 MB for the WASM module; box
  tessellate / mass 1.7 / 1.8 ms vs 9.2 / 9.6 ms; NIST CTC-01 import 636 ms vs 4230 ms; bundle 66 MB (OCCT 59 MB).

## Decision

- `desktop/src/backendEnv.ts` `desktopKernel`: the backend gets `LLULL_KERNEL=occt-native` when the native bundle holds
  `llull-kernel` (`hasNativeKernel`, checked by `src/main.ts` next to `nativeBundleDir`), else `occt` (the WASM kernel). An inherited
  `LLULL_KERNEL=manifold` or `occt` is kept as a diagnostic override; any other inherited value is ignored.
- The fallback chain is unchanged and stays visible: an op the sidecar lacks or a sidecar death is answered by the WASM kernel in the
  same worker (logged once per op), a missing binary gives `NATIVE_TOOL_MISSING` then WASM then Manifold, each with
  `kernel_info.fallbackReason`.
- Server, CLI and browser defaults are unchanged (`LLULL_KERNEL` unset → their current default); `occt-native` stays opt-in there.

## Consequences

- Desktop mass properties of curved and imported bodies change in the last digits (up to 1.6e-6 relative in volume on the NIST
  corpus, 2.7e-4 in inertia on arc-profile revolutions) — toward the closed form and the CAD-system GVP. Documents carry the kernel
  provenance (`occtVersion` 7.9.2), so a reload under the WASM kernel reports the version difference (TR-KRN-61).
- Imported blobs written natively differ in text (hence sha256) from WASM-written ones for the same file; geometry is identical and
  both kernels read both (§13.D).
- `relError` is no longer reported by the native kernel (the Gauss rule has no estimate); `mass_properties` omits
  `relErrorEstimate` then.

## To confirm / follow-ups

- Align `packages/kernel-occt/src/occtMass.ts` (WASM, browser and fallback) on the Gauss rule, then drop the two WASM inertia
  tolerances in `nativeKernelFeatureParity.test.ts`.
- Fuzzy booleans (TR-KRN-12) to run the last probe case (fuzzy 2e-5: 2 → 1 solids).
- B-rep text blobs that read back invalid (NIST stc_07 e3, both kernels): full-precision or binary blob format (TR-KRN-21).
- Re-triage VC-KRN-04x at solid level: 4 of its 5 "GVP disagreements" come from loose faces measured with the solid.
- macOS / Windows bundles are written but untested; until they are, the flip is exercised on Linux only.
