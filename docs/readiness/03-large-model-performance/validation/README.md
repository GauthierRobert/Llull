# 03 PRF — Validation plan

Specs: [`../FUNCTIONAL_SPEC.md`](../FUNCTIONAL_SPEC.md), [`../TECHNICAL_SPEC.md`](../TECHNICAL_SPEC.md). Sources and grades:
[`sources.md`](sources.md). Machine index: [`expected_results.json`](expected_results.json) (schema
[`../../vc.schema.json`](../../vc.schema.json)). Corpus: [`data/perf_corpus.json`](data/perf_corpus.json). Track gate:
[`../../VALIDATION.md`](../../VALIDATION.md).

## How it runs

- **Machine profiles** ([`../../readiness_gate.json`](../../readiness_gate.json)). Budgets gate on `office-min`
  (proposed in TECHNICAL_SPEC §8.1); `ref-win11` (owner workstation) holds the baselines and the T3 report. A value measured
  on another profile is reported, never used to pass.
- **Drivers.** `unit` (vitest, every commit): container, step params, limits, estimator, cancel purity, LOD invariance,
  gate arithmetic. `cli` (llull CLI scripts on the corpus): import, save, sizes, timings, cancel, sync payloads. `perf` (the
  perf runner `scripts/perf/run.mjs`, TECHNICAL_SPEC §9): timed metrics, 1 warm-up + 5 runs, median of per-run p95, heavy
  lock, nothing else running. `electron`: the 06 E2E harness drives the desktop app and reads `viewport_stats`
  ([`../../06-desktop-e2e/`](../../06-desktop-e2e/), reference only; this pack does not specify the harness).
- **Regression rule.** A case fails when the median exceeds its budget (`PRF_BUDGET_EXCEEDED`) or 1.20 × the stored
  baseline of the same profile (`PRF_BASELINE_REGRESSION`); readiness_gate.json `regression.budgetWorseningPercent = 20`.
- **Grades.** `A` = measured in llull or read in a primary source; `target` = a budget of this spec, derived from a cited
  threshold (derivation in TECHNICAL_SPEC §8.2); both gate. `TBD — measure` values are recorded on the first M0 run and
  then gate as regressions only.
- **Readiness level.** Pack default PRL2 (trustworthy). VC-PRF-29 (timings observable) is a PRL1 prerequisite: the other
  packs' perf-sensitive cases need it.

## Use cases

1. **UC-1 Open a large model** (FR-02, 03, 04, 18): T1 / T2 corpus models open progressively and stay interactive.
2. **UC-2 Edit and save** (FR-05, 06, 14): local edits, undo / redo, save and autosave at T2.
3. **UC-3 Import vendor STEP** (FR-10, 11, 12): fine and huge files import with budgets, codes, progress and cancel.
4. **UC-4 Share a file** (FR-08, 09): one compact, self-contained file opens identically on a clean machine.
5. **UC-5 Guard against regressions** (FR-15, 16, 20): the gate catches a 20 % slowdown and a leak.
6. **UC-6 Civil drawing** (FR-17): a 100,000-entity site plan.

## Validation cases

