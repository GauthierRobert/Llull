# PHY-03: Thermal analysis — technical specification

Gap id **THM** · status: specification · written 2026-10-15 · functional spec: [`FUNCTIONAL_SPEC.md`](FUNCTIONAL_SPEC.md)
· validation: [`validation/README.md`](validation/README.md) · sources: [`validation/sources.md`](validation/sources.md)

## 1. Current state in llull

| Area | What exists | Path | Limit for thermal |
| ---- | ----------- | ---- | ----------------- |
| Today's core material | `Material { name, density, color, metalness, roughness, finish? }` | `packages/core/src/model/types.ts` (`interface Material`) | No thermal property at all |
| Today's code | A `grep -ril "heat transfer\|thermal conduct\|emissiv\|thermal expansion"` over `packages/*/src`, `server/src`, `server/python` returns nothing | — | No thermal capability |
| Toolsets | `TOOLSET_NAMES = core, 2d, 3d, measure, parametric, assembly, exchange, building, civil` | `packages/mcp/src/toolsets.ts` | `analysis` is added by 05 |
| Plugin dependency rule | `plugins-and-kernels-depend-on-core-only`: a `packages/domain-*` module may import only `packages/core` (and itself) | `.dependency-cruiser.cjs` | **A `domain-physics` package cannot import `@cae`** (see §2.1) |
| After 08 MAT (spec) | `PropertyValue` with `property: 'k' \| 'cp' \| 'cte' \| 'density' …`, `TemperatureDependence { mode, points, temperatureUnit }`, linear interpolation, no extrapolation (`MAT_TEMPERATURE_OUT_OF_RANGE`) | `docs/aerospace/08-materials-standards-libraries/TECHNICAL_SPEC.md` §3.1, §5.5 | Data only; nothing consumes k / cp |
| After PHY-01 (spec) | `PropertyModel` on `MaterialRecord.propertyModels?` (`model/propertyModel.ts`); consumer API `resolvePropertyModel` / `evaluatePropertyModel` / `tabulatePropertyModel` (`model/propertyModelEval.ts`); refuses outside the equation range (`PROP_OUT_OF_RANGE`), never extrapolates; PHY-01 names PHY-03 as the builder of `*CONDUCTIVITY` / `*SPECIFIC HEAT` tables through `tabulatePropertyModel` | `docs/physics/01-property-models/TECHNICAL_SPEC.md` §3 | This pack only consumes it |
| After 05 FEA (spec) | `AnalysisModel` / `AnalysisCase` in core `model/analysis.ts`; `AnalysisType = 'static' \| 'modal' \| 'buckling'`; `FeaTarget` with `facesNear` / `edgesNear` / `pointsNear`; Gmsh `mesh` bridge op; `FeArtifactStore`; INP writer; FRD/DAT readers; `record_fe_mesh` / `record_fea_results` validated against the artifact store; staleness by input hash; transports `fea_mesh`, `fea_solve`, `fea_import_results`, `fea_export` | `docs/aerospace/05-fea-cae-handoff/TECHNICAL_SPEC.md` §2–§5 | Mechanical only; "thermal analysis possible later through CalculiX `*HEAT TRANSFER`" |
| Bundled solver | CalculiX (05) — its source already contains `*HEAT TRANSFER`, `*FILM`, `*RADIATE`, `*DFLUX`, `*CFLUX`, `*GAP CONDUCTANCE`, `*VIEWFACTOR`, `*PHYSICAL CONSTANTS`, `*CONDUCTIVITY`, `*SPECIFIC HEAT`; **no `*LATENT HEAT`** | `src/calinput.f`, `doc/CalculiX.tex` at commit fd588701 [R7] | Nothing to add to the installer |

## 2. Target architecture

```
src/ui (thermal glyphs, temperature map, limits table)         server/ (unchanged 05 transports fea_mesh / fea_solve / fea_import_results / fea_export)
        │ dispatch                                                      │ spawns bundled ccx (05)
        ▼                                                               ▼
src/app  installDefaultPlugins(): cae (05) + thermal (this pack)      packages/mcp: toolset "analysis" (05) gains the thermal names
        ▼
packages/domain-physics/src (@phys)   CadPlugin "thermal", toolset "analysis"
   thermal/commands/  add_thermal_bc, set_initial_temperature, define_amplitude, set_thermal_step, add_cavity_radiation,
                      add_thermal_contact, add_temperature_limit, (queries) thermal_report, check_thermal,
                      check_temperature_limits, compute_view_factors, thermal_analytic_check, dispose_thermal_limit (human gate)
   thermal/extension.ts  AnalysisTypeExtension for 'heat_steady' | 'heat_transient' (pure):
                      validateCase · inputHashFields · writeDeckSections · summariseResults · checkItems
   thermal/viewFactors.ts  polygon contour integration (pure)          thermal/analytic.ts  closed forms (pure)
   thermal/units.ts   thermal unit conversions (CalculiX units table)
        ▼ (core public API only — L10, dependency-cruiser rule)
packages/core/src
   model/analysis.ts   (05) + thermal data types of §3 (ThermalBc, Amplitude, ThermalStep, …) and AnalysisType members
   plugins/plugin.ts   + optional `analysisExtensions?: readonly AnalysisTypeExtension[]` on CadPlugin (proposal, §2.1)
   model/propertyModel.ts + propertyModelEval.ts (PHY-01, read via resolve/evaluate/tabulatePropertyModel)   model/types.ts materialRecords (08, read)
```

### 2.1 Placement decision forced by the dependency rule

`docs/physics/README.md` §6.2 proposes a `packages/domain-physics` plugin that **extends** 05's `@cae` writers and readers.
The enforced rule `plugins-and-kernels-depend-on-core-only` (`.dependency-cruiser.cjs`, part of `npm run check`) forbids
`domain-physics → domain-cae` imports. Loosening the rule is not allowed (architecture L2: "never loosen a rule"). This
pack therefore proposes, **pending decision** (§11 Q1):

- **Proposal A (preferred): extension port in core.** The types every analysis discipline shares already live in core
  (`model/analysis.ts`, 05 TR-FEA-02). Core gains one interface, `AnalysisTypeExtension` (§3.2), and `CadPlugin` gains an
  optional `analysisExtensions` field; `plugins/host.ts` exposes `analysisExtension(type)`. `@cae` dispatches its deck
  writer, result summariser, staleness hash and `check_analysis` on that lookup for types it does not own; `@phys` provides
  pure implementations that see only core types. The mesh and result artifact shapes that both need (05 `FeMesh`, parsed
  FRD blocks) move from `@cae/artifacts.ts` to `core/model/analysis.ts` as read-only types. `src/app` installs both
  plugins. No package imports another package.
- **Proposal B (fallback): discipline inside `domain-cae`.** `packages/domain-cae/src/thermal/` with its own `CadPlugin`
  `thermal` exported from the same package (the rule allows intra-package imports). Simpler, but grows `domain-cae` with
  every PHY discipline.

Everything below is written for Proposal A; under B only the paths change.

**Laws respected:** L1 (every change is a command; meshing/solving stay 05 transports that record results through the
validated `record_*` commands), L2 (core public API only; no fs/process in `@phys`), L3 (pure commands), L4 (the
`analysis` slice is the only state; arrays live in the 05 artifact store by hash), L5 (zod schemas; toolset `analysis`),
L6 (server forwards; deck sections and summarisers are pure), L8 (feature steps; `*Near` targets re-resolve on replay),
L9 (face targeting and `compute_view_factors` read the kernel only through `ctx.kernel`, `requiresKernel`), L10 (domain
plugin, installed in `src/app/plugins.ts`).

**Requirements (technical)**

