# Gap 01 PSC — Piping specifications and component catalogue: technical specification

Status: written 2026-10-18; M0 + M1 built 2026-10-23 (§13.1 to §13.4), M2 built 2026-10-23 (§13.5). Functional view: [`FUNCTIONAL_SPEC.md`](FUNCTIONAL_SPEC.md).
Validation: [`validation/README.md`](validation/README.md). Laws: `.claude/rules/architecture.md` (L1–L10).

## 1. Current state in llull (before this gap)

| Area                       | File                                                                                                                                                                                                                                                                                      | What exists                                                                                                  | Limit for plant work                                                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pipe element               | `packages/core/src/model/building.ts` (`PipeElement`, l. 251)                                                                                                                                                                                                                             | `points: Vec3[]`, `diameter`, `service`, `material`, optional `line`, `dn`, `from`, `to`                     | no spec, schedule, wall, rating, insulation; one element = one polyline                                                                                   |
| Pipe creation              | `packages/domain-aec/src/industrial/equipment/equipment.ts` (`add_pipe_run`)                                                                                                                                                                                                              | route through points, OD from `dn` (15…400) or `diameter`, bends at interior points, duplicate-route refusal | bends are implicit vertices (no fitting entity); no component choice                                                                                      |
| Size table                 | `packages/domain-aec/src/industrial/piping/pipeSizes.ts` (`PIPE_SIZES`)                                                                                                                                                                                                                   | 19 rows `[DN, OD, standard wall, max support span]`, "EN 10220 / ASME B36.10M"                               | mixes EN 10220 ODs (26.9, 33.7, 42.4, 76.1, 139.7) with ASME STD walls; no schedules; NPS absent (see `validation/data/llull_pipe_sizes_crosscheck.json`) |
| Weight                     | `industrial/piping/pipeWeight.ts` (`pipeWallThickness`, `pipeWeightPerMetre`)                                                                                                                                                                                                             | wall by OD match within 1.5 mm, else `max(2.5, OD/40)`; kN/m with steel 7850 kg/m³ + contents                | ASME NPS 2½ (73.0) and NPS 5 (141.3) fall to the fallback wall (2.5 / 3.53 mm instead of 5.16 / 6.55)                                                     |
| Consumers of wall / weight | `industrial/piping/pipeHydraulics.ts` (inner diameter), `pipeSupportRiser.ts` (riser load), `industrial/steelDesign/steelLineLoads.ts` (pipe line loads on beams)                                                                                                                         | read the helper above                                                                                        | inherit its error                                                                                                                                         |
| Supports                   | `industrial/piping/pipeSupports.ts`, `pipeSupportCheck.ts`, `pipeSpans.ts`                                                                                                                                                                                                                | shoe / guide / anchor / hanger, MSS SP-69 spans                                                              | spans keyed on DN, not on the spec's actual pipe                                                                                                          |
| Hydraulics                 | `industrial/piping/pipeFlow.ts`, `pipeHydraulics.ts`                                                                                                                                                                                                                                      | Darcy–Weisbach, Colebrook, bend K                                                                            | inner diameter from the mixed table                                                                                                                       |
| Lists / takeoff            | `building/quantities/scheduleBuild.ts` (kind `pipe`), `takeoffCompute.ts` (`pipe` by service × Ø)                                                                                                                                                                                         | line list, length takeoff                                                                                    | no fittings, flanges, gaskets, bolts, valves in the MTO                                                                                                   |
| Export                     | `building/exchange/ifcIndustrialExport.ts`                                                                                                                                                                                                                                                | `IFCPIPESEGMENT … .RIGIDSEGMENT.`                                                                            | no `IfcPipeFitting`, `IfcValve`, no property sets for class / schedule                                                                                    |
| Clash                      | `industrial/clash/*`                                                                                                                                                                                                                                                                      | pipe-vs-structure hard clashes                                                                               | pipe envelope = OD only (no flanges / valves)                                                                                                             |
| Library precedent          | `packages/domain-aero/src/fasteners/catalogFile.ts`, `catalogCommands.ts`, `codes.ts` (`import_fastener_catalog`, `FAST_*` codes, zod file schema, provenance per value) and `packages/core/src/model/materialLibrary.ts` (`LICENCE_FLAGS`, `MaterialLibraryProvider` on `ctx.libraries`) | catalogue import with provenance / licence, private libraries                                                | reused as the pattern for piping catalogues                                                                                                               |
| Human gate                 | `packages/core/src/model/humanGate.ts`, 09 PLM `record_signature`                                                                                                                                                                                                                         | signature-verified acts                                                                                      | reused for spec approval                                                                                                                                  |
| Check envelope             | `packages/core/src/model/checkResult.ts` (`CheckStatus`, `CheckItem`, `CheckThreshold` with grade / defaulted)                                                                                                                                                                            | agent-first check rows                                                                                       | reused by `check_pipe_spec` / `check_piping_catalog`                                                                                                      |

No command in the registry knows NPS, schedule, B16.x, a fitting, a flange, a rating class or a spec. The CLI could not
be run in the authoring sandbox (`node_modules` absent); the inventory above comes from reading the sources.

## 2. Target architecture

- **Placement (L10).** A new plugin `piping` (toolset `piping`) in `packages/domain-aec/src/plant/piping/`, installed by
  `src/app/plugins.ts` after `industrialPlugin`. Folders: `catalog/` (types re-exported from core model, bundled data,
  lookup, import / export, catalogue checks), `spec/` (spec model, editing ops, resolution, branch table, spec checks,
  lifecycle), `ratings/` (P-T tables, interpolation), `properties/` (section properties, B31.3 wall), `shapes/`
  (shape recipes per component type), `codes.ts` (error codes + remediation, like `fasteners/codes.ts`). The routing
  pack 02 RTE adds `routing/` to the same plugin; 05 ISO, 07 PST, 08 DAT and 09 VIS consume this plugin's queries.
- **Core changes (Lane 1, small, backward compatible).**
  - `packages/core/src/model/piping.ts` (new, pure types): `PipingCatalog`, `ComponentFamily`, `PipeSpec`,
    `RatingTable`, `NominalSize`, `SpecBinding`. Types live in core so `PipeElement` can reference them and other
    plugins can read them without importing the plugin (L10: plugins see core only).
  - `PipeElement` gains optional `spec?: SpecBinding` (`{ specId, revision, nps, schedule, wallMm, odMm,
dimensionalStandard }`). Old documents load unchanged; no migration.
  - `industrial/piping/pipeWeight.ts` and the three consumers take `wallMm` from `pipe.spec` when present
    (TR-PSC-12). This edit is in `domain-aec`, not core.
- **Purity (L1/L3).** Every command is `(doc, params, ctx) → { document, summary, affected, data?, error? }`.
  Queries never change the document. Imports and edits return a new document with a new `piping` slice.
- **Single source of truth (L4).** Imported catalogues and specs are document data (`doc.plugins.piping` slice via
  `DocumentExtension`, validated on load like `fasteners`). The bundled open catalogue is code data in the plugin,
  versioned with llull and addressed by id `llull-open-piping@<version>`; a spec records the catalogue version it was
  resolved against.
- **Kernel (L9).** Catalogue, spec, rating and check commands need no kernel. `component_shape` returns a
  `ShapeRecipe` (torus segment, cylinders, cones, discs with holes) and analytic bounds; the solid is built by the
  caller (02 RTE `insert_*` commands) through `ctx.kernel` with `requiresKernel` on those commands only.
- **Private / licensed data.** Catalogues flagged `licensed-no-redistribution` are stored outside the document and
  reached through a `PipingLibraryProvider` on `ctx.libraries` (same port shape as `MaterialLibraryProvider`); the
  document stores only `{ libraryId, version, sha256 }`. Missing provider → `PSC_LIBRARY_UNRESOLVED`.
- **Contract with 02 RTE.** 02 RTE's TECHNICAL*SPEC §3.3 defines a `SpecLookup` port (`status`, `pipe`, `component`,
  `elbowAngles`, `connection`, `branch`, `insulation`; DN-keyed; misses as `RTE_SPEC*\*`). This plugin implements it as a
thin adapter over §5.5: DN → NPS through the §5.1 map, `PSC_NO_COMPONENT`/`PSC_AMBIGUOUS_COMPONENT`/`PSC_SPEC_UNKNOWN`mapped to`RTE_SPEC_NO_COMPONENT`/`RTE_SPEC_AMBIGUOUS`/`RTE_SPEC_UNKNOWN`(the PSC code kept
in`detail`), `CatalogueRow.key`=`<specId>/<componentId>/<sizeKey>`, `unverified`= not`verified`. If the shared
`doc.plant`slice proposed by 02 RTE is adopted, specs, catalogues and rating tables live in`doc.plant.specs`instead of a separate`piping` slice (same types; decision in §11 Q2).
- **Determinism (AF-13).** Catalogue rows are sorted by (family, size key); specs serialise with sorted keys and
  normalised numbers (canonical JSON); ids of imported objects are the user's ids (validated `^[A-Za-z0-9._-]{1,64}$`).

## 3. Data model

