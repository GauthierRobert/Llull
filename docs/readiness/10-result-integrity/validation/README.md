# 10 INT — Validation plan

Machine: `ref-win11` unless stated. Pack level: **PRL 2 trustworthy**. Grades as in
[`../../../plant/TEMPLATE.md`](../../../plant/TEMPLATE.md): **A** primary source / cited closed form / read in llull's code,
**B** one secondary extract, **target** a budget or behaviour set by this spec (gating). Machine index:
[`expected_results.json`](expected_results.json). Sources: [`sources.md`](sources.md).

Design rule for every case: **the case must fail on today's code.** Each row's "Fails today because" column states the
defect it would catch. A case that cannot fail on main 00d5326f5 is not a validation case and is not listed.

## 1. Use cases

UC-1 check a structure · UC-2 trust an FE margin · UC-3 know which kernel answered · UC-4 respect a lock · UC-5 trust the
gate · UC-6 trust a verification (FUNCTIONAL_SPEC §3).

## 2. Validation cases

| VC | Proves | Driver | Input | Expected | Tol. | Grade | Fails today because |
| -- | ------ | ------ | ----- | -------- | ---- | ----- | ------------------- |
| VC-INT-01 | FR-INT-01, TR-INT-01 | unit | test command `{ a: z.string().trim(), b: z.number().default(7) }`, params `{ a: '  x ' }` | `run` receives `{ a: 'x', b: 7 }` | exact | target | `run` gets `{ a: '  x ' }`, b undefined (guard.ts:148) |
| VC-INT-02 | FR-INT-01, TR-INT-03 | unit | every registered command, minimal valid input from its JSON Schema | value seen by `run` deep-equals `paramsValidator.parse(input)` | exact | target | ~22 `.trim()` schemas differ |
| VC-INT-03 | FR-INT-02, TR-INT-04 | unit | `check_steel_members` / bracing / purlin / foundation-plate rows with grades `"A36"`, `"1.0570"`, `"Fe360"`, `""` | each row refused `STL_GRADE_UNKNOWN`, overall verdict ≠ pass | exact | target | all checked at fy = 355 |
| VC-INT-04 | FR-INT-03, TR-INT-04 | unit | grade `"S235JR"`, t = 12 mm | fy = 235 N/mm², rule named | exact | A (S1) | passes today; kept as guard against regressions of the parser |
| VC-INT-05 | FR-INT-03, TR-INT-04 | unit | `"S355J2"`, t = 50 mm | fy = 335 N/mm² | exact | B (S2) | 355 |
| VC-INT-27 | FR-INT-03, TR-INT-04 | unit | `"S355J2"`, t = 90 mm | `STL_THICKNESS_OUT_OF_RANGE` | exact | target | 355, no refusal |
| VC-INT-06 | FR-INT-04, TR-INT-05 | unit | bolt M20 class 10.9 | Fv,Rd = 0.5·1000·245/1.25 = 98,000 N; Ft,Rd = 0.9·1000·245/1.25 = 176,400 N | 1e-9 rel | B (S2, S3) | 8.8 values 94,080 / 141,120 N |
| VC-INT-07 | FR-INT-04, TR-INT-05 | unit | M18 class 8.8 | As = 192 mm² (ISO 898-1 closed form, 192.5 → table 192); Fv,Rd = 73,728 N | 1e-9 rel | A (S3) area · B (S2) resistance | nearest size M16 or M20 used |
| VC-INT-08 | FR-INT-04, TR-INT-05 | unit | M19 class 8.8; M20 class "12.9" | `STL_BOLT_SIZE_NONSTANDARD` (neighbours M18, M20); `STL_BOLT_CLASS_UNKNOWN` | exact | target | silently M20 / class param absent |
| VC-INT-09 | FR-INT-02, FR-INT-04 | unit | bolt check without a class | `data.defaulted` contains `{ input: 'boltClass', value: '8.8' }`; summary names it | exact | target | no defaulted record |
| VC-INT-10 | FR-INT-05, TR-INT-06 | unit | `alignment_report` design speed 130 km/h | `CIV_SPEED_OUT_OF_TABLE`, domain [20, 120] | exact | target | 120 row used silently |
| VC-INT-11 | FR-INT-05, TR-INT-06 | unit | design speed 65 km/h, e = 0.06 | 70 km/h row used and named in the summary; Rmin = 65²/(127·(0.06 + f₇₀)) with f₇₀ = 0.15 → 4225 / 26.67 = 158.4 m | 0.1 m | A (S4) formula · target row rule | row not named |
| VC-INT-12 | FR-INT-06, TR-INT-07 | cli | steel cantilever L 1000, b 20, h 50 mm, E 210 GPa, ν 0.3, P 1000 N tip; meshes: C3D10 4 layers; C3D4 1 layer | C3D10: δ within 2 % of Timoshenko 7.634 mm (E-B 7.619), verdict `adequate`; C3D4 1 layer: verdict `inadequate` | 2 % | A (S5) | verdict from bbox (thinnest 20 mm / mean edge) can read adequate |
| VC-INT-13 | FR-INT-06, TR-INT-07 | cli | tube OD 100, wall 2, L 500 mm, C3D4 with 1 element through the wall, cantilever load | verdict `inadequate` | exact | target | bbox thinnest extent = 100 mm → "adequate" |
| VC-INT-14 | FR-INT-06, TR-INT-08 | unit | `compute_margins` on the inadequate result of VC-INT-13; then with `acceptInadequateMesh: true` | rows `not_assessed`, code `FEA_MESH_INADEQUATE`, overall ≠ pass; override → numeric states + `data.overrides` | exact | target | margins reported normally |
| VC-INT-15 | FR-INT-07, TR-INT-09 | cli | backend with the exact kernel requested and unavailable (`LLULL_NATIVE_DIR` = empty dir); `add_box` ×2, `boolean_subtract`, `mass_properties` | each kernel result `provenance.kernel = 'manifold'`, `fallbackReason` non-empty; one stderr warning per degraded result; `/health` `requested ≠ active`; entity `meta.approximate = true` | exact | target | only a server `console.warn` |
| VC-INT-16 | FR-INT-07, TR-INT-09 | unit | `StatusBar` with `kernel { requested: 'occt-native', active: 'manifold' }` | chip text "Mesh kernel (degraded)", reason in tooltip | exact | target | name only |
| VC-INT-17 | FR-INT-07, TR-INT-09 | cli | `llull run --validate` on a plan with `boolean_union`, `mass_properties`, `fillet_edge`, no exact kernel | one warning per step (3) | exact | target | only `fillet_edge` warned |
| VC-INT-18 | FR-INT-08, TR-INT-10 | unit | every registered mutating command (annotation not `readOnly`) whose minimal valid input targets an entity on a locked layer | 100 % refused `LAYER_LOCKED`, document unchanged; `update_layer` unlock then the same command succeeds; replay with `ctx.replaying` succeeds | exact | target | all succeed through `execute` |
| VC-INT-19 | FR-INT-08, TR-INT-10 | perf | 4,000-box save-loop document, 1,000 `move_entity` calls, guard on / off | p95 added time ≤ 1 ms per command | ≤ 1 ms | target | guard absent |
| VC-INT-20 | FR-INT-09, TR-INT-11 | unit | server started without token; `POST /command` (no Origin); with `--insecure-no-token`; `Origin: http://localhost:5173` with no `LLULL_ALLOWED_ORIGINS`; `GET /health` with `Host: evil.test` | 401 `SEC_TOKEN_REQUIRED`; 200 + `/health.insecure = true`; 403; 403 | exact | target | 200 / 200 / allowed / 200 |
| VC-INT-21 | FR-INT-10, TR-INT-12 | unit | 10 kB zip with one entry declaring 900 MB (ratio ≈ 90,000) through every zip importer (`.3mf`, `.xlsx`, scan pack, BCF); XML with 50,000 nested elements; 20 MiB attribute | `ZIP_LIMIT_EXCEEDED` / XML limit codes; RSS growth ≤ 300 MB; no crash | ≤ 300 MB | target | 1 GiB default, no ratio cap |
| VC-INT-22 | FR-INT-11, TR-INT-13 | cli | `LLULL_REQUIRE_TOOLS=calculix npm --prefix server test -- fea` with CalculiX removed from PATH; same without the env | first: non-zero exit, `TST_REQUIRED_TOOL_SKIPPED`; second: green, prints `skipped by tool: calculix N` | exact | target | green either way, no count |
| VC-INT-23 | FR-INT-12, TR-INT-15 | unit | managed item released at A; then `verify_release A` | `state: 'partial'`, `geometryVerified: false`, `unchecked[0].scope = 'geometry'`, summary starts `partial:` | exact | target | reads as a clean verification |
| VC-INT-24 | FR-INT-13, TR-INT-16 | unit | `runFeaSolve` with a `beforeDeck` that rejects `boom` | solve completes; summary contains `native mapping failed (boom); mapped in TypeScript` | exact | target | failure invisible |
| VC-INT-25 | FR-INT-13, TR-INT-16 | unit | `useLiveDocument` with 3 consecutive failed snapshot fetches | `liveStatus = 'out_of_sync'`, banner with Reload | exact | target | `.catch(() => undefined)`, no state |
| VC-INT-26 | FR-INT-14, TR-INT-14 | unit | fallback inventory + source scan; a fixture check file containing `fy ?? 355` | contract test: every entry has a test; scan reports the fixture hit as unlisted | exact | target | no inventory |

Gating: every MUST case with grade A or target gates PRL 2. Grade B cases (VC-INT-05 value, VC-INT-06, VC-INT-07 resistance)
report only until pack 07 reads EN 1993-1-1 / 1-8 (D7) and upgrades them to A.

## 3. Traceability

| FR | Cases |
| -- | ----- |
| FR-INT-01 | 01, 02 |
| FR-INT-02 | 03, 09 |
| FR-INT-03 | 04, 05, 27 |
| FR-INT-04 | 06, 07, 08, 09 |
| FR-INT-05 | 10, 11 |
| FR-INT-06 | 12, 13, 14 |
| FR-INT-07 | 15, 16, 17 |
| FR-INT-08 | 18, 19 |
| FR-INT-09 | 20 |
| FR-INT-10 | 21 |
| FR-INT-11 | 22 |
| FR-INT-12 | 23 |
| FR-INT-13 | 24, 25 |
| FR-INT-14 | 26 |

Every FR has at least one case, and every MUST FR has at least one gating case (G-01..G-08 of
[`../../VALIDATION.md`](../../VALIDATION.md) §6).