| Id | Pri | Requirement |
| -- | --- | ----------- |
| TR-THM-01 | MUST | `AnalysisType` (core `model/analysis.ts`) gains `'heat_steady' \| 'heat_transient'`, owned by this pack and listed here (README §6.2). 05's mechanical code paths ignore unknown types through the extension lookup. |
| TR-THM-02 | MUST | `CadPlugin "thermal"` in `@phys` (toolset `analysis`) with the commands of §4, `guards` (none beyond 05's), `document.validate` for the thermal fields of §3, and `analysisExtensions: [heatSteady, heatTransient]` (Proposal A). |
| TR-THM-03 | MUST | Thermal material view `ThermalMaterialView` (§3.3) is built per part from the 08 record through PHY-01 `resolvePropertyModel` (property `k`, `cp`, `density`) and `tabulatePropertyModel(model, 'T', range, relTol)` for temperature tables; no thermal property is stored in the analysis slice. |
| TR-THM-04 | MUST | Thermal units (§5.3): conversions into the 05 unit system follow the CalculiX units table [R7] and round-trip to 1e-12. |
| TR-THM-10 | MUST | Deck sections for `heat_steady` (§5.1): `*HEAT TRANSFER, STEADY STATE` step, prescribed temperature as `*BOUNDARY` DOF 11, `*FILM` `Fx`, `*DFLUX` `Sx` / `BF`, `*CFLUX` DOF 11, `*NODE FILE NT, RFL`, `*EL FILE HFL`. Byte-identical for identical inputs. |
| TR-THM-11 | MUST | Face labels per element type follow the CalculiX face numbering tables (tet: 1 = 1-2-3, 2 = 1-4-2, 3 = 2-4-3, 4 = 3-4-1; hex 1–6; quadratic elements use the corner-node faces) [R7]; unit-tested on a hand-built mesh. |
| TR-THM-12 | MUST | Volumetric generation given as total power (W) is converted to W/m³ with the part volume from the mesh artifact (sum of element volumes), and the conversion is reported in `data`. |
| TR-THM-13 | MUST | `heat_transient`: `*INITIAL CONDITIONS, TYPE=TEMPERATURE` (mandatory), `*HEAT TRANSFER` (with `DIRECT` when `fixedIncrements`, `DELTMX` when set), `*AMPLITUDE` tables, output at the requested times (`*NODE FILE, TIME POINTS=` or frequency, decided by deck test §9). |
| TR-THM-14 | MUST | Radiation: `*PHYSICAL CONSTANTS, ABSOLUTE ZERO=<0 or -273.15>, STEFAN BOLTZMANN=<σ in the unit system>` whenever any radiation BC exists; `*RADIATE` `Rx` with sink and ε. σ = 5.670 374 419 × 10⁻⁸ W/(m² K⁴) derived from exact SI constants (VC-THM-13). |
| TR-THM-15 | SHOULD (V1) | Contact conductance: tied `*CONTACT PAIR` (face-to-face) with `*SURFACE INTERACTION`, `*SURFACE BEHAVIOR, PRESSURE-OVERCLOSURE=TIED` and `*GAP CONDUCTANCE` table; CalculiX generates contact springs for tied face-to-face pairs regardless of clearance [R7]. Exact card combination validated against `test/contact7–9.inp` (§9). |
| TR-THM-16 | COULD (V2) | Phase change: apparent heat capacity c_app(T) = cp + L / (T_l − T_s) on [T_s, T_l] written into the `*SPECIFIC HEAT` table, with an energy check ∫c_app dT = cp ΔT + L to 1e-9; there is no latent-heat card in CalculiX [R7]. |
| TR-THM-20 | SHOULD (V1) | `compute_view_factors` (§5.4): pure TS contour-integral view factors between tessellated planar facets, aggregated per target face, without obstruction in V1-a and with ray-cast obstruction in V1-b; returns matrix, row sums, method, facet counts. Above the TS facet cap the same query runs in `llull-compute geomq` (§2.2); the TS code stays the reference and small-case path. |
| TR-THM-21 | SHOULD (V1) | Cavity radiation deck: `*RADIATE, CAVITY=<≤ 3 chars>` with `RxCR`; open cavity → environment temperature; closed cavity → negative absolute environment temperature, which makes CalculiX scale view factors to 1 [R7]. Cavity names are validated (≤ 3 characters, unique). |
| TR-THM-30 | MUST | Result reading: the 05 FRD reader returns `NDTEMP` (NT), `FLUX` (HFL) and `RFL` blocks per step/time; the thermal summariser (§5.5) produces `ThermalResultsSummary`; the DAT reader reads `*NODE PRINT` / `*EL PRINT` probe tables (format checked on `oneel8ra.dat.ref`). |
| TR-THM-31 | MUST | Heat balance (§5.5) computed from RFL on prescribed-temperature nodes, film and radiation face fluxes (recomputed from NT and the BC data), applied fluxes and generation, and stored energy (transient, ∫ρ cp ΔT dV); relative residual reported; tolerance named (default 1e-2, `source: "llull acceptance rule"`, `defaulted: true`). |
| TR-THM-32 | MUST | Temperature-field hand-off: `ThermalResultsSummary.fieldRefs[]` lists `{ resultsHash, step, time }` entries a PHY-04 case can reference; `inputHash` of a dependent mechanical case includes the referenced `resultsHash` (TR-TMC-10). |
| TR-THM-40 | SHOULD | `thermal_analytic_check` implements the closed forms of `validation/generate_thermal_reference.py` exactly (same formulas, same results to 1e-12 relative). |
| TR-THM-50 | MUST | Agent-first result contract: physical constants and the balance tolerance named with source and `defaulted`; no default for h, ε, sink, initial temperature, limits; `unverified` = OR of the 08 / PHY-01 / PHY-15 inputs' flags; `reviewRequired` on every limit row. |
| TR-THM-51 | MUST | Stable codes of §7.1 on every refusal and check item, with ids or param paths and a remediation. |
| TR-THM-52 | MUST | `dispose_thermal_limit` verifies a human-held signature through the 09 PLM signing port; an agent caller cannot supply one (AF-34, AF-34a). |

### 2.2 Stack amendment (RS1, 2026-10-18)

Decision [RS1](../../decisions/RS1-native-compute.md) step **RS-6** moves large view-factor computations with obstruction to
native code. The rest of the pack does not change: the FE path stays Gmsh + bundled CalculiX (05), and CalculiX still
computes its own cavity view factors in the solve.

| Item | Before | Now |
| ---- | ---- | --- |
| Where | `computeViewFactors.ts` (pure TS), one V8 thread | TS below the cap; above it `llull-compute geomq` (crate `llull-geomq` on the shared `llull-bvh`): contour-integral kernel and obstruction ray casting on wgpu, Rust-CPU twin |
| How core reaches it | — | the same injected batch port as PHY-21 (`GeometryQueryEngine`, PHY-21 TR-FPR-19), method `viewFactorBatch`; the query stays a pure registry command, nothing in `packages/*` imports native code |
| Facet cap | 400 facets (`THM_FACET_LIMIT`, built) | unchanged on the TS path; native target ~10⁴ facets (target, TBD — measure, VC-THM-64) |
| Obstruction | centroid-segment test per facet pair | native: same test (used for VC-THM-64) plus an optional multi-ray test per pair (named ray count) |
| Recorded numbers | TS | Rust-CPU twin or fixed-order GPU reductions (RS1 §2 rule 3); provenance names engine, device, `deterministic` |
| Reference | `computeViewFactors.ts` + closed forms (VC-THM-09) | unchanged; the native path must match TS (VC-THM-64) |

## 3. Data model

### 3.1 Analysis slice additions (core `model/analysis.ts`)

```ts
export type AnalysisType = 'static' | 'modal' | 'buckling'           // 05
  | 'heat_steady' | 'heat_transient'                                  // PHY-03 (this pack)
  | 'thermo_static' | 'coupled_temperature_displacement';            // PHY-04

export type TemperatureScale = 'degC' | 'K';
export interface Q { readonly value: number; readonly unit: string }  // unit grammar: 08 lib/quantity.ts

export interface Amplitude {                                           // id 'am-<step>.<k>'
  readonly id: string; name: string;
  /** strictly increasing time (s); value is a multiplier of the referencing BC value */
  points: ReadonlyArray<readonly [timeS: number, factor: number]>;
  /** provenance of sampled shapes, for the report: { kind: 'sine', amplitude, periodS, sampleStepS } */
  generatedFrom?: { kind: 'sine' | 'ramp' | 'table'; params: Readonly<Record<string, number>> };
}

export type ThermalBc =                                                // id 'tb-<step>.<k>'
  | { kind: 'temperature'; value: Q; target: FeaTarget }
  | { kind: 'surface_flux'; value: Q /* W/m², + into the part */; target: FeaTarget }
  | { kind: 'heat_generation'; value: Q /* W/m³ or total W */; mode: 'density' | 'total'; entityId: EntityId }
  | { kind: 'concentrated_flux'; value: Q /* W */; target: FeaTarget /* pointsNear */ }
  | { kind: 'film'; filmCoefficient: Q | { table: TableRef }; sinkTemperature: Q; target: FeaTarget }
  | { kind: 'radiation'; emissivity: number | { fromProperty: 'emissivityIr' }; sinkTemperature: Q; target: FeaTarget };
export interface ThermalBcRecord { readonly id: string; name: string; bc: ThermalBc; amplitude?: string /* Amplitude.id */;
  source?: { citation: string; locator?: string } /* mandatory for film h and emissivity values given as numbers (FR-THM-20) */ }

export interface CavityRadiation {                                     // V1, id 'cv-<step>.<k>'
  readonly id: string; name: string /* ≤ 3 chars, CalculiX CAVITY */;
  environment: { kind: 'open'; temperature: Q } | { kind: 'closed' };
  faces: ReadonlyArray<{ target: FeaTarget; emissivity: number | { fromProperty: 'emissivityIr' } }>;
}
export interface ThermalContact {                                      // V1
  readonly id: string; name: string; master: FeaTarget; slave: FeaTarget;
  conductance: Q | { points: ReadonlyArray<readonly [conductanceW_m2K: number, pressureMPa: number, temperature: number]> };
}
export interface ThermalStep {
  endTimeS?: number;                      // transient only
  initialIncrementS?: number; maxIncrementS?: number; minIncrementS?: number;
  fixedIncrements?: boolean;              // → *HEAT TRANSFER, DIRECT
  maxTemperatureChangePerIncrement?: Q;   // → DELTMX
  outputTimesS?: readonly number[]; outputEveryS?: number;
}
export interface TemperatureLimit {                                    // id 'tl-<step>.<k>'
  readonly id: string; name: string;
  scope: { entityId: EntityId } | { target: FeaTarget };
  min?: Q; max?: Q;                       // at least one
  source: { citation: string; locator?: string };   // mandatory (AF-31)
}
export interface ThermalSetup {                                        // AnalysisCase.thermal, present iff type is heat_*
  temperatureScale: TemperatureScale;
  initialTemperature?: Q;                 // mandatory for heat_transient (checked, never defaulted)
  bcs: Record<string, ThermalBcRecord>; bcOrder: string[];
  amplitudes: Record<string, Amplitude>;
  cavities: Record<string, CavityRadiation>; contacts: Record<string, ThermalContact>;
  step: ThermalStep;
  limits: Record<string, TemperatureLimit>; limitOrder: string[];
  dispositions: Record<string /* rowId */, { decision: 'accepted' | 'rejected' | 'redesign'; justification: string;
    resultsHash: string; signer: string; signatureId: string }>;
}
export interface AnalysisCase { /* 05 fields */ thermal?: ThermalSetup }

export interface ThermalResultsSummary {                               // in ResultsSummary.thermal (05 artifact-validated)
  readonly temperatureScale: TemperatureScale;
  readonly times: readonly number[];                                   // [0] for steady
  readonly maxT: { value: number; at: Vec3; entityId: EntityId; timeS: number };
  readonly minT: { value: number; at: Vec3; entityId: EntityId; timeS: number };
  readonly maxHeatFluxW_m2: { value: number; at: Vec3; timeS: number };
  readonly bcHeatFlowsW: ReadonlyArray<{ bcId: string; timeS: number; valueW: number }>;   // + = into the part
  readonly heatBalance: { inW: number; outW: number; storedW: number; residualRel: number; timeS: number };
  readonly probes: ReadonlyArray<{ probeId: string; series: ReadonlyArray<readonly [timeS: number, T: number]> }>;
  readonly propertyRangeExceeded: ReadonlyArray<{ material: string; property: 'k' | 'cp' | 'density'; validRange: [number, number]; reached: number }>;
  readonly fieldRefs: ReadonlyArray<{ resultsHash: string; step: number; timeS: number }>;
  readonly physicalConstants?: { stefanBoltzmann: Named; absoluteZero: Named };
}
export interface Named { readonly value: number; readonly unit: string; readonly source: string; readonly defaulted: boolean }
```

Ids follow the step-scoped convention (L8). `CadDocument.analysis` stays optional (05 TR-FEA-02); the new fields are
optional, so no document version bump is needed; they ride the aerospace v3 envelope (README §6.2).

### 3.2 Extension port (core, Proposal A)

```ts
// packages/core/src/plugins/plugin.ts (addition)
export interface AnalysisTypeExtension {
  readonly types: readonly AnalysisType[];
  /** pure: issues for check_analysis / check_thermal (codes §7.1) */
  validateCase(doc: CadDocument, c: AnalysisCase): readonly CheckItem[];
  /** canonical JSON fields added to the 05 input hash (TR-FEA-06) */
  inputHashFields(doc: CadDocument, c: AnalysisCase): unknown;
  /** deck sections after the model block written by @cae (nodes, elements, sets); returns INP text */
  writeDeckSections(ctx: DeckContext): string;
  /** reduce parsed result blocks to the summary stored by record_fea_results */
  summariseResults(blocks: ParsedResultBlocks, mesh: FeMeshView, c: AnalysisCase): unknown;
}
export interface DeckContext { readonly analysis: AnalysisCase; readonly setNames: SetNameMap; readonly materials: readonly ThermalMaterialView[];
  readonly unitSystem: UnitSystem; readonly mesh: FeMeshView }
```

`CheckItem`, `SetNameMap`, `ParsedResultBlocks`, `FeMeshView` are the read-only shapes 05 already defines, moved to core.

### 3.3 Thermal material view (read only)

```ts
export interface ThermalMaterialView {
  readonly materialName: string; readonly recordId: string;
  /** each property as constant or table in the analysis unit system; the source keeps 08 basis + provenance */
  readonly k: PropertyEval; readonly cp?: PropertyEval; readonly density: PropertyEval;
  readonly kOrtho?: readonly [PropertyEval, PropertyEval, PropertyEval];   // V1
  readonly unverified: boolean; readonly unverifiedReasons: readonly string[];
}
export type PropertyEval =
  | { kind: 'constant'; value: number; provenance: string }
  | { kind: 'table'; points: ReadonlyArray<readonly [T: number, v: number]>; validRange: [number, number]; provenance: string };
```

Every k / cp / ρ model is turned into a CalculiX table at deck time by PHY-01 `tabulatePropertyModel(model, 'T', range,
relTol)` over the case's expected temperature range (initial / BC temperatures ± a margin, inside the model's equation range;
`relTol` named default 1e-3, `source: "llull deck rule"`), and the deck header carries the model ids, `coefficientsSha256` and
`maxRelError` (PHY-01 §3.3 consumer rule); the table points enter `inputHash`. A range outside the equation range is refused
with PHY-01's `PROP_OUT_OF_RANGE` before solving. Extrapolation never happens in llull; CalculiX holds the end values constant outside a
table, so `propertyRangeExceeded` is computed from the solved field and reported (FR-THM-10).