```ts
// packages/core/src/model/piping.ts — sketches, final names may change in review
export type DimensionalStandard = 'ASME' | 'EN' | 'ISO' | 'company';
export type NominalSystem = 'NPS' | 'DN';

/** NPS as a canonical designation plus its numeric value; DN as integer. "2-1/2" ↔ 2.5 ↔ DN65 via a fixed map. */
export interface NominalSize {
  readonly system: NominalSystem;
  readonly key: string;
  readonly value: number;
}

export type EndType = 'BW' | 'SW' | 'THD' | 'FL' | 'PE' | 'BE' | 'LUG' | 'WAF';
export type Facing = 'RF' | 'FF' | 'RTJ' | 'TG' | 'MF';
export type ComponentType =
  | 'pipe'
  | 'elbow90'
  | 'elbow45'
  | 'tee'
  | 'reducingTee'
  | 'reducerConcentric'
  | 'reducerEccentric'
  | 'cap'
  | 'flangeWeldNeck'
  | 'flangeSlipOn'
  | 'flangeBlind'
  | 'flangeSocketWeld'
  | 'flangeThreaded'
  | 'flangeLapJoint'
  | 'gasketSpiralWound'
  | 'gasketSheet'
  | 'gasketRing'
  | 'boltSet'
  | 'weldolet'
  | 'sockolet'
  | 'threadolet'
  | 'coupling'
  | 'union'
  | 'swage'
  | 'valveGate'
  | 'valveGlobe'
  | 'valveCheck'
  | 'valveBall'
  | 'valveButterfly'
  | 'valvePlug';

export interface Provenance {
  readonly sourceId?: string;
  readonly citation?: string;
  readonly url?: string;
  readonly accessed?: string;
}

/** One dimension value with its unit and trust. `verified` = grade A (two sources or primary). */
export interface Dim {
  readonly value: number;
  readonly unit: 'mm' | 'in';
  readonly verified: boolean;
  readonly provenance: Provenance;
}

export interface ComponentSize {
  readonly size: NominalSize;
  readonly smallSize?: NominalSize; // reducers, reducing tees, olets (branch)
  readonly schedule?: string; // pipe rows: "40", "STD", "10S" …
  readonly class?: number; // ASME class (150…2500) or 3000/6000 for B16.11
  readonly pn?: number; // EN PN
  readonly facing?: Facing;
  readonly dims: Readonly<Record<string, Dim>>; // outsideDiameter, wall, centreToEnd, boltCircle, boltCount, boltDiameter, …
}

export interface ComponentFamily {
  readonly id: string; // "asme-b16.9-lr90"
  readonly type: ComponentType;
  readonly standard: string; // "ASME B16.9"
  readonly dimensionalStandard: DimensionalStandard;
  readonly radius?: 'LR' | 'SR' | '3D' | '5D';
  readonly ends: readonly EndType[];
  readonly sizes: readonly ComponentSize[];
  readonly rules?: readonly string[]; // rule ids checked by check_piping_catalog ("b169.lr90")
}

export interface PipingCatalog {
  readonly format: 'llull-piping-catalog';
  readonly schemaVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly title?: string;
  readonly licence: LicenceFlag; // from core materialLibrary
  readonly families: readonly ComponentFamily[];
}

export interface RatingTable {
  readonly id: string; // "asme-b16.5-group-1.1"
  readonly standard: 'ASME B16.5' | 'ASME B16.34' | 'EN 1092-1' | 'company';
  readonly materialGroup: string; // "1.1" or EN material number
  readonly rows: readonly { readonly ratingClass: number; readonly temperatureC: number; readonly bar: Dim }[];
  readonly minTemperatureC: number;
}

export interface SpecComponent {
  readonly id: string; // short code, unique in the spec ("E90-LR")
  readonly type: ComponentType;
  readonly from: NominalSize;
  readonly to: NominalSize;
  readonly branchFrom?: NominalSize;
  readonly branchTo?: NominalSize;
  readonly catalogRef: string; // family id or standard alias resolved to a family
  readonly ends?: EndType;
  readonly facing?: Facing;
  readonly class?: number;
  readonly pn?: number;
  readonly radius?: 'LR' | 'SR';
  readonly schedule?: string; // explicit schedule …
  readonly scheduleFromPipe?: boolean; // … or the pipe's schedule at that size
  readonly wallMm?: number; // EN: explicit wall per range
  readonly priority?: number; // lower wins; equal priorities that both match → PSC_AMBIGUOUS_COMPONENT
  readonly commodityCode?: string;
  readonly description?: string;
  readonly material?: string;
}

export type BranchFitting = 'T' | 'RT' | 'W' | 'S' | 'TH' | 'SI' | 'SIR';

export interface PipeSpec {
  readonly format: 'llull-pipe-spec';
  readonly schemaVersion: 1;
  readonly id: string;
  readonly revision: number;
  readonly title?: string;
  readonly service?: string;
  readonly dimensionalStandard: DimensionalStandard;
  readonly rating: {
    readonly system: string;
    readonly class?: number;
    readonly pn?: number;
    readonly materialGroup?: string;
    readonly ratingTableId?: string;
  };
  readonly materials?: Readonly<Record<string, string>>;
  readonly corrosionAllowance: { readonly value: number; readonly unit: 'mm' | 'in' };
  readonly millTolerance?: number; // fraction, e.g. 0.125
  readonly designLimits?: { readonly minTemperatureC?: number; readonly maxTemperatureC?: number };
  readonly sizeRange: { readonly from: NominalSize; readonly to: NominalSize };
  readonly catalogs: readonly string[]; // catalogue ids searched in order
  readonly components: readonly SpecComponent[];
  readonly branchTable?: { readonly cells: Readonly<Record<string, Readonly<Record<string, BranchFitting>>>> };
  readonly elbowAngles?: { readonly anglesDeg: readonly number[]; readonly toleranceDeg: number; readonly trimmedAllowed: boolean }; // for 02 RTE
  readonly insulation?: readonly {
    readonly from: NominalSize;
    readonly to: NominalSize;
    readonly maxTemperatureC: number;
    readonly thicknessMm: number;
    readonly material: string;
  }[]; // V1, company table, provenance required
  readonly status: 'draft' | 'approved' | 'superseded';
  readonly approval?: { readonly signer: string; readonly signatureId: string; readonly at: string };
  readonly provenance?: Provenance;
}

/** Stored on PipeElement.spec (core building model). */
export interface SpecBinding {
  readonly specId: string;
  readonly revision: number;
  readonly nps: string;
  readonly schedule?: string;
  readonly odMm: number;
  readonly wallMm: number;
  readonly dimensionalStandard: DimensionalStandard;
  readonly verified: boolean;
}
```

Document slice (plugin `piping`): `{ catalogs: Record<id, PipingCatalog | LibraryRef>, specs: Record<id, PipeSpec[]>
(all revisions), ratingTables: Record<id, RatingTable> }`. Validation on load reuses the import schemas (errors →
persistence rejects the file, as for `fasteners`). The fixture
[`validation/data/sample_spec_cs150.json`](validation/data/sample_spec_cs150.json) shows the file form (sizes as
numbers `fromNps` / `toNps` are accepted on import and normalised to `NominalSize`).

## 4. Commands (toolset `piping`)

All names snake_case; every numeric param states its unit or takes `{ value, unit }` (AF-04). "Q" = read-only query
(`annotations: { readOnly: true, idempotent: true }`), "M" = mutating.