| VC | Proves | Level | Driver | Input | Expected / target | Tolerance | Source / grade |
| -- | ------ | ----- | ------ | ----- | ----------------- | --------- | -------------- |
| VC-PRF-01 | FR-PRF-01, TR-PRF-01 | PRL2 | unit | `data/perf_corpus.json` + fetched / generated files | every (T1, T2) × persona cell has ≥ 1 model; every pinned file matches its sha256 | exact | spec budget; pins M8 (A) |
| VC-PRF-02 | FR-PRF-02, TR-PRF-14 | PRL2 | perf | T1 models (part-11752, as1-oc-214, fc-arduino-mega, kuka-kr600, gen-civil-t1) saved as v4, opened in the app | first navigable frame ≤ 2,000 ms | median of 5 | target from S1 (repeat load < 2 s) |
| VC-PRF-03 | FR-PRF-02, TR-PRF-14 | PRL2 | perf | same | full resolution of the settled view ≤ 5,000 ms | median of 5 | target from S1; baseline part-11752 12–21 s (M1, A) |
| VC-PRF-04 | FR-PRF-02, TR-PRF-14, TR-PRF-15 | PRL2 | perf | T2 models (gen-mech-t2, gen-plant-t2, gen-steel-t2, gen-civil-t2, rc-buggy-suspension) | first navigable frame ≤ 5,000 ms | median of 5 | target from S1 (interactive < 5 s) |
| VC-PRF-05 | FR-PRF-02, TR-PRF-14 | PRL2 | perf | same | full resolution ≤ 10,000 ms; progress events shown | median of 5 | target from S2 (10 s) |
| VC-PRF-06 | FR-PRF-03, TR-PRF-10, TR-PRF-11, TR-PRF-13 | PRL2 | perf | T1 models, scripted 360° orbit, 10 s, ≥ 600 frames, 1600 × 900 canvas | frame time p95 ≤ 16.7 ms | median of 5 runs | target from S1 (60 fps) |
| VC-PRF-07 | FR-PRF-03, TR-PRF-10, TR-PRF-11 | PRL2 | perf | T2 models, same orbit | frame time p95 ≤ 33.3 ms | median of 5 runs | target from S8 (> 30 fps, B) as a spec budget |
| VC-PRF-08 | FR-PRF-03, TR-PRF-10 | PRL2 | electron | gen-mech-t2, settled shaded view | `viewport_stats.drawCalls` ≤ 200 | exact | target (same as 08 VC-ASC-08) |
| VC-PRF-09 | FR-PRF-04, TR-PRF-12 | PRL2 | perf | T2 models, 200 scripted picks on part centroids | pointer event → highlighted frame p95 ≤ 100 ms | median of 5 runs | target from S1, S2 (0.1 s) |
| VC-PRF-10 | FR-PRF-05 | PRL2 | perf | T2 models, 50 × `move` of one part via UI | command → repainted frame p95 ≤ 100 ms | median of 5 runs | target from S1 |
| VC-PRF-11 | FR-PRF-06, TR-PRF-03 | PRL2 | perf | T1 models, explicit save | ≤ 1,000 ms | median of 5 | target from S2 (1 s) |
| VC-PRF-12 | FR-PRF-06, TR-PRF-03 | PRL2 | perf | T2 models, explicit save after one edit | ≤ 5,000 ms | median of 5 | target (TECHNICAL_SPEC §8.2) |
| VC-PRF-13 | FR-PRF-06 | PRL2 | electron | T2 model, orbit while autosave fires 3 times | longest main-thread task ≤ 50 ms | max over run | target from S1 (idle 50 ms) |
| VC-PRF-14 | FR-PRF-07, TR-PRF-16, TR-PRF-19 | PRL2 | perf | T2 models after open + 20 edits + 20 undo | renderer V8 heap ≤ 2 GiB | max sample | target from S24 (4 GB cage, half) |
| VC-PRF-15 | FR-PRF-07, TR-PRF-16 | PRL2 | perf | same | Σ RSS of llull processes ≤ 8 GiB | max sample | target (half of office-min 16 GB) |
| VC-PRF-16 | FR-PRF-07, FR-PRF-19, TR-PRF-16 | PRL2 | unit | import of rc-buggy-suspension with an injected 256 MiB budget | refusal `PRF_MEMORY_BUDGET` before allocation; document unchanged; process alive | exact | target |
| VC-PRF-17 | FR-PRF-08, TR-PRF-03, TR-PRF-04 | PRL2 | cli | part-11752 imported, saved as v4 | (container bytes before zstd − non-geometry bytes) / displayed triangles ≤ 32 B | exact | target derived §1.2 / §8.2; baseline ≈ 350 B (M1, A), 356.2 (M2, A) |
| VC-PRF-18 | FR-PRF-08, TR-PRF-05 | PRL2 | unit | `import_mesh` of 3 bodies; serialize | each mesh payload stored exactly once; recorded step params hold keys only (≤ 1 KiB per body) | exact | closed form (count) |
| VC-PRF-19 | FR-PRF-09, TR-PRF-06 | PRL2 | cli | gen-mech-t2 saved; opened with an empty `LLULL_MESH_CACHE` | opens; no `MESH_ASSET_MISSING`; total volume and triangle count equal to the source | exact | target; baseline: per-machine cache (07 §13.5, A) |
| VC-PRF-20 | FR-PRF-10, TR-PRF-07 | PRL2 | cli | `syn-huge-sphere` import, default policy | process alive; body imported with `PRF_TESSELLATION_COARSENED` (or refused with `PRF_TESSELLATION_BUDGET` under `onBudget: refuse`); triangles ≤ `maxTrianglesPerBody` | exact | baseline: bridge killed (M4, A) |
| VC-PRF-21 | FR-PRF-10, TR-PRF-07 | PRL2 | cli | `fc-nema17-connector`, `syn-helical-spring`, default policy | `mass_properties` volume within 1.5 % of the exact B-rep; document ≤ 32 B/triangle | 1.5 % (QUALITY_GATES `volume`) | baseline 114 MB, 79k triangles per thread; helical spring −2.3 % (M4, A) |
| VC-PRF-22 | FR-PRF-10, TR-PRF-07 | PRL2 | unit | estimator on a sphere R = 10,000 mm, d = 0.05 mm, angular limit off | estimate = 4πR² / ((√3/4) · 8Rd) = 725,519.7457 triangles (k = 1, before rounding) | 1e-9 rel. | closed form (TECHNICAL_SPEC §1.3, §5.1) |
| VC-PRF-23 | FR-PRF-11, TR-PRF-08 | PRL2 | cli | `kuka-kr600`, `rc-buggy-suspension`, `fc-raspberry-pi-4b` via `import_step --progress` | every file imports (QUALITY_GATES `imports`, `surface-area` checks green); ≥ 1 progress event per second; time recorded | checks as QUALITY_GATES | baseline: fail (M3, A); time `TBD — measure` then regression-gated |
| VC-PRF-24 | FR-PRF-12, TR-PRF-09 | PRL2 | cli | cancel `import_step` of rc-buggy at 30 %; cancel open of gen-mech-t2 | `PRF_CANCELLED`; document hash equal to before; next command succeeds | exact | target |
| VC-PRF-25 | FR-PRF-13 | PRL2 | unit | gen-mech-t2 with LOD active vs forced full res | `measure_bounding_box`, `mass_properties`, `export_stl` bytes identical | exact | closed form (same inputs) |
| VC-PRF-26 | FR-PRF-13, TR-PRF-11 | PRL2 | electron | T2 model while orbiting / loading | "Simplified display" badge visible exactly while `viewport_stats.simplified > 0`; `PRF_DISPLAY_SIMPLIFIED` reported | exact | target |
| VC-PRF-27 | FR-PRF-14, TR-PRF-15 | PRL2 | cli | gen-civil-t1 and gen-mech-t2 over `GET /live`: 10 × undo + 10 × redo | no `snapshot` event; mean SSE bytes per undo (T2) / (T1) ≤ 1.5 | exact / ratio | target; baseline: snapshot per undo (code survey, A) |
| VC-PRF-28 | FR-PRF-15, TR-PRF-02 | PRL2 | unit | runner fixture: baseline 1,000 ms; measured 1,250 ms and 1,150 ms | 1,250 → `PRF_BASELINE_REGRESSION`; 1,150 → pass; budget overrun → `PRF_BUDGET_EXCEEDED` | exact | readiness_gate.json `regression` |
| VC-PRF-29 | FR-PRF-16, TR-PRF-18 | PRL1 | cli | every registered command run with `--timings` in the golden corpus; `llull perf report` | `data.timings.totalMs` present; report lists every metric with baseline and verdict | exact | target (AF-11) |
| VC-PRF-30 | FR-PRF-17, TR-PRF-20 | PRL2 | perf | gen-civil-t2 in the 2D view, scripted pan + zoom 10 s | frame time p95 ≤ 33.3 ms | median of 5 runs | target (T2 frame budget) |
| VC-PRF-31 | FR-PRF-18, TR-PRF-21 | PRL2 | electron | open gen-mech-t2, then `set_large_model_mode mode=off` | mode auto-on, badge visible, `PRF_LARGE_MODEL_MODE` reported; override restores the standard quality tier | exact | target; precedents S3, S5 (B/A) |
| VC-PRF-32 | FR-PRF-19, TR-PRF-17 | PRL2 | unit | `import_mesh` with 10,001 bodies; 2,000,001 triangles; a 3MF inflating past 256 MiB | `PRF_LIMIT_IMPORT_BODIES`, `PRF_LIMIT_IMPORT_TRIANGLES`, `PRF_LIMIT_IMPORT_BYTES` with `{limit, requested, cure}` | exact | limits.ts (A) |
| VC-PRF-33 | FR-PRF-20, TR-PRF-22 | PRL2 | electron | gen-mech-t2: open, close all, × 5 | `viewport_stats.geometries` and heap after 5th open within ± 5 % of the 1st | ± 5 % | target (QUALITY_GATES proposed gate 3) |

FR → VC: 01→01; 02→02, 03, 04, 05; 03→06, 07, 08; 04→09; 05→10; 06→11, 12, 13; 07→14, 15, 16; 08→17, 18; 09→19;
10→20, 21, 22; 11→23; 12→24; 13→25, 26; 14→27; 15→28; 16→29; 17→30; 18→31; 19→16, 32; 20→33. TR-PRF-23 (occlusion,
COULD) has no case: it is measured through VC-PRF-07 when built.

Derivation of VC-PRF-22: 4π · 10⁸ = 1.2566371 × 10⁹ mm²; (√3/4) · 8 · 10⁴ · 0.05 = 0.4330127 × 4,000 = 1,732.0508 mm²;
ratio = 725,519.7457 (Node, 2026-10-28).

## Plans and data

| File | Runs today | Purpose |
| ---- | ---------- | ------- |
| [`data/perf_corpus.json`](data/perf_corpus.json) | downloads: yes (`npm run quality:fetch`); generators: no (M0) | corpus definition with pins and generator recipes |
| `scripts/perf/run.mjs`, `scripts/perf/generate.mjs` | no (M0, outside this pack) | runner and generators specified in TECHNICAL_SPEC §9 and the corpus file |