## 4. Commands

Plugin `thermal`, toolset `analysis`. All mutating commands are pure, record a `FeatureStep`, and return the input
document unchanged with a code on failure. Units are in each schema description (AF-04).

| Name | Kind | Params sketch | Tags |
| ---- | ---- | ------------- | ---- |
| (05) `create_analysis` | mutating | `{ name, analysisType: … \| 'heat_steady' \| 'heat_transient', solver?, unitSystem?, temperatureScale?: 'degC' \| 'K' }` | thermal types create `thermal: ThermalSetup` with empty maps; `temperatureScale` default `degC` named in `data` · @failure scale given for a mechanical type |
| `add_thermal_bc` / `update_thermal_bc` / `delete_thermal_bc` | mutating | `{ analysisId, name, kind, value?: Q, unit?, filmCoefficient?: Q, sinkTemperature?: Q, emissivity?: number \| 'material', mode?, entityId?, target?, amplitude?, source? }` | @affects case.thermal.bcs · @invariant 0 ≤ ε ≤ 1; h > 0; quantity dimension matches kind; film h and numeric ε carry `source` · @failure `THM_EMISSIVITY_INVALID`, `THM_UNITS_MISMATCH`, `THM_SOURCE_REQUIRED`, `FEA_TARGET_UNRESOLVED` / `_AMBIGUOUS`, non-thermal case `THM_CASE_TYPE` |
| `set_initial_temperature` | mutating | `{ analysisId, value, unit }` | @affects case.thermal.initialTemperature · @failure non-thermal case; unit not a temperature |
| `define_amplitude` / `delete_amplitude` | mutating | `{ analysisId, name, kind: 'table' \| 'sine' \| 'ramp', points?, amplitude?, periodS?, sampleStepS?, durationS? }` | @affects case.thermal.amplitudes · @invariant times strictly increasing; sine/ramp sampled deterministically at `sampleStepS` from 0 to `durationS` inclusive · @failure `THM_AMPLITUDE_INVALID` |
| `set_thermal_step` | mutating | `{ analysisId, endTimeS?, initialIncrementS?, maxIncrementS?, minIncrementS?, fixedIncrements?, maxTemperatureChangePerIncrement?: Q, outputTimesS?, outputEveryS? }` | @invariant all times > 0; endTimeS required for transient · @failure `THM_STEP_INVALID` |
| `add_cavity_radiation` (V1) | mutating | `{ analysisId, name (≤ 3 chars), environmentTemperature?: Q \| 'closed', faces: [{ target, emissivity }] }` | @failure name too long / duplicate, ε invalid, `THM_SCALE_ABSOLUTE` if environment given on a scale without absolute zero handling |
| `add_thermal_contact` (V1) | mutating | `{ analysisId, name, master: FeaTarget, slave: FeaTarget, conductance: Q \| points }` | @failure targets on the same part; conductance ≤ 0 |
| `add_temperature_limit` / `delete_temperature_limit` | mutating | `{ analysisId, name, entityId? \| target?, min?: Q, max?: Q, source: { citation, locator? } }` | @invariant at least one of min/max; source mandatory · @failure `THM_LIMIT_SOURCE_REQUIRED` |
| `thermal_report` | query | `{ analysisId, timeS?, probes? }` → `data { state, temperatureScale, maxT, minT, maxHeatFlux, bcHeatFlows[], heatBalance, probes[], physicalConstants, propertyRangeExceeded[], unverified, unverifiedReasons[] }` | read-only (AF-10); `state` from 05 (`unmeshed`/`meshed`/`solved`/`stale`/`missing`) |
| `check_thermal` | query | `{ analysisId }` → `data { status, items[{ code, severity, ids[], path?, message, remediation }], reviewRequired: true }` | AF-20 readiness + post-solve check (§7.1). 05 `check_analysis` delegates to it for heat types |
| `check_temperature_limits` | query | `{ analysisId, marginalBandK?: number }` → `data { rows[{ rowId, limitId, scope, bound: 'max'\|'min', limit, computed, marginK, at, timeS, status, code?, provenance, unverified, reviewRequired: true, reviewReason, disposition }], reviewRequired: true, summary }` | @failure `FEA_RESULTS_STALE`, `FEA_RESULTS_MISSING`, `THM_NO_LIMITS`; no default band (`THM_MARGINAL_BAND_UNSET` warning) |
| `compute_view_factors` (V1) | query, `requiresKernel` | `{ analysisId?, cavity?, faces?: FeaTarget[], obstruction?: boolean, maxFacetSize?: Q }` → `data { faces[], matrix[][], rowSums[], method, facetCounts[], reciprocityMaxError }` | pure geometry over `ctx.kernel.tessellate`; no solver |
| `thermal_analytic_check` | query | `{ check: 'plane_wall' \| 'slab_generation' \| 'semi_infinite' \| 'lumped' \| 'fin' \| 'parallel_plates' \| 'view_factor' \| 'stefan' \| 'interface', inputs }` → `{ value, unit, formula, inputs, validity? }` | pure; equals the generator (TR-THM-40); `lumped` returns `validity: { Bi, ok: Bi < 0.1 }` |
| `dispose_thermal_limit` | mutating, **human gate** | `{ analysisId, rowId, decision, justification, signature }` | @invariant signature verified by the 09 signing port; records rowId, resultsHash, signer · @failure `THM_HUMAN_GATE` (agent caller / no valid signature), `FEA_RESULTS_STALE` |
| (05) `add_result_probe` | mutating | `quantity` gains `'temperature' \| 'heat_flux'` | — |
| (05 ✱) `fea_mesh`, `fea_solve`, `fea_import_results`, `fea_export` | transport | unchanged params | dispatch on `analysisType` through the extension (§2.1) |