| Command                   | Kind      | Params (sketch)                                                                                                                                                                          | data / effect                                                                                              | Phase |
| ------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----- |
| `list_piping_catalogs`    | Q         | `catalogId?`, `type?`, `standard?`                                                                                                                                                       | families, size keys, verified counts, licence                                                              | MVP   |
| `lookup_piping_component` | Q         | `catalogId?` (default bundled), `type`, `nps \| dn`, `smallNps?`, `schedule?`, `class?`, `pn?`, `facing?`, `radius?`, `standard?`                                                        | one size row: dims in mm with `verified` + source; derived dims (ID, hole = bolt + ⅛ in) flagged `derived` | MVP   |
| `import_piping_catalog`   | M         | `catalog` (file object), `replace?`                                                                                                                                                      | adds catalogue to the slice                                                                                | MVP   |
| `export_piping_catalog`   | Q         | `catalogId`, `format: 'json' \| 'csv'`                                                                                                                                                   | canonical file + sha256 (`--save`)                                                                         | MVP   |
| `check_piping_catalog`    | Q         | `catalogId`, `rules?`                                                                                                                                                                    | `CheckItem[]` (codes §7)                                                                                   | MVP   |
| `pt_rating`               | Q         | `standard`, `materialGroup`, `class \| pn`, `temperature {value, unit}` or `temperatureC`, `unit?: 'bar' \| 'psi'`                                                                       | rating, bracketing rows, method, verified                                                                  | MVP   |
| `pipe_section_properties` | Q         | `pipeId` or (`nps \| dn`, `schedule \| wallMm`, `standard`), `contentDensityKgM3?`, `insulation? {thicknessMm, densityKgM3}`, `materialDensityKgM3?` (default 7850, named)               | ID, areas, I, Z, mass/m (metal, content, insulation, total), weight kN/m, provenance                       | MVP   |
| `import_pipe_spec`        | M         | `spec` (file object), `replace?`                                                                                                                                                         | new spec (revision 1 or next)                                                                              | MVP   |
| `create_pipe_spec`        | M         | header fields only                                                                                                                                                                       | empty draft spec                                                                                           | MVP   |
| `edit_pipe_spec`          | M         | `specId`, `ops[]` (`addComponent`, `updateComponent`, `removeComponent`, `setSizeRange`, `setBranchCell`, `clearBranchCell`, `setHeader`)                                                | new draft revision when the current one is approved; same revision when draft                              | MVP   |
| `list_pipe_specs`         | Q         | `specId?`, `status?`                                                                                                                                                                     | ids, revisions, status, size range, rating                                                                 | MVP   |
| `resolve_spec_component`  | Q         | `specId`, `type`, `nps \| dn`, `branchNps?`, `ends?`, `facing?`, `radius?`                                                                                                               | component id, catalogue row, schedule, wall, dims, verified, commodity code                                | MVP   |
| `resolve_branch`          | Q         | `specId`, `headerNps`, `branchNps`                                                                                                                                                       | fitting code + resolved component(s)                                                                       | MVP   |
| `check_pipe_spec`         | Q         | `specId?`, `scope?: 'spec' \| 'document'`, `design? {pressureBar \| pressure{value,unit}, temperatureC}`                                                                                 | `CheckItem[]`, status                                                                                      | MVP   |
| `export_pipe_spec`        | Q         | `specId`, `revision?`, `format: 'json' \| 'csv'`                                                                                                                                         | canonical text + sha256                                                                                    | MVP   |
| `approve_pipe_spec`       | M (gated) | `specId`, `signatureId`                                                                                                                                                                  | status approved; refuses without a verified human signature                                                | MVP   |
| `assign_pipe_spec`        | M         | `pipeId \| line`, `specId`, `nps`, `schedule?`                                                                                                                                           | sets `PipeElement.spec`, OD from spec                                                                      | MVP   |
| `add_pipe_run` (existing) | M         | new optional `spec`, `nps`                                                                                                                                                               | OD / wall / schedule from spec; `data` gains `outsideDiameterMm`, `schedule`, `wallMm`                     | MVP   |
| `pipe_wall_check`         | Q         | `nps \| odMm`, `schedule?`, `pressure {value,unit}`, `allowableStress {value,unit}`, `jointFactorE`, `weldStrengthW`, `coefficientY`, `corrosionAllowance {value,unit}`, `millTolerance` | t, tm, required nominal, lightest schedule, `reviewRequired`                                               | V1    |
| `resolve_joint`           | Q         | `specId`, `nps`, `endA`, `endB`                                                                                                                                                          | flange pair, gasket, bolt set (count, diameter, stud length)                                               | V1    |
| `component_shape`         | Q         | `specId` + `componentId` + size, or catalogue keys                                                                                                                                       | `ShapeRecipe`, analytic bounds, ports (position, direction, OD, end type)                                  | V1    |
| `diff_pipe_spec`          | Q         | `specId`, `fromRevision`, `toRevision`                                                                                                                                                   | changed components / cells                                                                                 | V1    |

Tags for the main commands (as they will appear in the source):

```ts
/**
 * @affects none; data = { componentId, type, size, schedule, wallMm, dims, verified, source, commodityCode }
 * @invariant exactly one component or a refusal; the same (spec revision, query) always returns the same component
 * @failure unknown spec -> PSC_SPEC_UNKNOWN; size outside spec range -> PSC_SIZE_OUT_OF_RANGE; no component of the
 *          type covers the size -> PSC_NO_COMPONENT; two equal-priority matches -> PSC_AMBIGUOUS_COMPONENT;
 *          catalogue row missing -> PSC_CATALOG_ROW_MISSING
 */
export const resolveSpecComponent = defineCommand({ name: 'resolve_spec_component', annotations: { readOnly: true, idempotent: true }, … });

/**
 * @affects piping.specs[specId] (appends a revision when the current one is approved)
 * @invariant ops apply in order, all or nothing; ids unique; ranges of the same type and options never overlap at equal priority
 * @failure malformed op -> PSC_SPEC_INVALID (path = ops.N); component in use by pipes and removed -> PSC_SPEC_IN_USE
 */
export const editPipeSpec = defineCommand({ name: 'edit_pipe_spec', … });

/**
 * @affects none; data = CheckResult { status, items[] }
 * @invariant read-only; every fail has a code, ids and remediation; unverified inputs always produce PSC_DATA_UNVERIFIED (warn)
 * @failure unknown spec -> PSC_SPEC_UNKNOWN (no data)
 */
export const checkPipeSpec = defineCommand({ name: 'check_pipe_spec', … });

/**
 * @affects piping.specs[specId].status = approved, approval = { signer, signatureId, at }
 * @invariant only a verified human signature (09 PLM record_signature, AF-34a) clears the gate
 * @failure no / invalid signature or agent caller -> PSC_HUMAN_GATE; spec has fail items -> PSC_SPEC_CHECK_FAILED
 */
export const approvePipeSpec = defineCommand({ name: 'approve_pipe_spec', … });
```

Descriptions follow AF-02 (what, when, units, refusals, next command), e.g. `resolve_spec_component`: "Pick the one
component a pipe spec allows for a type and nominal size (NPS inch designation, or DN). Returns its catalogue
dimensions in mm with `verified` flags, the schedule and wall for BW parts, and the commodity code. Refuses sizes
outside the spec (PSC_SIZE_OUT_OF_RANGE) and types the spec does not define at that size (PSC_NO_COMPONENT). Next:
02 RTE routing commands consume it; check_pipe_spec validates the spec."

## 5. Algorithms

### 5.1 Nominal sizes (TR-PSC-01)

- NPS keys are canonical designations (`"1/8"`, `"1/2"`, `"2-1/2"`, `"24"`), parsed to an exact rational and compared
  by value; numeric input (`2.5`) is accepted and mapped to the key. DN ↔ NPS uses the fixed ISO 6708 / B36.10M pairing
  (DN15 ↔ ½, DN20 ↔ ¾, DN25 ↔ 1, DN32 ↔ 1¼, DN40 ↔ 1½, DN50 ↔ 2, DN65 ↔ 2½, DN80 ↔ 3, DN90 ↔ 3½, and DN = 25 × NPS for NPS ≥ 4),
  shipped as a table and unit-tested both ways.
- A spec's `dimensionalStandard` selects the OD source for a DN or NPS: ASME → B36.10M / B36.19M row, EN → EN 10220.
  The two differ at DN20/25/32/65/125 (26.9 vs 26.7, 33.7 vs 33.4, 42.4 vs 42.2, 76.1 vs 73.0, 139.7 vs 141.3 mm).

### 5.2 Catalogue lookup (TR-PSC-02, TR-PSC-03, TR-PSC-04)

- Index: `Map<familyId, Map<sizeKey, ComponentSize[]>>`, size key = `nps|smallNps|schedule|class|facing`; built once
  per catalogue version (memoised by sha256, AF-40).
- Pipe rows key on (standard, NPS, schedule): `"10"` (B36.10M) and `"10S"` (B36.19M) are distinct keys; a query with
  `schedule: "10"` and `standard` absent in an ASME spec resolves to B36.10M and says so (VC-PSC-18).