Description sketch for `add_thermal_bc` (AF-02): *"Add a thermal boundary condition or load to a heat_steady /
heat_transient analysis. kind: temperature (value °C or K per the case scale), surface_flux (W/m², positive into the part),
heat_generation (W/m³, or total W with mode=total), concentrated_flux (W at a point), film (filmCoefficient W/(m²·K),
sinkTemperature), radiation (emissivity 0–1, sinkTemperature; evaluated on absolute temperature). Film coefficients and
numeric emissivities need `source`. Target faces with facesNear points. Refuses ε outside [0, 1], wrong unit dimension, or a
mechanical case. Next: set_thermal_step (transient), fea_mesh, check_thermal."*

## 5. Kernel / algorithms

### 5.1 Deck sections (pure, after 05's model block)

```
** llull thermal  type=heat_transient  scale=degC  inputHash=<h>  meshHash=<m>
*MATERIAL, NAME=<m>
*CONDUCTIVITY                 k[,T] lines (TYPE=ORTHO in V1)
*SPECIFIC HEAT                cp[,T] lines (transient)
*DENSITY                      rho[,T]
*PHYSICAL CONSTANTS, ABSOLUTE ZERO=-273.15, STEFAN BOLTZMANN=<sigma>      (only when radiation exists; ABSOLUTE ZERO=0 on the K scale)
*INITIAL CONDITIONS, TYPE=TEMPERATURE
NALL, <T0>
*AMPLITUDE, NAME=<am>          t1, f1, t2, f2, … (4 pairs per line)
*STEP, INC=<n>
*HEAT TRANSFER[, STEADY STATE][, DIRECT][, DELTMX=<d>]
<initial increment>, <end time>[, <min increment>, <max increment>]
*BOUNDARY[, AMPLITUDE=<am>]    C_<bc>, 11, 11, <T>
*DFLUX[, AMPLITUDE=<am>]       S_<bc>-element/face lines: <elset or element>, S<f>, <q>      |   <elset>, BF, <q'''>
*CFLUX[, AMPLITUDE=<am>]       <node>, 11, <Q>
*FILM[, AMPLITUDE=<am>]        <element>, F<f>, <sink>, <h>
*RADIATE[, AMPLITUDE=<am>]     <element>, R<f>, <sink>, <eps>      |  V1: *RADIATE, CAVITY=<c>  <element>, R<f>CR, <env>, <eps>
*NODE FILE                     NT, RFL
*EL FILE                       HFL
*NODE PRINT, NSET=P_<probe>    NT
*END STEP
```

Keyword names, labels and parameters are those verified in the manual [R7] (sources.md S7). Sign conventions: surface
flux positive into the part (CalculiX "flux entering … positive"); film and radiation use the sink on the BC.

### 5.2 Face and node sets

Targets resolve exactly as in 05 (`facesNear` → face map → Gmsh physical groups). For `*FILM`, `*RADIATE` and `*DFLUX Sx` the
writer emits one line per (element, face label) on the target faces using TR-THM-11; for `*BOUNDARY` DOF 11 the node set of
the target faces. Point flux uses `pointsNear` → nearest node (05 TR-FEA-03).

### 5.3 Units (TR-THM-04, FR-THM-19)