- Derived values are computed, never stored, and marked `derived: true` with the formula: ID = OD − 2t;
  bolt hole = bolt diameter + 1/8 in (3.2 mm) for B16.5 [S4]; LR 90 centre-to-end when a row is missing = 1.5 × NPS
  in × 25.4 (only for NPS ≥ ¾, `verified` from the rule's grade, VC-PSC-03).
- Bundled open catalogue v1 = the grade-A and grade-B rows of `validation/data/*.json` transcribed into TS data
  modules (≤ 500 lines each, split by family), with each row's `verified` = grade A and `provenance.sourceId` = the
  pack's S-id. Generation is a dev-time script in `scripts/` that reads the pack JSON; the generated modules are
  committed and covered by a test that diffs them against the pack JSON (no drift).

### 5.3 Section properties (TR-PSC-09)

With D = OD, t = wall, d = D − 2t (mm), ρ_s = 7850 kg/m³ (named default, overridable):

- metal area A_m = π/4 (D² − d²) = π (D − t) t; flow area A_f = π/4 d²
- plain-end mass m = ρ_s · A_m · 10⁻⁶ kg/m = 0.0246615 (D − t) t for ρ_s = 7850 (S16, S17) — VC-PSC-02
- content mass = ρ_c · A_f · 10⁻⁶; insulation mass = ρ_i · π/4 ((D + 2 t_i)² − D²) · 10⁻⁶
- I = π/64 (D⁴ − d⁴) mm⁴, Z = 2I/D mm³ (for 07 PST)
- weight per metre = Σ masses · g / 1000 kN/m with g = 9.80665 (same constant as `shared/numeric.ts`)

`pipeWeightPerMetre` keeps its signature; it becomes a thin call of the same function with the legacy wall rule, so
the old and new paths agree to 1e-9 for any (D, t) (bridge assertion in VC-PSC-02).

### 5.4 P-T rating (TR-PSC-07)

Rows sorted by temperature per class; the first row covers T_min..T_1 (B16.5: −29..38 °C). For T in (T_i, T_i+1]:
p(T) = p_i + (p_i+1 − p_i)(T − T_i)/(T_i+1 − T_i) (linear interpolation permitted by B16.5 [S7]).
T < T_min or T > T_max → `PSC_PT_TEMPERATURE_OUT_OF_TABLE`. The result is `verified` only when both bracketing rows
are. Units: bar gauge internally; psi output converts with 1 psi = 0.0689475729 bar and states it (the B16.5 bar and
psi tables are separately rounded: 285 psig = 19.65 bar vs 19.6 bar tabulated, so conversions are never compared to
tabulated values in tests).

### 5.5 Spec resolution (TR-PSC-06)

```
resolve(spec, type, size, filters):
  if size ∉ [spec.sizeRange.from, spec.sizeRange.to]            → PSC_SIZE_OUT_OF_RANGE (remediation: the range)
  C = spec.components.filter(c => c.type == type && c.from ≤ size ≤ c.to
                                  && (branch? c.branchFrom ≤ branch ≤ c.branchTo : true)
                                  && filters match (ends, facing, radius, class))
  if C empty                                                     → PSC_NO_COMPONENT (lists types defined at that size)
  keep min priority (default 100); if > 1 left                    → PSC_AMBIGUOUS_COMPONENT (ids)
  c = the one; schedule = c.schedule ?? (c.scheduleFromPipe ? resolve(spec,'pipe',size).schedule : undefined)
  row = catalogue(c.catalogRef).lookup(type, size, small?, schedule, class, facing)
  if row missing                                                 → PSC_CATALOG_ROW_MISSING
  return { c, row, schedule, wall, verified = all dims verified ∧ pipe row verified }
```

`resolve_branch`: cell = branchTable[header][branch]; empty → `PSC_BRANCH_UNDEFINED`; `T` → `tee` at header size,
`RT` → `reducingTee` (header, branch), `W`/`S`/`TH` → olet type with header + branch ranges, `SI`/`SIR` → stub-in
(no fitting; reinforcement check is 07 PST). Header and branch sizes are snapped to keys (no interpolation).
Complexity O(components) per call; specs have < 200 components.

### 5.6 Spec checks (TR-PSC-10, TR-PSC-11)

`check_pipe_spec` runs, in order, and returns `CheckItem`s (`findingKey` stable):

1. **Coverage**: for each catalogue size key in `sizeRange`, a `pipe` component resolves (`PSC_COVERAGE_GAP`), and
   each of `elbow90`, `tee`, `reducerConcentric`, `flange*`, `gasket*`, `boltSet` resolves where the spec declares
   the end type needs it (FL needs flange + gasket + bolt set) — warn.
2. **Overlaps**: equal-priority overlaps → fail `PSC_AMBIGUOUS_COMPONENT`.
3. **References**: every `catalogRef` and every resolved row exists → fail `PSC_CATALOG_ROW_MISSING`.
4. **Branch table**: every header ≥ branch cell for listed sizes filled → warn `PSC_BRANCH_UNDEFINED`; a branch larger
   than the header is never required.
5. **Design conditions** (when `design` given): rating p(T) from the spec's rating table; fail
   `PSC_PT_RATING_EXCEEDED` when P > p(T) with `values: { designBar, ratingBar, marginBar }`; T outside
   `designLimits` → fail `PSC_TEMPERATURE_LIMIT`.
6. **Dimensional standard**: for each BW fitting family, compare its end OD with the spec's pipe OD at the same size;
   |ΔOD| > 1.0 mm → fail `PSC_DIM_STANDARD_MIXED` (threshold named, source: the B16.9 end-diameter tolerance order of
   magnitude; the EN/ASME pairs differ by 0.2–3.1 mm, so 1.0 mm separates the gross mismatches DN65/DN125 from rounding;
   0.2–0.3 mm differences at DN20/25/32 are warn `PSC_DIM_STANDARD_ROUNDING`).
7. **Joint compatibility**: flange components of one size with different class or facing; BW ↔ SW without a
   transition component → warn `PSC_END_INCOMPATIBLE`.
8. **Trust and status**: any resolved dimension with `verified: false` → warn `PSC_DATA_UNVERIFIED` (never
   suppressible, AF-32); status draft / superseded → warn `PSC_SPEC_NOT_APPROVED`.
9. **Scope document**: every `PipeElement` without `spec` → warn `PSC_PIPE_NO_SPEC`; a pipe whose `spec.revision` is
   not the latest approved → warn `PSC_SPEC_REVISION_STALE`; a pipe whose OD differs from its spec row → fail
   `PSC_PIPE_SPEC_MISMATCH`.

`check_piping_catalog` applies family rules: `b169.lr90` (centre-to-end = 1.5 × NPS × 25.4 ± 2 mm for NPS ≥ ¾ [S8–S10,
tolerance S9]), `b169.sr90` (= NPS × 25.4 ± 2 mm), `b165.hole` (hole = bolt + 3.2 mm ± 0.1), `pipe.odMatch` (fitting
end OD equals the family's dimensional-standard pipe OD ± 0.2 mm), `monotonic` (OD, centre-to-end, bolt circle
non-decreasing with size), `provenance` (every dim has `citation` or `sourceId`). The dodo elbow table (radius 0.75 ×
OD) fails `b169.lr90` (VC-PSC-05).

### 5.7 Pressure-design wall (TR-PSC-08, V1)

ASME B31.3 eq. 3a [S18, S19]: t = P D / (2 (S E W + P Y)), valid for t < D/6 (else `PSC_WALL_THICK_PIPE`, Lamé
needed — out of scope); tm = t + c; required nominal t_n = tm / (1 − m_t) for a minus mill tolerance m_t (default
none: the param is required, AF-31). Selection: lightest schedule of the spec's dimensional standard at that NPS with
wall ≥ t_n, ties broken by numbered schedule first, then STD/XS/XXS. All of S, E, W, Y, c are inputs (no allowable
table shipped); result `reviewRequired: true`, `provenance: { formula: "B31.3 eq. 3a", inputs }`. Worked check:
VC-PSC-11 (3.5205 → 7.452 mm → Sch 80).

### 5.8 Component shapes (TR-PSC-16, V1)

Analytic recipes in the component's local frame, ports at the ends: elbow = torus segment of bend radius R (LR: 1.5 × NPS, SR: 1.0 × NPS; for 90° R = A) and sweep θ, with straight
end lengths A − R·tan(θ/2) when the tabulated centre-to-end is rounded (45° LR NPS 4: B 63.5 vs R·tan 22.5° = 63.13 mm), minus inner torus; tee = run cylinder ∪ branch cylinder of
length C; reducer = frustum of length H; flange = disc (OD, thickness) + hub + raised face + n holes on the bolt circle;
gasket = annulus; valve = envelope box of face-to-face × flange OD (detailed bodies in 09 VIS). Analytic bounds are
returned with the recipe (VC-PSC-19: 312.75 / 312.75 / 168.3 mm for LR 90 NPS 6).

## 6. Interop and persistence

| Format                                                                | Direction                           | Content                                                                                                                                                                           | Phase                  |
| --------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `llull-piping-catalog` JSON (`schemaVersion` 1)                       | import / export                     | families, sizes, dims with unit + provenance, licence                                                                                                                             | MVP                    |
| `llull-pipe-spec` JSON (`schemaVersion` 1)                            | import / export                     | §3 `PipeSpec`; numbers in mm / bar / °C unless `{ value, unit }`                                                                                                                  | MVP                    |
| Spec sheet CSV                                                        | export                              | one row per (component, size range): type, short code, sizes, ends, class / facing, schedule, catalogue, commodity code, verified; branch table as a second CSV                   | MVP                    |
| Catalogue CSV                                                         | export                              | one row per size                                                                                                                                                                  | MVP                    |
| Plant 3D spec export (CSV / XLSX from Spec Editor)                    | import                              | mapped to `llull-pipe-spec`; unmapped columns kept in `extra`                                                                                                                     | V2                     |
| Plant 3D `.pspx` (ZIP: header + branch table) / `.pspc` (SQLite) [P3] | import (read-only)                  | only if the schema is confirmed; otherwise not supported                                                                                                                          | V2                     |
| PCF component identifiers (SKEYs)                                     | mapping table spec component → SKEY | used by 05 ISO                                                                                                                                                                    | V1 (owned with 05 ISO) |
| IFC 4.3                                                               | export                              | `IfcPipeSegment` / `IfcPipeFitting` / `IfcValve` with `Pset_PipeSegmentTypeCommon` (NominalDiameter, OuterDiameter, InnerDiameter), class / schedule in a `Pset_llull_PipingSpec` | owned by 08 DAT        |

Persistence: the `piping` slice is part of the document JSON; documents with no piping data omit it. Canonical
form (sorted keys, numbers as shortest round-trip decimal) is used for export and for sha256 (VC-PSC-17).

## 7. Surfaces and error codes

- **CLI**: every command via `llull <command> key=value … --json`; `--param-file spec=FILE.json` (TR-PSC-14) inlines a
  JSON file into an object param (generic CLI feature, no piping special case: AF-01); `--save` for exports.
- **MCP**: toolset `piping`; prompt section (AF-03) with NPS/DN, schedules, units, minimal plan.
- **UI**: read-only catalogue browser, spec grid, branch-table grid, check list; Approve button → signature flow (09 PLM).
- **Guide** (`llull guide`): "Piping specs" section: pick or import a spec, resolve, route (02 RTE), check.

| Code                              | Raised by                      | Meaning                                                                                                                   | Remediation                                                                      |
| --------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `PSC_CATALOG_INVALID`             | import_piping_catalog          | file structure wrong; `paths` = JSON paths                                                                                | Fix the file at the listed paths (format llull-piping-catalog, schemaVersion 1). |
| `PSC_CATALOG_CONFLICT`            | import_piping_catalog          | catalogue id exists with different content                                                                                | Pass replace: true or change the catalogue id.                                   |
| `PSC_CATALOG_UNKNOWN`             | lookup, resolve                | catalogue id not in document or bundled                                                                                   | Call list_piping_catalogs.                                                       |
| `PSC_CATALOG_ROW_MISSING`         | lookup, resolve, check         | no row for the size / schedule / class                                                                                    | Import a catalogue that has the size, or change the spec's catalogRef.           |
| `PSC_CATALOG_FAMILY_MISSING`      | resolve (warn)                 | no searched catalogue has a family for the spec `catalogRef` (import-only standard); the selection is returned unverified | Import a catalogue that holds the standard, or accept the unverified selection.  |
| `PSC_RATING_TABLE_UNKNOWN`        | check_pipe_spec (not_run)      | no bundled rating table for the spec rating basis (PN-rated, class-less, other group); design pressure not checked        | Import a rating table, or check the pressure by other means.                     |
| `PSC_CATALOG_DIM_MISMATCH`        | check_piping_catalog           | a dimension breaks a standard rule (`rule`, expected, found)                                                              | Correct the value or remove the rule claim (standard) from the family.           |
| `PSC_PROVENANCE_MISSING`          | import\_\*                     | a value has no citation / sourceId                                                                                        | Add provenance.citation or sourceId to the value.                                |
| `PSC_UNIT_INVALID`                | import\_\*, params             | unknown or wrong-dimension unit                                                                                           | Use mm, in, bar, psi, MPa, °C, °F.                                               |
| `PSC_LICENCE_EMBED_FORBIDDEN`     | import\_\*                     | licensed-no-redistribution data into the document                                                                         | Store it as a private library (ctx.libraries) and reference it.                  |
| `PSC_LIBRARY_UNRESOLVED`          | any read                       | a referenced private library is not on this machine                                                                       | Install the library file or ask its owner.                                       |
| `PSC_SPEC_INVALID`                | import / edit                  | spec structure or op invalid; `paths`                                                                                     | Fix the spec at the listed paths.                                                |
| `PSC_SPEC_UNKNOWN`                | spec commands                  | no such spec id                                                                                                           | Call list_pipe_specs or import_pipe_spec.                                        |
| `PSC_SPEC_CONFLICT`               | import_pipe_spec               | id exists with different content                                                                                          | Pass replace: true (creates a new revision) or rename.                           |
| `PSC_SPEC_IN_USE`                 | edit_pipe_spec                 | removing a component resolved by existing pipes                                                                           | Reassign those pipes (assign_pipe_spec) or keep the component.                   |
| `PSC_SIZE_OUT_OF_RANGE`           | resolve, add_pipe_run, assign  | size outside spec range                                                                                                   | Use a size in the listed range or another spec.                                  |
| `PSC_SIZE_UNKNOWN`                | lookup, resolve                | NPS / DN not a standard key                                                                                               | Use a listed NPS designation (e.g. "2-1/2") or DN.                               |
| `PSC_SCHEDULE_UNKNOWN`            | lookup                         | schedule not defined for that NPS in that standard                                                                        | Call list_piping_catalogs type=pipe for the schedules at this size.              |
| `PSC_NO_COMPONENT`                | resolve                        | no component of that type covers the size                                                                                 | Add one with edit_pipe_spec, or use a type listed in the message.                |
| `PSC_AMBIGUOUS_COMPONENT`         | resolve, check                 | two equal-priority components match                                                                                       | Set different priorities or narrow the ranges.                                   |
| `PSC_BRANCH_UNDEFINED`            | resolve_branch, check          | empty branch-table cell                                                                                                   | Fill the cell with edit_pipe_spec setBranchCell.                                 |
| `PSC_PT_RATING_EXCEEDED`          | check_pipe_spec                | design pressure above rating at design temperature                                                                        | Use a higher-class spec; a qualified engineer must decide.                       |
| `PSC_PT_TEMPERATURE_OUT_OF_TABLE` | pt_rating, check               | temperature outside the rating table                                                                                      | Import a rating table that covers it or change the material group.               |
| `PSC_TEMPERATURE_LIMIT`           | check_pipe_spec                | design temperature outside spec limits                                                                                    | Choose a spec whose limits cover it.                                             |
| `PSC_WALL_INSUFFICIENT`           | pipe_wall_check                | schedule wall below the required nominal                                                                                  | Use the selected schedule in data, or a heavier one.                             |
| `PSC_WALL_THICK_PIPE`             | pipe_wall_check                | t ≥ D/6 (eq. 3a not valid)                                                                                                | Thick-wall design is out of scope: needs a qualified engineer.                   |
| `PSC_ALLOWABLE_MISSING`           | pipe_wall_check                | S (or E, W, Y, c, mill tolerance) not given                                                                               | Give allowableStress and the factors explicitly (AF-31).                         |
| `PSC_DIM_STANDARD_MIXED`          | check_pipe_spec                | EN and ASME end diameters differ > 1.0 mm in one spec                                                                     | Use fittings of the spec's dimensional standard.                                 |
| `PSC_DIM_STANDARD_ROUNDING`       | check_pipe_spec (warn)         | EN/ASME ODs differ 0.1–1.0 mm                                                                                             | Confirm with the fitting vendor.                                                 |
| `PSC_END_INCOMPATIBLE`            | check_pipe_spec, resolve_joint | ends / class / facing do not mate                                                                                         | Add a transition component or align class / facing.                              |
| `PSC_COVERAGE_GAP`                | check_pipe_spec (warn)         | size without pipe or required fitting                                                                                     | Add components for the listed sizes.                                             |
| `PSC_DATA_UNVERIFIED`             | any result (warn)              | a value used is not grade A                                                                                               | Have a qualified engineer confirm it, or import a verified catalogue.            |
| `PSC_SPEC_NOT_APPROVED`           | check_pipe_spec (warn)         | spec status draft / superseded                                                                                            | A qualified reviewer approves it (approve_pipe_spec).                            |
| `PSC_SPEC_REVISION_STALE`         | check_pipe_spec (warn)         | pipe resolved against an older revision                                                                                   | Re-run assign_pipe_spec or accept knowingly.                                     |
| `PSC_PIPE_NO_SPEC`                | check_pipe_spec (warn)         | legacy pipe without spec                                                                                                  | assign_pipe_spec.                                                                |
| `PSC_PIPE_SPEC_MISMATCH`          | check_pipe_spec                | pipe OD differs from its spec row                                                                                         | Re-run assign_pipe_spec.                                                         |
| `PSC_SPEC_CHECK_FAILED`           | approve_pipe_spec              | spec has fail items                                                                                                       | Fix the fail items first.                                                        |
| `PSC_HUMAN_GATE`                  | approve_pipe_spec              | no verified human signature                                                                                               | A qualified reviewer signs (09 PLM record_signature).                            |

## 8. Performance and robustness budgets

| Operation                                               | Budget                                                                                                                                                                            | Note                |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| bundled catalogue index build                           | < 20 ms, once per process                                                                                                                                                         | memoised by version |
| `lookup_piping_component`                               | < 0.2 ms median                                                                                                                                                                   | map lookups         |
| `resolve_spec_component` (200-component spec)           | < 1 ms median, < 5 ms p99                                                                                                                                                         | linear filter       |
| `check_pipe_spec` scope spec                            | < 50 ms                                                                                                                                                                           | ~ sizes × types     |
| `check_pipe_spec` scope document, 1 000 pipes, 30 specs | < 500 ms                                                                                                                                                                          |                     |
| catalogue import 10 000 rows                            | < 1 s, < 50 MB                                                                                                                                                                    | zod + rule pass     |
| document size per spec                                  | < 100 kB JSON                                                                                                                                                                     |                     |
| Robustness                                              | NaN / negative dims refused at import (`PSC_CATALOG_INVALID`); NPS keys exact (no float equality); interpolation only inside the table; all outputs finite or the command refuses |                     |

## 9. Test strategy

| Level                           | Location                                                                                            | Covers                                                                                                               | VCs                               |
| ------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Unit (catalogue)                | `tests/unit/plant/piping/catalogLookup.test.ts`                                                     | every grade-A row of the pack JSON reproduced exactly; derived values flagged; NPS / DN map both ways; Sch 10 vs 10S | VC-01, 03, 04, 06, 12, 13, 14, 18 |
| Unit (properties)               | `sectionProperties.test.ts`                                                                         | closed forms; bridge with `pipeWeightPerMetre`                                                                       | VC-02                             |
| Unit (ratings)                  | `ptRating.test.ts`                                                                                  | tabulated rows, interpolation, out-of-table refusal                                                                  | VC-07                             |
| Unit (import / check catalogue) | `catalogImport.test.ts`                                                                             | provenance refusal, licence refusal, rule failures with paths                                                        | VC-05                             |
| Unit (spec)                     | `specResolve.test.ts`, `checkPipeSpec.test.ts`, `specGovernance.test.ts`, `specPersistence.test.ts` | resolution, branch table, design check, mixed standards, unverified propagation, human gate, round trip              | VC-08, 09, 10, 14, 16, 17         |
| Unit (wall)                     | `wallCheck.test.ts`                                                                                 | eq. 3a, schedule pick, refusals                                                                                      | VC-11                             |
| Unit (shape)                    | `componentShape.test.ts`                                                                            | analytic bounds; mesh within 0.5 %; OCC exact (desktop CI lane)                                                      | VC-19                             |
| Integration                     | `tests/unit/plant/piping/specPipeRun.test.ts`                                                       | `add_pipe_run` with spec, legacy unchanged, consumers (hydraulics, supports, line loads) read `spec.wallMm`          | VC-15                             |
| Scenario plans                  | `tests/unit/plant/scenarioPlans.test.ts`                                                            | runs `validation/plans/*.json` via `build_project`, compares `expected` rows                                         | all                               |
| Purity / contract               | standard `is pure` tests per command; `toToolSchemas()` snapshot updated once                       | —                                                                                                                    | —                                 |
| Golden                          | `tests/golden/plant-psc-cs150.json`                                                                 | spec import + resolutions, id-normalised snapshot + replay equality                                                  | VC-17                             |
| Production gate                 | agent driver runs SC-PSC-01..05 with `--json` and exit codes only                                   | AF-23                                                                                                                | all                               |

Every test reads its expected values from `docs/plant/01-piping-specs-catalog/validation/` (no copies), so the pack and
the tests cannot drift. Coverage gate 90/85/90/90 applies to `packages/domain-aec/src/plant/**`.

## 10. Delivery plan

| Milestone | Content                                                                                                                                                                                 | Depends on           | Effort |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------ |
| M0        | core types `model/piping.ts`, `PipeElement.spec`, plugin skeleton, codes, NPS/DN map                                                                                                    | —                    | 2 d    |
| M1        | bundled open catalogue (generator + data modules), `list/lookup/import/export/check_piping_catalog`, `pipe_section_properties`, `pt_rating`                                             | M0                   | 5 d    |
| M2        | spec model, `import/create/edit/list/export_pipe_spec`, `resolve_spec_component`, `resolve_branch`, `check_pipe_spec`                                                                   | M1                   | 6 d    |
| M3        | `add_pipe_run` / `assign_pipe_spec` integration, consumers read `spec.wallMm`, `approve_pipe_spec` human gate (09 PLM signature port)                                                   | M2, 09 PLM signature | 3 d    |
| M4 (V1)   | `pipe_wall_check`, `resolve_joint` (bolt sets, stud length), `component_shape`, `diff_pipe_spec`, CSV sheet, B16.11 / B16.47 / EN 10253 / olet family schemas, PCF SKEY map with 05 ISO | M3, 02 RTE ports     | 8 d    |
| M5 (V2)   | Plant 3D CSV import, `.pspc` read if feasible, further rating tables                                                                                                                    | M4                   | 5 d    |

Total MVP (M0–M3) ≈ 16 engineer-days; V1 + 8; V2 + 5. Sibling dependencies: 02 RTE consumes M2 (`resolve_*`) and
M4 (`component_shape`, ports); 05 ISO consumes commodity codes and SKEY map; 07 PST consumes section properties (M1);
08 DAT consumes spec ids and commodity codes; 09 VIS consumes shapes and spec colour keys.

## 11. Open questions / decisions needed

1. **Bundling policy**: may llull ship the grade-A / grade-B dimension rows (values from MIT / LGPL packages and public
   tables) as the default catalogue, or must every standard table come from user import? Proposal: ship, flagged per
   row, licence `public-domain`-like "open transcription" with sources; owner decision.
2. **Core type and slice placement**: `model/piping.ts` in core (proposed, lets `PipeElement` reference `SpecBinding`)
   vs. keeping all types in the plugin; and whether specs live in their own `piping` slice or in the shared
   `doc.plant.specs` proposed by 02 RTE (§3.1 there). PSC prefers the shared `doc.plant` slice once 02 RTE lands.
3. **Spec ownership of joints**: bolt-set stud length rules (B16.5 bolting tables vs computed from flange thickness,
   gasket, nut height) — computed with a named rule, or table-only import?
4. **Revision semantics**: does approving revision n+1 auto-mark pipes on revision n as stale (warn), or require an
   explicit `assign_pipe_spec` sweep command?
5. **ASME vs EN default** for documents in metric units: dimensional standard of the default spec templates (none
   shipped in MVP).
6. **Coordinate with 02 RTE**: does routing store fittings as separate elements (proposed) or as attributes of the
   pipe element's vertices? The `SpecBinding` and resolution API work for both.
7. **B16.11 / olet data**: no open source found; is a company-supplied catalogue available for the owner's projects?

Decided 2026-10-23 (owner delegated, plant README D4):

- **Q1 bundling: ship.** `llull-open-piping` holds the grade-A and grade-B rows with source ids; grade < A is `unverified`
  (`PSC_DATA_UNVERIFIED`, never suppressible). Licence flag `open-data` added to `LICENCE_FLAGS` (facts compiled from
  open-licensed and public sources, redistributable); the provisional `company-proprietary` is replaced.
- **Q3 stud length: computed by a named rule** (2 × flange thickness + gasket + 2 nut heights + 2 thread projections, rounded
  up to the bolting increment), flagged `derived` with the formula; an imported bolting table overrides it.
- **Q4 revisions: both.** Approving revision n+1 flags pipes on n with a warning; `assign_pipe_spec` (M3) is the sweep.
- **Q5 no default dimensional standard.** A spec names its standard explicitly (AF-31: safety data is never defaulted).
- **Q6 (02 §11.2) derived fittings**, deterministic joint ids; overrides in V1.
- **Q7: import-only** (README D9).

## 12. References

- [S1]–[S27], [P1]–[P10]: [`validation/sources.md`](validation/sources.md) (URLs, sha256, licences; accessed 2026-10).
- [R1] ASME B36.10M, Welded and Seamless Wrought Steel Pipe — ASME — catalogue: https://infostore.saiglobal.com/en-us/Standards/ASME-B36-10M-2015-138313_SAIG_ASME_ASME_296523/ (accessed 2026-10)
- [R2] ASME B36.19M-2018, Stainless Steel Pipe — ASME — https://store.sfs.fi/en/asme-b3619m-2018 (accessed 2026-10)
- [R3] EN 10220, Seamless and welded steel tubes — dimensions and masses per unit length — CEN — https://standards.globalspec.com/std/412167/en-10220 (accessed 2026-10)
- [R4] ASME B16.10, Face-to-Face and End-to-End Dimensions of Valves — ASME — https://standards.globalspec.com/std/10148558/asme-b16-10 (accessed 2026-10)
- [R5] ASME B16.5 / B16.9 / B16.20 / B16.47 / B16.11 / B31.3 and EN 1092-1 / EN 10253: paywalled; only public facts
  quoted via [S4]–[S24]; scopes per Wikipedia "Flange" (https://en.wikipedia.org/wiki/Flange) and the cited vendor pages.
- [R6] Autodesk AutoCAD Plant 3D Spec Editor help, "About Branch Tables" — https://help.autodesk.com/cloudhelp/2026/ENU/Plant3D-SpecEditor/files/GUID-7F6BEC75-9909-47D5-8BB3-67B956E22604.htm (accessed 2026-10)
- [R7] Arkance, "PSPX and PSPC files in Plant 3D" — https://ukcommunity.arkance.world/hc/en-us/articles/21549455355026-PSPX-and-a-PSPC-Files-in-Plant-3D (accessed 2026-10)
- [R8] AVEVA E3D 2.1 Catalogues and Specifications Reference Manual — https://help.aveva.com/AVEVA_Everything3D/2.1/CSRM/CSRM13.14.03.html (accessed 2026-10)
- [R9] Hexagon Smart 3D, Interpreting Human Piping Specifications — https://docs.hexagonppm.com/r/en-US/Intergraph-Smart-3D-Interpreting-Human-Piping-Specifications/14/51847 (accessed 2026-10)
- [R10] C. Bell, `fluids` 1.3.1 (MIT) — https://pypi.org/project/fluids/1.3.1/ (accessed 2026-10)
- [R11] iyulab, `formulab` 0.72.3 (MIT) — https://www.npmjs.com/package/formulab (accessed 2026-10)
- [R12] oddtopus, dodo FreeCAD piping workbench (LGPL-3.0) — https://github.com/oddtopus/dodo (raw files accessed 2026-10)
- Sibling packs: [`../02-spec-driven-routing/`](../02-spec-driven-routing/), [`../05-isometrics-fabrication/`](../05-isometrics-fabrication/),
  [`../07-pipe-stress-flexibility/`](../07-pipe-stress-flexibility/), [`../08-plant-data-reports-interop/`](../08-plant-data-reports-interop/),
  [`../09-plant-visualization-review/`](../09-plant-visualization-review/).

## Appendix A — Requirement traceability

| TR        | Requirement                                                                           | FR           | AF                  | VC                |
| --------- | ------------------------------------------------------------------------------------- | ------------ | ------------------- | ----------------- |
| TR-PSC-01 | NPS / DN keys, exact rational compare, fixed DN↔NPS map                               | FR-01, FR-06 | AF-04               | VC-01, VC-15      |
| TR-PSC-02 | Bundled open catalogue generated from the pack JSON, drift test                       | FR-01, FR-02 | AF-30, AF-41        | VC-01             |
| TR-PSC-03 | Pipe rows keyed by (standard, NPS, schedule); 10 ≠ 10S                                | FR-01        | AF-30               | VC-18             |
| TR-PSC-04 | Fitting / flange / gasket / valve lookup with derived values flagged                  | FR-02        | AF-10, AF-35        | VC-03, 06, 12, 13 |
| TR-PSC-05 | Catalogue file schema, provenance and licence enforcement                             | FR-03        | AF-11, AF-30        | VC-05             |
| TR-PSC-06 | Resolution and branch algorithms (§5.5)                                               | FR-07, FR-08 | AF-10, AF-11, AF-13 | VC-08, VC-09      |
| TR-PSC-07 | P-T tables and interpolation (§5.4)                                                   | FR-05        | AF-31, AF-35        | VC-07             |
| TR-PSC-08 | B31.3 eq. 3a and schedule selection (§5.7)                                            | FR-10        | AF-31, AF-33        | VC-11             |
| TR-PSC-09 | Section properties, bridge with `pipeWeightPerMetre` (§5.3)                           | FR-04        | AF-35               | VC-02             |
| TR-PSC-10 | `check_pipe_spec` passes 1–9 (§5.6)                                                   | FR-09        | AF-20, AF-21        | VC-10, VC-16      |
| TR-PSC-11 | Dimensional-standard and joint compatibility rules                                    | FR-11        | AF-30               | VC-14             |
| TR-PSC-12 | `PipeElement.spec`, `add_pipe_run` / `assign_pipe_spec`, consumers read `spec.wallMm` | FR-13        | AF-01               | VC-15             |
| TR-PSC-13 | `check_piping_catalog` rules (§5.6)                                                   | FR-12        | AF-20, AF-30        | VC-05             |
| TR-PSC-14 | Canonical JSON, sha256, `--param-file` CLI feature, round trip                        | FR-16, FR-17 | AF-05, AF-12, AF-13 | VC-17             |
| TR-PSC-15 | Lifecycle, revisions, approval gate via signature                                     | FR-14, FR-15 | AF-32, AF-33, AF-34 | VC-16             |
| TR-PSC-16 | Component shape recipes and ports (§5.8)                                              | FR-19        | AF-22               | VC-19             |

## 13. As built (M0 + M1, 2026-10-23)

Branch `feat/plant-psc-m1`. Plugin `piping-catalog` (toolset `piping`), folder `packages/domain-aec/src/plant/catalog/`, installed by
`src/app/plugins.ts` after the 02 RTE plugin `piping` (that plugin keeps the name `piping`; this one is `piping-catalog`, so the §2 name
"plugin `piping`" is superseded). Toolset `piping` lists both plugins' tools.

### 13.1 Decisions taken

| Question                                 | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1 bundling (provisional, pending owner) | The grade A and B rows of `validation/data/*.json` ship as the default catalogue `llull-open-piping` 1.0.0, each value with `sourceId` + citation and `verified` = grade A. Anything not grade A is reported `unverified` (`PSC_DATA_UNVERIFIED`, never suppressible). Standards without a free source (B16.11, MSS SP-97 olets, EN 10253, B16.47, B16.9 caps and reducing tees) are import-only (D9): `list_piping_catalogs` names them in `importOnly`. |
| Q2 types and slice                       | Types live in the plugin (`plant/catalog/types.ts`), not in core (D2, step 5B1). Imported catalogues are stored in `doc.plant.catalog` (`{ catalogs, catalogOrder }`, one optional member added to `plant/types.ts`); the bundled catalogue and the B16.5 rating table live in code and are never written to the document.                                                                                                                                |
| `PipeElement.spec`                       | Added as `spec?: SpecBinding` on `PipeElement` (`building/types.ts`); `SpecBinding` is `{ specId, revision, nps, schedule?, odMm, wallMm, dimensionalStandard, verified }`. Nothing writes it before M3; `pipe_section_properties` already reads it. Old documents load unchanged.                                                                                                                                                                        |
| Command names                            | As §4: `list_piping_catalogs`, `lookup_piping_component` (plural / component, not "lookup_piping_catalog").                                                                                                                                                                                                                                                                                                                                               |
| Units                                    | Stored values are millimetres, counts or bar; a file declares `unit: mm \| in` per family (inches converted on import, rounded to 1e-6). `Dim.unit` is `mm \| count \| bar` (§3 sketched `mm \| in`). Bolt diameter is stored in mm and answered also as an inch fraction (`boltDiameterIn: "5/8"`).                                                                                                                                                      |
| Dimension names                          | `outsideDiameter`, `wall`, `centreToEnd`, `centreToEndRun` (tee run), `length` (reducer), `thickness`, `boltCircle`, `boltCount`, `boltDiameter`, `boltHole` (EN: hole diameter, B16.5: derived), `raisedFaceDiameter`, `faceToFace`, `innerRingId`, `sealingElementOd`, `centeringRingOd`. Answers add flat keys `<dim>Mm` (the keys the plans read).                                                                                                    |
| Row grade                                | `verified` per value; a row is verified when all its values are. B16.5 flange: thickness follows `gradeThickness`, bolt count / diameter `gradeBoltPattern`, OD / bolt circle / raised face `gradeOdBoltCircle` (so only NPS 4 Class 150 is a verified row). EN 1092-1: D, K verified for DN100 PN16 only; holes and counts never.                                                                                                                        |
| Derived values                           | Computed in the lookup, flagged `derived` with the formula: pipe inside diameter, B16.5 bolt hole (bolt + 3.175 mm), missing B16.9 LR 90 / SR 90 centre-to-end (1.5 / 1.0 x NPS, LR verified = grade A rule, SR unverified).                                                                                                                                                                                                                              |
| Pipe schedules                           | One family per standard (`asme-b36.10m`, `asme-b36.19m`); `"10"` and `"10S"` are different rows; a schedule given without `standard` resolves in the first family that has it and the answer carries a `note` naming the standard. A pipe lookup without schedule is `PSC_AMBIGUOUS_COMPONENT` (the message lists the schedules).                                                                                                                         |
| Ratings                                  | `pt_rating` answers bar; `unit: psi` returns the tabulated psig (285 / 740) at or below 100 degF and otherwise converts at 0.0689475729 bar/psi, stating it (`method`, `conversion`). Only B16.5 group 1.1 is bundled; a rating-table import command is not part of M1.                                                                                                                                                                                   |
| Export gate                              | `export_piping_catalog` is an `export_*` command, so it carries `confirmExportControlled` and the export gate (contract test `exportGateAll`).                                                                                                                                                                                                                                                                                                            |
| Licence flag                             | Decided D4 (2026-10-23): `LICENCE_FLAGS` has `open-data`; the bundled catalogue uses it (M2 replaced the provisional `company-proprietary`, see §13.5).                                                                                                                                                                                                                                                                                                   |

### 13.2 What exists

| Item                                                           | Where                                                                                                                                                                      |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Types, `SpecBinding`, slice                                    | `plant/catalog/types.ts`, `plant/catalog/store.ts`, `plant/catalog/document.ts` (load validation)                                                                          |
| NPS / DN map (exact rationals, ISO 6708 pairing, EN 10220 ODs) | `plant/catalog/nominal.ts`                                                                                                                                                 |
| Error codes + remediation (all §7 codes)                       | `plant/catalog/codes.ts`                                                                                                                                                   |
| Bundled catalogue + generator + drift test                     | `plant/catalog/bundled.ts`, `plant/catalog/data/*.ts` (generated), `scripts/pipingCatalogGen.ts`, `npm run piping-catalog`, `tests/unit/plant/piping/catalogDrift.test.ts` |
| File form, parse, canonical export                             | `plant/catalog/file.ts`                                                                                                                                                    |
| Lookup, rules, ratings, section properties                     | `lookup.ts`, `rules.ts`, `ptRating.ts`, `sectionProperties.ts`                                                                                                             |
| Commands                                                       | `plant/catalog/commands/{queries,importExport,check,engineering}.ts`                                                                                                       |

Commands (all in toolset `piping`): `list_piping_catalogs` (Q), `lookup_piping_component` (Q), `import_piping_catalog` (M),
`export_piping_catalog` (Q, export gate), `check_piping_catalog` (Q; rules `b169.lr90`, `b169.sr90`, `b165.hole`, `pipe.odMatch`,
`monotonic`, `provenance`, `verified`), `pipe_section_properties` (Q), `pt_rating` (Q).

### 13.3 Validation cases

Covered by `tests/unit/plant/piping/{catalogLookup,sectionProperties,ptRating,catalogImport,catalogDrift,scenarioPlans}.test.ts`, reading the
pack data directly: VC-PSC-01 (all 382 rows, 86 grade A), 02 (incl. bridge to `pipeWeightPerMetre`), 03, 04, 05 (import refusal + check
failure at `families.0.sizes.0.centreToEnd`), 06 (all 24 bolt patterns), 07, 12, 13, 14 (EN flange part), 17 (catalogue round trip, sha256), 18. Plans: SC-PSC-01 fully, SC-PSC-05 steps 0 to 4, SC-PSC-03 step 1 to 3 (the harness skips steps whose command is not registered).

### 13.4 Left after M1 (M2 is built: see §13.5, which lists what is still open)

M2 (specs, resolution, branch table, `check_pipe_spec`, `PSC_DIM_STANDARD_MIXED`), M3 (`add_pipe_run` / `assign_pipe_spec`, consumers read
`spec.wallMm`, `approve_pipe_spec`; the interim `plant/piping/sizes.ts` and `industrial/piping/pipeSizes.ts` stay until then), M4 (`pipe_wall_check`,
`resolve_joint`, `component_shape`, bolt sets, B16.11 and olet schemas), rating-table import, EN 10220 walls (the pack has ODs only),
`PipingLibraryProvider` private libraries (`PSC_LIBRARY_UNRESOLVED` is defined, not yet raised), `--param-file` CLI feature, UI browser, guide
section, VC-PSC-08 to 11, 14 (spec check), 15, 16, 19. Open for the owner: Q1 (bundling policy, licence flag), Q3 to Q7 unchanged.

### 13.5 As built (M2, 2026-10-23)

Branch `feat/plant-psc-m2`. Same plugin `piping-catalog` (toolset `piping`); folder `packages/domain-aec/src/plant/spec/`.

#### Decisions taken

| Question             | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D4 licence flag      | `'open-data'` added to core `LICENCE_FLAGS` (`model/materialLibrary.ts`). Only `licensed-no-redistribution` is restricted by any consumer (embed refusal, redaction, private libraries), so the new flag behaves as redistributable with no other change; the material-record UI label and the `define_material_record` description name it. `llull-open-piping` is now `open-data`. Grade < A stays `unverified` (`PSC_DATA_UNVERIFIED`, never suppressible).                                                                          |
| Slice                | `PlantModel.spec?: SpecModel` (`plant/types.ts`): `{ specs: Record<id, PipeSpec[]>` (every revision, oldest first)`, specOrder }`. Types in the plugin (`plant/spec/types.ts`), validated on load by `plant/spec/document.ts` through the plugin's one `DocumentExtension`. Nothing in core except the licence flag.                                                                                                                                                                                                                    |
| Dimensional standard | No default anywhere: `create_pipe_spec` and the file schema require `dimensionalStandard`, rating, corrosion allowance, size range and catalogues. Corrosion allowance is stored in mm (`in` converted on import).                                                                                                                                                                                                                                                                                                                      |
| Status / approval    | `status` (draft, approved, superseded) and `approval` exist in the model; every import and edit stores a **draft** (a file saying `approved` is stored as draft and the data says `statusForcedToDraft`). Editing an approved or superseded latest revision appends a new draft revision. `approve_pipe_spec`, `assign_pipe_spec` and the revision-stale sweep are M3.                                                                                                                                                                  |
| Stud length          | Bolt sets and `resolve_joint` are M4 (§10), so the named stud-length rule (2 x flange thickness + gasket + 2 nut heights + 2 thread projections, rounded up to the bolting increment, `derived` with the formula, an imported table overrides) is **not built** in M2. A spec `boltSet` component resolves unverified (no bolting family in the bundled catalogue) until one is imported.                                                                                                                                               |
| Sizes                | A spec range, component range or query is NPS or DN; both reduce to one ordinal (NPS value, or DN / 25 without a pairing) so a DN spec resolves NPS queries and vice versa. Branch-table keys use the system of the spec size range.                                                                                                                                                                                                                                                                                                    |
| `catalogRef`         | Alias of a catalogue family: the family id equals it or starts with it followed by `-`, or its standard equals it, ignoring case and punctuation (`asme-b16.9`, `asme-b36.10m`, `asme-b16.20`). No family in any searched catalogue (B16.11, MSS SP-97, bolting, EN 10253): the component is still selected, `verified: false`, with warnings `PSC_DATA_UNVERIFIED` + `PSC_CATALOG_FAMILY_MISSING` (VC-PSC-08 NPS 1 case; deviates from §5.5, which refuses). A family that exists but lacks the row refuses `PSC_CATALOG_ROW_MISSING`. |
| Schedule and wall    | A fitting with `scheduleFromPipe` does not pass the schedule to its own row (B16.9 centre-to-end has none) and takes schedule and wall from the spec pipe at that size. An EN 10220 pipe with no catalogue family (`catalogRef` or `standard` names EN 10220) gets its OD from the EN series (grade A to DN125) and its wall from the component `wallMm` (unverified).                                                                                                                                                                  |
| `check_pipe_spec`    | A row missing where the catalogue is partial is a **warn** (`PSC_CATALOG_ROW_MISSING`), not the fail of §5.6 pass 3: the bundled catalogue is partial by design (D9) and VC-PSC-10 requires the CS150-A1 check to be `warn`. A searched catalogue that does not exist is a fail (`PSC_CATALOG_UNKNOWN`). A design check with no usable rating table is `not_run` (`PSC_RATING_TABLE_UNKNOWN`), never a pass. Without `specId`, `scope: document` checks every spec.                                                                     |
| Mixed standards      | Fitting end OD (its family standard, or its `catalogRef` when unresolved) against the spec pipe OD at each size: > 1.0 mm fail `PSC_DIM_STANDARD_MIXED`, 0.1 to 1.0 mm warn `PSC_DIM_STANDARD_ROUNDING`; one finding per component with the worst delta.                                                                                                                                                                                                                                                                                |
| Export               | `export_pipe_spec` is an `export_*` command, so it carries the export gate (`confirmExportControlled`) like `export_piping_catalog`.                                                                                                                                                                                                                                                                                                                                                                                                    |

#### What exists

| Item                              | Where                                                                                                                                                            |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Types, store, size ordinals       | `plant/spec/{types,store,size}.ts`                                                                                                                               |
| File form (zod), canonical, edits | `plant/spec/{file,edit}.ts`                                                                                                                                      |
| Resolution (pure, for 02 RTE)     | `plant/spec/resolve.ts`: `resolveComponent`, `resolveBranch`, `resolveChosen`; `plant/spec/store.ts`: `findSpec`, `latestSpec`, `latestApproved`, `specCatalogs` |
| Checks                            | `plant/spec/checks/{rows,structure,compat,design,document,finding,run}.ts`                                                                                       |
| Commands                          | `plant/spec/commands/{author,queries,check,export,answer}.ts`                                                                                                    |

Commands (toolset `piping`): `import_pipe_spec` (M), `create_pipe_spec` (M), `edit_pipe_spec` (M; ops addComponent, updateComponent, removeComponent, setSizeRange, setBranchCell, clearBranchCell, setHeader), `list_pipe_specs` (Q),
`export_pipe_spec` (Q, export gate; json, or spec-sheet csv + branch csv), `resolve_spec_component` (Q), `resolve_branch` (Q), `check_pipe_spec` (Q; passes coverage, overlap, references, branch, design, dimStandard, joints,
trust, status, and document with `scope: document`). Codes of §7 are all in `catalog/codes.ts`.

Resolution API for 02 RTE (the `SpecLookup` adapter maps DN to NPS through `catalog/nominal.ts`):

```ts
resolveComponent(spec: PipeSpec, catalogs: readonly PipingCatalog[], query: ComponentQuery): ResolveOutcome;
resolveBranch(spec: PipeSpec, catalogs: readonly PipingCatalog[], query: BranchQuery): BranchOutcome;
// ComponentQuery = { type, nps? | dn?, branchNps? | branchDn?, ends?, facing?, radius?, class?, pn? }
// ResolveOutcome = { ok: true; resolved: ResolvedComponent } | { ok: false; code; message; ids; paths }
// ResolvedComponent = { component, size, branchSize?, schedule?, wallMm?, outsideDiameterMm?, row | null, dims, pipe?, verified, unverifiedDims, unresolved? }
```

A caller gets `spec` with `findSpec(doc, id, revision?)` and the catalogues with `specCatalogs(doc, spec)` (`missing` lists unknown references).

#### Validation cases

`tests/unit/plant/piping/{specResolve,checkPipeSpec,specEdit,specPersistence,scenarioPlans}.test.ts`, reading the pack data directly: VC-PSC-08 (the four cases, DN input, priorities, ambiguity), 09 (all five cells, stub-in, DN table),
10 (19.0 bar warn, 19.5 bar fail with rating 19.3667 and margin -0.133, psi / MPa / degF input, temperature limit), 14 (spec part: `PSC_DIM_STANDARD_MIXED` on component E at DN65, rounding warn), 16 (unverified propagates,
`PSC_SPEC_NOT_APPROVED` for a draft; the agent approval refusal is M3), 17 (spec export -> import -> export sha256 identical for CS150-A1, MIX-1 and a small spec; save / load; replay). Plans: SC-PSC-02 fully, SC-PSC-03 up to
`pipe_wall_check`, SC-PSC-05 fully. Not covered, by design: VC-PSC-11 (M4 `pipe_wall_check`), 15 (M3), 19 (M4 `component_shape`), the human-gate half of 16 (M3).

#### Left

M3 (`add_pipe_run` / `assign_pipe_spec`, consumers read `spec.wallMm`, `approve_pipe_spec` + `PSC_HUMAN_GATE`, revision-stale sweep; VC-PSC-15 and the approval half of 16), M4 (`pipe_wall_check`, `resolve_joint` with bolt sets and the
stud-length rule, `component_shape`, `diff_pipe_spec`, B16.11 / B16.47 / EN 10253 / olet schemas), rating-table import (`ratingTableId` is stored, not resolved), EN 10220 walls, `PipingLibraryProvider`, `--param-file`, UI browser,
guide section, spec insulation table (V1), B16.9 45-degree elbow rule row (only NPS 4 and 6 are tabulated, so other sizes report `PSC_CATALOG_ROW_MISSING`).

Review fixes (same milestone): the first import keeps the file revision and load validation accepts any strictly ascending positive revisions; an EN 10220 pipe without `wallMm` reports `wall` unverified (fittings with `scheduleFromPipe` inherit `pipe.wall`); load validation checks each stored component and requires an `approval` block for approved / superseded revisions; branch components are checked at every branch size up to the header; `bytes` counts UTF-8 bytes; `PSC_SPEC_IN_USE` also protects pipes whose binding size is a DN (`SpecBinding` has only `nps: string`, read as NPS first, then DN).