Conversion factors from SI to the 05 unit systems, from the CalculiX units table [R7] and dimensional analysis:

| Quantity | SI unit | N-m-kg-s | N-mm-t-s | lbf-in-slinch-s |
| -------- | ------- | -------- | -------- | --------------- |
| conductivity k | W/(m K) | 1 | 1 N/(s K) | via 08 `lib/quantity.ts`, unit-tested |
| specific heat cp | J/(kg K) | 1 | 1e6 mm²/(s² K) | same |
| density ρ | kg/m³ | 1 | 1e-12 t/mm³ | same |
| film h | W/(m² K) | 1 | 1e-3 N/(mm s K) | same |
| surface flux q | W/m² | 1 | 1e-3 N/(mm s) | same |
| generation q''' | W/m³ | 1 | 1e-6 N/(mm² s) | same |
| power Q | W | 1 | 1e3 N mm/s | same |
| σ | W/(m² K⁴) | 5.670 374 419e-8 | 5.670 374 419e-11 | same |

Temperature: the deck uses the case scale; on `degC` the deck writes `ABSOLUTE ZERO=-273.15`, on `K` it writes `0`. Input
quantities in another temperature unit are converted affinely for temperatures and multiplicatively for differences
(per-K quantities such as h, k, cp are identical in K and °C).

### 5.4 View factors (TR-THM-20)

For planar facets i, j (triangles from `ctx.kernel.tessellate`), F_ij = (1 / (2π A_i)) ∮_{C_i} ∮_{C_j} ln(r) dr_i · dr_j
(Stokes reduction of the double area integral). Edge pairs are integrated with Gauss–Legendre (8 points) and the
coincident or touching-edge cases use the closed-form limit (as in pyViewFactor's semi-analytic kernel [R12]); facets
facing away (n_i · (c_j − c_i) ≤ 0 or n_j · (c_i − c_j) ≤ 0) get 0. Face-level factors: F_IJ = Σ_i Σ_j A_i F_ij / A_I.
Checks returned in `data`: reciprocity max |A_I F_IJ − A_J F_JI| / max(A_I F_IJ), and row sums (closed cavity ⇒ 1 ± 1e-3).
Obstruction (V1-b): a facet pair is skipped when the segment between centroids hits a third facet (BVH, deterministic
order). Validation: VC-THM-09 (closed forms proven by quadrature in the generator). Large cases run the same kernel and
test in `llull-compute geomq` on GPU ray casting (§2.2, VC-THM-64).

### 5.5 Result summary and heat balance (TR-THM-30, TR-THM-31)

```
for each output time t:
  maxT/minT = extreme of NT over nodes (with node coordinates → at, part from element block)
  bcHeatFlow(temperature BC) = Σ RFL over the BC's node set          (+ into the part)
  bcHeatFlow(film)        = Σ over faces ∫ h (T_sink − T) dA         (face quadrature on NT)
  bcHeatFlow(radiation)   = Σ over faces ∫ ε σ (θ_sink⁴ − θ⁴) dA      (absolute temperature)
  bcHeatFlow(flux/gen)    = applied value × area / volume (× amplitude(t))
  stored(t)               = d/dt ∫ ρ cp T dV  ≈ (E(t) − E(t_prev)) / (t − t_prev)   (transient)
  residualRel = |Σ bcHeatFlow − stored| / max(Σ positive flows, Σ |negative flows|, 1e-30)
```

Probes interpolate NT with the element shape functions at the probe point (05 probe machinery). Time histories are
the probe values at every output time.

### 5.6 Phase change (V2, TR-THM-16)

`latentHeat` (J/kg) and a melting range [T_s, T_l] (T_l − T_s ≥ 0.5 K enforced; a smaller range is refused because the
apparent capacity becomes too stiff) add L/(T_l − T_s) to cp on [T_s, T_l], with table points at T_s − ε, T_s, T_l,
T_l + ε (ε = 1e-3 K). Validation: Neumann one-phase solution, VC-THM-12.

### 5.7 Numerical tolerances

| Item | Value |
| ---- | ----- |
| Unit conversion round-trip | 1e-12 relative |
| Analytic check vs generator | 1e-12 relative |
| Heat balance warning | 1e-2 relative (named default) |
| View-factor reciprocity warning | 1e-3 relative |
| Benchmarks | per case in `expected_results.json` (0.5 %–3 %, each justified in validation/README.md) |

## 6. Interop & persistence

| Format | Direction | Implementation |
| ------ | --------- | -------------- |
| CalculiX INP (thermal) | out | `@phys` deck sections + `@cae` model block (Proposal A) |
| CalculiX FRD (NDTEMP, FLUX, RFL) / DAT | in | 05 readers (generic block parse) + `@phys` summariser |
| CalculiX `.vwf` view factors | — | not read (binary layout not documented in the manual); llull computes its own (§5.4) |
| VTU (temperature) | out (V1) | 05 meshio path |
| Document | persist | `analysis.cases[*].thermal` in `.llull` JSON; arrays in the 05 artifact store |

Plugin `validate`: ids unique; emissivities in [0, 1]; amplitudes strictly increasing; cavity names ≤ 3 chars; every
number finite; every limit has a source; quantities parse with the right dimension.

## 7. CLI / MCP / UI surfaces

- **CLI** (primary): registry commands as `llull <command> …`; 05 transports unchanged. `llull guide` gains a thermal
  section: temperature scales and absolute zero, sign conventions, the minimal steady and transient plans
  (`validation/plans/thm_wall_convection.plan.json`, `thm_nafems_t3.plan.json`), and "end every job with `check_thermal`" (AF-03).
- **MCP**: toolset `analysis`; prompt `thermal_quick_check` (set-up, mesh, solve, report, limits).
- **render_view**: 05's proposed `analysisId` / `field` params accept `field=temperature` and `time` (AF-22).
- **UI** (review): thermal glyphs, temperature map, time slider, heat-balance panel, limits table, disposition dialog.

### 7.1 Stable error and check codes (AF-11)

| Code | Severity | When | Ids / path | Remediation |
| ---- | -------- | ---- | ---------- | ----------- |
| `THM_CASE_TYPE` | error | a thermal command on a non-thermal case (or the reverse) | analysis id | create a `heat_steady` / `heat_transient` case |
| `THM_UNITS_MISMATCH` | error | a quantity has the wrong dimension, or a temperature unit is unknown | param path | give `{ value, unit }` with the documented unit |
| `THM_EMISSIVITY_INVALID` | error | ε ∉ [0, 1] | BC / face | correct ε (PHY-15 property or a sourced value) |
| `THM_FILM_INVALID` | error | h ≤ 0 | BC | give a positive, sourced h |
| `THM_SOURCE_REQUIRED` | error | numeric film h or ε without `source` | BC | add `source: { citation }` |
| `THM_AMPLITUDE_INVALID` | error | times not strictly increasing, empty, non-finite | amplitude | fix the table |
| `THM_STEP_INVALID` | error | transient without `endTimeS`, or increments ≤ 0 | path | `set_thermal_step` |
| `THM_INITIAL_TEMPERATURE_MISSING` | error | transient case without initial temperature | analysis id | `set_initial_temperature` |
| `THM_MATERIAL_NO_K` | error | analysed part's record has no `k` | material, record | `set_material_property property=k …` |
| `THM_MATERIAL_NO_CP` | error | transient and no `cp` (or no density) | material | `set_material_property property=cp …` |
| `THM_MATERIAL_UNVERIFIED` | warning (not suppressible) | a used k / cp / ρ / ε is `unverified` | material, property | replace with a verified sourced value |
| `THM_PROPERTY_OUT_OF_RANGE` | warning | solved T leaves the tabulated range (CalculiX then holds end values) — pre-solve range errors use PHY-01 `PROP_OUT_OF_RANGE` | material, property, range, reached | widen the tabulation range inside the model's equation range, or define a model sourced for it (PHY-01 `define_property_model`) |
| `THM_NO_HEAT_PATH` | error | steady case without any temperature, film or radiation BC | analysis id | add a sink (temperature, film or radiation) |
| `THM_RADIATION_SCALE` | error | radiation on a case whose absolute zero cannot be written (corrupt scale) | analysis id | set `temperatureScale` |
| `THM_CAVITY_INVALID` | error | cavity name > 3 chars, duplicate, or < 2 faces | cavity | rename / add faces |
| `THM_VIEW_FACTOR_RECIPROCITY` | warning | reciprocity error > 1e-3 | face pairs | refine `maxFacetSize` |
| `THM_HEAT_BALANCE` | warning | residual > tolerance | analysis id, numbers | refine mesh / time step; check BCs |
| `THM_NO_LIMITS` | warning | `check_temperature_limits` with no limit | analysis id | `add_temperature_limit` with a source |
| `THM_LIMIT_SOURCE_REQUIRED` | error | limit without source | path | add the datasheet / rule citation |
| `THM_LIMIT_EXCEEDED` | fail | margin < 0 | row id | redesign; only a qualified reviewer can disposition |
| `THM_LIMIT_MARGINAL` | warning | 0 ≤ margin < band | row id | same |
| `THM_MARGINAL_BAND_UNSET` | warning | no band given | analysis id | ask the owner / company rule |
| `THM_DISPOSITION_PENDING` | warning | FAIL/MARGINAL row without disposition | row ids | qualified reviewer: `dispose_thermal_limit` in the desktop app |
| `THM_HUMAN_GATE` | error | `dispose_thermal_limit` by an agent / without valid signature | row id | hand over to the qualified reviewer |
| 05 codes | — | `FEA_TARGET_*`, `FEA_MESH_*`, `FEA_RESULTS_STALE`, `FEA_RESULTS_MISSING`, `FEA_SOLVER_FAILED`, `FEA_TOOL_MISSING` apply unchanged | | |

### 7.2 Agent-first compliance

| AF | Where |
| -- | ----- |
| AF-01/02/03/04/05 | registry commands (§4); descriptions with units; `llull guide` thermal section; `{ value, unit }`; plans in `validation/plans/` |
| AF-10/12/13 | `thermal_report`, `check_temperature_limits` shapes (§3.1, §4); arrays only via artifacts; deterministic writer and summariser |
| AF-11 | §7.1 (FR-THM-21, VC-THM-61) |
| AF-20/21/22/23 | `check_thermal`; numbers first; `render_view field=temperature`; CLI harness in validation/README.md |
| AF-30/31 | heat-balance rule, physical constants named (VC-THM-60); no default h / ε / sink / T0 / limit |
| AF-32/33/34/35/36 | unverified propagation; `reviewRequired` on limit rows; `dispose_thermal_limit` human gate; formula + inputs in analytic checks and provenance per row; owner summary order (FUNCTIONAL §6.1) |
| AF-40/41/42 | 05 transports (progress, timeout, cache, bundled ccx); `--dry-run` on all set-up commands |

## 8. Performance & robustness budgets

| Budget | Target |
| ------ | ------ |
| Steady solve, 50k-node tet10 box with film | ≤ 20 s (TBD: measure, production gate) |
| Transient, 10k nodes, 200 increments | ≤ 60 s (TBD: measure) |
| `compute_view_factors`, 2 000 facets, no obstruction | ≤ 2 s in TS (O(n²) edge pairs); obstruction ≤ 10 s (the built TS path caps at 400 facets, §13) |
| `compute_view_factors` native (`llull-compute geomq`) | ~10⁴ facets with obstruction, wall time recorded — target, TBD measure (VC-THM-64) |
| FRD with 200 time points | streamed; summary only stored; full field stays in the artifact |
| Determinism | same plan ⇒ same deck sha256 and same summary JSON (sorted sets, fixed float formatting `%.12g`) |

## 9. Test strategy (VC mapping)

| Layer | Tests | VC |
| ----- | ----- | -- |
| Unit (`tests/unit/physics/thermal/*`) | every command happy / failure / `is pure`; units table; amplitude sampling; face labels; deck sections golden text on a 2-element mesh; summariser on a hand-written FRD; heat balance; analytic checks vs `expected_results.json` | 01, 02, 06–13, 60, 61 |
| Contract | `toToolSchemas()` snapshot gains the thermal commands; plugin `validate`; extension lookup | — |
| Golden | the five plans in `validation/plans/` (id-normalised snapshot + replay equality) | 03, 04, 01 |
| Native (`npm run native:check`; `server/tests` with `llull-compute`) | `llull-geomq` view-factor kernel vs TS on VC-THM-09 geometries and seeded cavities; GPU vs Rust-CPU twin where an adapter exists | 09, 64 |
| Integration (`server/tests`, needs ccx) | T2/T3/T4 solves, wall, `oneel8ra` re-run and parse, tied contact conductance card check against `test/contact7–9.inp`, cavity (V1) | 01, 03, 04, 05, 14, 30 |
| Quality gate | `quality:thermal` runs the CLI harness through PHY-00 | all numeric |
| Agent-first | stale, human gate, unverified propagation, codes | 50, 60–64 |

Coverage 90/85/90/90 extends to `packages/domain-physics/src/**`.

## 10. Delivery plan

| M | Content | Depends on | Effort |
| - | ------- | ---------- | ------ |
| M0 | Decision §2.1 (extension port in core) and the move of 05 artifact read types to core | 05 M1, coordinator | 3 d |
| M1 | Data model, commands (BCs, initial T, amplitudes, step, limits), `thermal_analytic_check`, units, unit tests | M0, 08 M1–M2, PHY-01 types | 2 w |
| M2 | Deck sections (steady + transient), summariser, heat balance, `thermal_report`, `check_thermal`, `check_temperature_limits`, `dispose_thermal_limit` | M1, 05 M3, 09 signing port | 2 w |
| M3 | Validation: T2/T3/T4, wall, `oneel8ra`, golden plans, `quality:thermal`, `llull guide` section | M2, PHY-00 runner | 1 w |
| M4 (V1) | View factors (TS) + cavity deck, contact conductance, h(T) / ε(T) tables, orthotropic k, render_view field | M3, PHY-15 emissivity property | 3 w |
| RS-6 | Native view factors: `viewFactorBatch` on the PHY-21 port, `llull-compute geomq` kernel + obstruction rays, VC-THM-64 | M4, PHY-21 RS-6 row, RS-0 (`solver/` workspace) | 1 w (share of RS1 RS-6) |
| V2 | phase change, forced convection network, Nastran thermal, orbital loads hand-off, Joule heating | M4 | — |

Cross-gap: **05 FEA** (pipeline), **08 MAT** / **PHY-01** (k, cp, ρ data), **PHY-15** (emissivity, absorptivity),
**PHY-04** consumes `fieldRefs`, **PHY-00** runs the corpus, **09 PLM** signs dispositions.

## 11. Open questions / decisions needed

1. **Placement** (§2.1): extension port in core (A) or thermal inside `domain-cae` (B)? The README §6.2 wording
   ("`@phys` extends `@cae`") is not buildable under the current dependency rule.
2. **Output at requested times**: `*NODE FILE` with `TIME POINTS` (needs a `*TIME POINTS` card) or frequency-based output —
   to be fixed by the M2 deck test against CalculiX; the manual sections were not read for this detail.
3. **Film coefficient helpers**: should llull ship cited natural-convection correlations as a query (never a default),
   and from which open source? Not researched in this pack.
4. **CalculiX view factor accuracy** versus llull's TS factors (VC-THM-30): answered for opposed squares — both agree with the closed form (ccx +9e-6 converged); VC-THM-30 pinned at abs 5e-4. Other geometries stay open.
   *Measured 2026-10-17 (§13): for the VC-THM-09.a plates they agree to 9e-6 on a converged mesh; the closed form is the reference and the
   proposal for the pack owner is value 0.199825, tolerance 5e-4 abs, grade A (the pack's 0.002 would also pass). Open for other geometries.*
5. **Contact conductance card set** (TR-THM-15) must be confirmed on the `contact7–9` decks before M4.
   *Answered 2026-10-17 without the decks (not available locally): the card set of §13 reproduces VC-THM-11 to 6.6e-5 on ccx 2.21.*
6. **Temperature-limit sources**: llull ships no limit tables (component and qualification limits are proprietary or
   paywalled); confirm this policy matches 03 GDT's "customer fills the rule tables" approach.

7. **Native view-factor obstruction method** (RS1): keep the centroid-segment test only, or add the multi-ray test per facet pair
   on the GPU as the default above the TS cap? Proposal: centroid test by default (matches TS), multi-ray as an option until
   VC-THM-64 measures the difference on obstructed cavities.

## 12. References

- [R1]–[R13]: see [`FUNCTIONAL_SPEC.md`](FUNCTIONAL_SPEC.md) §11 and [`validation/sources.md`](validation/sources.md) (S1–S13).
- [R7] CalculiX — https://github.com/Dhondtguido/CalculiX/tree/fd588701edd6a92fde06e99b1bdf01f3b0f80f2c (accessed 2026-10)
- [R12] pyViewFactor — https://pypi.org/project/pyviewfactor/ (accessed 2026-10)
- [RS1] Native compute programme — [`../../decisions/RS1-native-compute.md`](../../decisions/RS1-native-compute.md) (step RS-6)
- llull: `.claude/rules/architecture.md` (L1–L10), `.dependency-cruiser.cjs` (rule `plugins-and-kernels-depend-on-core-only`),
  `packages/core/src/model/types.ts`, `packages/mcp/src/toolsets.ts`, `docs/aerospace/05-fea-cae-handoff/TECHNICAL_SPEC.md`,
  `docs/aerospace/08-materials-standards-libraries/TECHNICAL_SPEC.md`, `docs/physics/README.md`.

## 13. Implementation status (2026-10-16)

**Built: the parts that need no FE pipeline** — `thermal_analytic_check` (TR-THM-40), thermal unit conversions (TR-THM-04) and
`compute_view_factors` V1-a + V1-b (TR-THM-20). VC-THM-01.a–d, 02, 06, 07.a/b, 08, 09.a–d, 10, 11.a/b, 12.a/b, 13 and 60 are judged
by `tests/unit/physics/thermal/` through the PHY-00 judge (all pass); all 16 rows of `view_factors.csv` pass. VC-THM-61 is asserted for
the two set-ups that apply to these commands (`THM_EMISSIVITY_INVALID`, `THM_UNITS_MISMATCH`).

| Item | Where |
| ---- | ----- |
| `thermal_analytic_check` | `packages/core/src/commands/thermal/{analyticCheck,analyticChecks,constants}.ts`, closed forms in `lib/thermalClosedForms.ts` |
| `compute_view_factors` | `commands/thermal/computeViewFactors.ts`, `lib/{viewFactorContour,planarFacets,segmentTriangle}.ts` |
| Units table §5.3 | `lib/thermalUnits.ts` (derived from dimension vectors; round-trip 1e-12; moved from `commands/thermal/` so the FE plugin can use it) |

Toolset `analysis`.

**Deviations (recorded, not silent):**

- **Placement.** Core feature catalog `commands/thermal/` (no `packages/domain-physics`; README §8.3 decision 1 still open), as PHY-00/01.
- **Check names.** `stefan` is the Neumann one-phase melting problem (VC-THM-12); σ (VC-THM-13) is `stefan_boltzmann`. `view_factor`
  takes `configuration: parallel_rectangles | perpendicular_rectangles | coaxial_discs | cube_summation`. Inputs are `{ value, unit }`
  maps (dimensionless unit `"1"`); temperature differences must be in K. `lumped` warns (not refuses) when Bi ≥ 0.1.
- **View factors.** Inputs are explicit planar polygons (`surfaces[{ name, vertices, flip? }]` + `lengthUnit`), not 05 `FeaTarget`
  faces, so the command is not `requiresKernel`. Quadrature: closed-form inner integral of ln r along one edge, adaptive 8-point
  Gauss–Legendre on the other (exact for collinear / touching edges). Obstruction uses the centroid-segment test per facet pair
  (refine with `maxFacetSize`). VC-THM-09.d (discs) uses 64-gons and passes within the case tolerance (≈ 1e-3).
- **Extra codes:** `THM_INPUT_INVALID`, `THM_SURFACE_INVALID`, `THM_FACET_LIMIT` (400 facets, surfaces + blockers; at most 16 blockers and 256 vertices per polygon; the TS path keeps this cap, larger cases go to `llull-compute geomq`, §2.2), `THM_VIEW_FACTOR_ROWSUM` (closed cavity
  row sum off by > 1e-3).

**FE milestones M0–M3 and the M4 decks: built (2026-10-16, owner decision).** The minimal 05 FEA slice was built first
(`docs/physics/FE_PIPELINE_DESIGN.md`) and the thermal discipline sits inside it — **Proposal B** of §2.1 (`packages/domain-cae/src/thermal/`),
so no core extension port was needed.

| Item | Where |
| ---- | ----- |
| Set-up commands `add/update/delete_thermal_bc`, `set_initial_temperature`, `define/delete_amplitude`, `set_thermal_step`, `add/delete_temperature_limit`, `add_cavity_radiation`, `add_thermal_contact`, `set_thermal_physical_constants` | `packages/domain-cae/src/thermal/{bcCommands,stepCommands,amplitude,limitCommands,radiationCommands,constantsCommand}.ts` (toolset `analysis`) |
| Deck sections §5.1 (materials tabulated from PHY-01 models, `*HEAT TRANSFER`, BCs, `*FILM`, `*RADIATE` incl. `CAVITY=`, output) | `thermal/{deck,deckMaterial,deckLoads,deckStep,deckNames}.ts`, assembled by the 05 `writeInp` |
| Summary + heat balance §5.5 | `thermal/{summary,heatBalance,bcFlows,storedEnergy,meshGeometry}.ts` |
| `thermal_report`, `check_thermal`, `check_temperature_limits`, `dispose_thermal_limit` (human gate) | `thermal/{report,check,limitsCheck,limitRows,dispose}.ts` |
| Solve path | server `fea_mesh` (Gmsh 4.15.2) → `fea_solve` (CalculiX `ccx`) → `record_*` validated against the artifact store |

FE benchmarks, real Gmsh + ccx 2.21, judged by the PHY-00 judge (`server/tests/feaThermal*.test.ts`, adapted plans in
`server/tests/fixtures/thermal/`, run by `npm run quality:physics`): VC-THM-01.a–d (wall), 03 (T3 36.48 °C vs 36.60, 0.33 %), 04 (T4
18.2542 vs 18.2538), 05 (T2 927.004 K, exact σ), 14.a/b (oneel8ra), plus 61 (all ten set-ups, CLI), 50 (incl. the dependent thermo_static going stale), 62, 63 at unit level and an
open-cavity case against the exact view-factor network (0.5 %).

**FE deviations:**

- **Output times (§11 Q2), decided on ccx 2.21:** `DIRECT` cannot be combined with `*TIME POINTS`, so fixed increments write every
  `outputEveryS / increment` increments (`FREQUENCY`) and `set_thermal_step` refuses `fixedIncrements` with `outputTimesS`; automatic
  increments use a `*TIME POINTS` set (requested times + end time).
- **Material tables** cover the case temperatures (initial, prescribed, film sinks, amplitude extremes) ± 50 K inside the model's equation
  range; radiation sinks are excluded (a 3 K sink would demand k at 3 K); fields leaving the tables report `THM_PROPERTY_OUT_OF_RANGE`.
- **Heat balance:** CalculiX's RFL omits loads applied at prescribed nodes and their capacity; the summary corrects both. Steady cases
  balance to ≤ 1e-3; an amplitude-driven transient (T3) keeps ≈ 1.7 % (0.25 s increments) and reports `THM_HEAT_BALANCE`. Cavity cases
  report "heat balance not evaluated" (the cavity exchange is not integrated).
- **σ override:** `set_thermal_physical_constants` records an explicit σ (`defaulted: false`, source required); the oneel8ra case uses
  CalculiX's 5.669e-8 (the exact SI σ misses its 1e-4 tolerance by 2.2e-4 — kept visible by a test). The default stays the exact SI value.
- **Probes:** temperature probes are interpolated with the containing C3D4 / C3D10 element's shape functions (nearest node was 3 % low
  on T3); other quantities use the nearest node.
- **Targets** are resolved by the mesher (closest Gmsh surface / node to the given points), not by the 05 face map (TR-FEA-32, needs the
  01 face-query port); with the Manifold kernel faces are the 40° crease regions of the tessellation.
- **Contact conductance:** written, see "V1 additions (2026-10-17)" below.
- **Human gate:** `dispose_thermal_limit` verifies through `ctx.humanSignature`; no implementation is installed (09 PLM not built), so
  every call is refused with `THM_HUMAN_GATE` — the specified agent-path behaviour. Payload:
  `sha256(canonicalJson({ kind, analysisId, rowId, decision, justification, resultsHash }))`.
- **Extra codes:** `THM_BC_NOT_FOUND`, `THM_AMPLITUDE_NOT_FOUND`, `THM_AMPLITUDE_IN_USE`, `THM_LIMIT_INVALID`, `THM_LIMIT_NOT_FOUND`,
  `THM_CONTACT_INVALID`, `THM_TABLE_POINTS`, `THM_CONSTANT_INVALID`.

**Still open:** phase change (V2); ε(T) tables (needs PHY-15 emissivity data, absent) and `render_view field=temperature` (M4 V1); h(T) in transient
cases; a signing implementation (09 PLM); the `llull guide` thermal section.

**V1 additions (2026-10-17), all measured on ccx 2.21 with Gmsh 4.15.2 through plan -> `fea_mesh` -> `fea_solve` -> `thermal_report`:**

| Item | Result |
| ---- | ------ |
| Contact conductance (TR-THM-15) | `thermal/deckContact.ts`. Card set: `*SURFACE, TYPE=ELEMENT` (master and slave from the face sets `K_<contactId>_M` / `_S`), `*SURFACE INTERACTION`, `*SURFACE BEHAVIOR, PRESSURE-OVERCLOSURE=TIED`, `*GAP CONDUCTANCE` (one row `h, 0` or table rows `h, p, T`), `*CONTACT PAIR, INTERACTION=, TYPE=SURFACE TO SURFACE` (slave first). Found by hand decks (the `contact7–9` decks are not available locally); the tied pair needs no spring stiffness line. The two parts are meshed as separate volumes, so the face meshes do not match; this does not matter (flux 64860.6 on tet10 h = 0.01, 64862.5–64864.8 on tet4 / tet10 h = 0.05, 0.025, 0.01 for 64864.8649: at most 7e-5 relative). A table is read at the MEAN temperature of the two faces and at zero pressure (verified: h = 1000 + 30 T_mean reproduced). `THM_CONTACT_UNSUPPORTED` is removed; `check_thermal` reports `THM_CONTACT_INVALID` for a contact whose parts are not two different parts of the case. VC-THM-11.a/b pass (`server/tests/feaThermalContact.test.ts`): flux 64860.6 W/m^2 (pack 64864.8649, 0.5 %), interface jump 32.434 K (32.4324, 1 %). |
| VC-THM-30 (CalculiX vs llull view factor) | `server/tests/feaThermalViewFactor.test.ts`. F12 inferred from the plate-1 heat flow of an open-cavity run (plate 1 and the environment at 1 K, plate 2 at 500 K, k = 1e5 so the faces sit at the BC temperatures, `F = (q1/(sigma A) - (T1^4 - Te^4)) / -(T2^4 - Te^4)`): **0.1998337** (tet10, h = 0.05), 0.1998339 (tet4, h = 0.025), 0.199970 (tet4, h = 0.1). `compute_view_factors`: 0.19982489569839; closed form 0.199824895698. CalculiX minus closed form: +9e-6 (converged), +1.5e-4 (coarse). **Pinned 2026-10-17 (owner-approved recommendation):** the pack now carries the closed form 0.199824895698, tolerance 0.0005 abs, grade A; the converged ccx factor is judged by `expectCase` and counted by `quality:physics`. CalculiX is therefore no less accurate than the TS factor for opposed squares; for other geometries it stays open. |
| Orthotropic conductivity | k property models with `direction` '1', '2', '3' (PHY-01 directions) make the material orthotropic: `*CONDUCTIVITY, TYPE=ORTHO` with `k1, k2, k3[, T]` rows on the union of the directional temperature grids (each direction tabulated to the named tolerance and held at its end values like the solver does). The directions are the DOCUMENT X, Y, Z axes: a rotated part with an orthotropic material is refused (`THM_MATERIAL_ORTHO_ROTATED`, no `*ORIENTATION` is written); k models for only some directions give `THM_MATERIAL_K_ORTHO`. Validated on a 0.1 m cube with k = (10, 20, 30) held at 100 / 0 degC along each axis: 100 / 200 / 300 W within 1e-3, mid temperature 50 degC (`server/tests/feaThermalOrtho.test.ts`). |
| h(T) film coefficient | `add_thermal_bc kind=film` with `filmTable: { points: [[T, h], ...] }` instead of `filmCoefficient` (stored as `filmCoefficient: { table: { points } }`; T on the case scale, strictly increasing, h > 0, `source` mandatory, no amplitude). CalculiX has NO table on `*FILM` (`film.f` user subroutine only; only the time amplitudes `AMPLITUDE=` / `FILM AMPLITUDE=` exist). The deck therefore writes the table as a tied `*GAP CONDUCTANCE` to a dummy wedge layer (C3D6 / C3D15, one per film face, coincident with the face) whose nodes are prescribed at the sink temperature; the gap table is read at (Ts + Tsink)/2, so rows are written at Tm = (T + Tsink)/2 and q = h(Ts)(Ts - Tsink) exactly (`thermal/deckFilmSink.ts`). The dummy layer MUST be the slave: with the face as slave ccx left 2–4 K error on a coarse mesh. **Steady only:** 1D slab k = 50, L = 0.1, h = 100 + 2 T into 20 degC, bottom 100 degC: face 73.54160 degC vs closed form 73.54157, flux 13229.2 W/m^2, balance residual < 2e-6, identical on tet4 h = 0.05, tet10 h = 0.05 and 0.1. In a transient the same construction gave surface temperature rises 2–8 % off a constant `*FILM` at equal h (hand hex model, converged in mesh and time step: 26.55 vs 26.40 degC; the gap behaves like a 12 % smaller h at h = 500), so `add_thermal_bc` refuses a table in any case but heat_steady (`THM_FILM_INVALID`; the coupled deck reuses `bcLines`, which refuses it too). `bcFlows` integrates h(T)(Tsink - T) over the face for the report. `TableRef` (CSV hash reference) is not supported: the model gained `FilmTable` with inline points. |
| ε(T) | Not built: PHY-15 emissivity data is absent. |

**Review fixes (2026-10-17):**

- **Read paths re-verify (05 §4.1).** `thermal_report`, `check_thermal` and `check_temperature_limits` use the results summary recomputed from the
  artifact (`trustedRecord`): state `untrusted` + `FEA_SUMMARY_MISMATCH` when the recorded one differs, `missing` without an artifact store /
  artifact; numbers are returned only for `solved`. `check_thermal` now reports `state`; post-solve items (`THM_HEAT_BALANCE`,
  `THM_PROPERTY_OUT_OF_RANGE`) come only from a verified summary.
- **Dispositions are claims.** `dispose_thermal_limit` stores the verified `signature` next to the decision; `check_temperature_limits` counts a
  stored disposition only if it is on the current results AND re-verifies through `ctx.humanSignature` against the payload
  (`sha256(canonicalJson({ kind, analysisId, rowId, decision, justification, resultsHash }))`). Otherwise the row stays `pending_human`, carries
  `unverifiedDisposition { decision, signer, reason }` and `THM_DISPOSITION_UNVERIFIED` (warning) is added.
- **Deck text.** BC names, cavity names / ids, material origin and unverified reasons pass through `commentText`; the cavity keyword uses the
  sanitised upper-case name; `add_cavity_radiation` accepts only `[A-Za-z0-9_]{1,3}`.
- **Temperatures** of every thermal quantity are bounded to (0, 1e5] K (named guard "llull guard", `shared/quantity.ts`).
