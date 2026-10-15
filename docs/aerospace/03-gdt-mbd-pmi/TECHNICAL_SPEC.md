# GDT — GD&T, MBD and semantic PMI — Technical specification

Gap id: **GDT** · Companion of `FUNCTIONAL_SPEC.md` · Validation: `validation/README.md` · Date: 2026-10-15

## 1. Current state in llull

| Area | What exists (path) | Limit for GD&T / MBD |
| --- | --- | --- |
| 2D dimensions | `DimensionEntity` (`packages/core/src/model/types.ts`: `dimensionKind` linear/aligned/radial/angular, `entityIds`, `offset`, `precision`, `label`); command `add_dimension` (`packages/core/src/commands/draw2d/annotate.ts`); geometry `packages/core/src/geometry/dimensionGeometry.ts` | references **2D entities** only; no tolerance, no 3D face reference, no semantics |
| Text | `TextEntity`, `add_text` | free text, unattached |
| Drawing sheets | model `packages/core/src/model/sheet.ts` (`DrawingSheet`, `DrawingView` projection/section/detail, recipe-only, derived at export); commands `create_sheet`, `create_drawing_view`, `add_section_view`, `add_detail_view`, `update_drawing_view`, `delete_drawing_view`, `update_sheet`, `delete_sheet`, `export_sheet_svg` (`packages/core/src/commands/drawings/*`, catalog `drawings/catalog.ts`, registered in `commands/registry.ts`); hidden-line views `geometry/technicalView.ts`, `drawings/viewDrawing.ts` (`deriveView`, `cuttingLine`), painter `drawings/svgPainter.ts`, layout `drawings/layout.ts`; persistence check `commands/persistence/drawingsValidation.ts` | only `showDimensions` (overall width/height of each projection view); no annotation layer, no title-block tolerance note |
| Exact topology | `GeometryKernel.topology()` → `ShapeTopology { faces: ShapeFace{index, surface, area}[], edges: ShapeEdge{index, curve, length, start, end, mid, samples?, seam, degenerate}[] }` (`packages/core/src/geometry/kernel.ts`); OCC impl `packages/kernel-occt/src/occtTopology.ts` (explorer-order unique faces, `GeomAbs_SurfaceType`, `BRepGProp` area); query `inspect_topology` (`commands/brep/topology.ts`) | faces carry **no location** (no centroid, normal, axis, radius, sample points) → a face cannot be re-found by a point, unlike edges (`edgesNear`, KI5); gap 01 specifies a single optional kernel face-query port that supplies them (TR-GDT-03) |
| Topological naming | `fillet_edge` / `chamfer_edge` accept `edgesNear` points re-resolved at replay (`commands/brep/modify3d.ts`, KI5) | pattern to reuse for faces |
| STEP | `export_step_exact` (AP214 B-rep from OCC, `packages/kernel-occt/src/occtStep.ts`, `STEPControl_Writer`); exchange tools `export_step` / `import_step` (`packages/mcp/src/exchangeTools.ts` → `CadExchangePort` → `server/python/llull_bridge.py` with CadQuery/OCP); **import tessellates** STEP into `import_mesh` (names + colours kept) | no AP242, no XCAF GD&T read/write; imported solids are meshes (no B-rep faces to attach PMI to) |
| Measurement | `measure_distance`, `measure_angle`, `measure_bounding_box`, `mass_properties`, `check_model` (`commands/inspect/*`) | nominal only |
| Materials | `Material.density` etc. | irrelevant to PMI except notes |
| Kernel in browser | `opencascade.js ^1.1.1` (`packages/kernel-occt/package.json`) | XCAF GD&T bindings not verified (open question Q-1) |
| Desktop | Electron + bundled CPython + CadQuery (OCP) (KI6) | OCP is meant to wrap all OCCT modules [R32] → XCAF available in Python |

Conclusion: nothing tolerancing-related exists; the drawings feature, the B-rep topology query and the
KI5 point-based re-resolution are the three foundations this gap builds on.

## 2. Target architecture

### 2.1 Layer placement (L2, L10)

GD&T is generic mechanical documentation (like drawings), not a domain → **core feature catalog**.
AP242 PMI exchange needs Python/OCP → **exchange tools** (transport level, like `import_step`), whose
document changes go through a core command.

```
packages/core/src/
  model/pmi.ts                         PmiModel types, constants (characteristics, modifiers)        [model]
  lib/prng.ts                          seeded PRNG (xoshiro128**) + Box–Muller                         [lib, pure]
  lib/stackup.ts                       WC / RSS / exact-corner / MC / uniform-sum CDF math             [lib, pure]
  geometry/pmiFeatures.ts              resolve facesNear → face indices via ctx.kernel.topology        [geometry]
  geometry/pmiPlacement.ts             auto annotation plane + anchor; projection for sheet views      [geometry]
  geometry/pmiSymbols.ts               FCF / datum / surface-texture glyphs as DrawingPrimitive paths  [geometry]
  commands/pmi/catalog.ts              commandCatalog(...)  — registered in commands/registry.ts       [commands]
  commands/pmi/{standard,datum,dimension,tolerance,surface,note,views,edit,check,list,stackup,applySet}.ts
  commands/pmi/pmiOps.ts               withPmi / requirePmiItem / nextDatumLabel helpers
  commands/persistence/pmiValidation.ts load-time validation of doc.pmi
  commands/drawings/pmiPainter.ts      PMI on sheet views (used by exportSheet.ts renderSheet)
(face centroid / normal / axis / radius / samples: gap 01 face-query port, consumed through ctx.kernel — not specified here)
packages/mcp/src/toolsets.ts           new toolset `pmi`
(exact STEP import `import_step_exact` — owned by gap 01, extended by gap 04 XCH with verification and AP242 assembly/PMI
 transport; `export_step_ap242 { includePmi }` (gap 04) over an XCAF
 document, opencascade.js custom build with XDE or the desktop OCP bridge; GDT supplies the PMI stage:)
packages/core/src/commands/pmi/xcafMapping.ts   PmiItem ⇄ bridge JSON (§6.2), enum tables (§6.1)        [commands, pure]
server/python/llull_bridge.py          PMI read/write helpers used by XCH's ops when the OCP path is used (fallback)
src/ui/panels/PmiPanel.tsx             param gathering only (L1)
src/ui/viewport/3d/PmiLayer.tsx        render PMI on annotation planes (presentation only)
```

### 2.2 Laws respected

| Law | How |
| --- | --- |
| L1 one command layer | every PMI change is a `defineCommand`; UI panel, MCP and CLI call `execute`; AP242 import lands through `apply_pmi_set` |
| L2 dependency direction | `lib/stackup.ts`, `lib/prng.ts` pure; `geometry/pmiFeatures.ts` reads only the `GeometryKernel` interface; no DOM in core; Python only in `server/` |
| L3 purity | commands spread `doc.pmi`; MC uses a seeded PRNG passed by value; `is pure` test per command |
| L4 single source | PMI lives only in `CadDocument.pmi`; sheets reference PMI ids, never copy text |
| L5 registry | params zod → JSON schema; `pmi` toolset is a VIEW |
| L6 thin backend | Python bridge converts STEP ⇄ JSON only; no rule logic in `server/` |
| L7 one model | PMI attaches to 3D solids; sheet rendering is a projection of the same data |
| L8 recipe | PMI commands append `FeatureStep`s; ids `pmi-<step>.<k>`; `facesNear` re-resolved on replay |
| L9 kernel interface | face resolution via `ctx.kernel.topology()`; feature-attaching commands declare `annotations: { requiresKernel: true }` |
| L10 plugins | none needed; an AEC plugin could reuse `doc.pmi` later |

## 3. Data model

### 3.1 Types (`packages/core/src/model/pmi.ts`)

```ts
export const PMI_STANDARDS = ['ASME_Y14.5_2018', 'ISO_GPS'] as const;
export type PmiStandard = (typeof PMI_STANDARDS)[number];

/** AP242 / OCC XCAF characteristic set (FR-GDT-05); permission per standard = rule table (§5.6). */
export const GEOMETRIC_CHARACTERISTICS = [
  'straightness', 'flatness', 'roundness', 'cylindricity', 'profile_line', 'profile_surface',
  'angularity', 'perpendicularity', 'parallelism', 'position', 'concentricity', 'coaxiality',
  'symmetry', 'circular_runout', 'total_runout',
] as const;
export type GeometricCharacteristic = (typeof GEOMETRIC_CHARACTERISTICS)[number];

export type MaterialCondition = 'MMC' | 'LMC' | 'RFS';
export const ZONE_MODIFIERS = ['free_state', 'tangent_plane', 'statistical', 'common_zone', 'each_radial_element',
  'line_element', 'not_convex', 'any_cross_section', 'major_diameter', 'minor_diameter', 'pitch_diameter',
  'separate_requirement', 'reciprocity', 'all_around', 'all_over'] as const;        // ⊂ XCAFDimTolObjects_GeomToleranceModif
export type ZoneModifier = (typeof ZONE_MODIFIERS)[number];

/** A set of B-rep faces of one solid, re-resolved from points at every replay (KI5 pattern). */
export interface PmiFeature {
  readonly entityId: string;
  readonly facesNear: readonly Vec3[];             // the recipe (persisted, replayed)
  readonly faceIndices: readonly number[];         // resolution on the current B-rep (derived, refreshed)
  readonly surface: FaceSurface | 'mixed';         // expected type: a replay that resolves another type is an error
  readonly ofSize?: { readonly kind: 'cylinder' | 'width' | 'sphere'; readonly measured: number };  // mm/in, from B-rep
}

export interface AnnotationPlacement {
  readonly plane: { readonly origin: Vec3; readonly normal: Vec3; readonly xDir: Vec3 };
  readonly position: Vec2;                         // in plane coordinates, model units
  readonly leaderTo?: Vec3;                        // attachment point on the feature
  readonly auto: boolean;                          // true = recomputed after replay
}

export interface DatumReference { readonly label: string; readonly boundary?: 'MMB' | 'LMB'; readonly modifiers?: readonly string[] }

/** AF-33 / AF-34: agent-created, agent-edited and imported items need a qualified reviewer. */
export interface PmiReview {
  readonly required: boolean;
  readonly reason?: string;                        // e.g. 'tolerance proposed by an AI operator — not approved by a qualified engineer'
  readonly acceptedBy?: string; readonly acceptedAt?: string;   // set only by accept_pmi_review from a human caller
}
interface PmiBase {
  readonly id: string; readonly placement: AnnotationPlacement; readonly name?: string;
  readonly review: PmiReview;
  readonly unverified?: { readonly reason: string };             // AF-32: unresolved/unmapped import, no rule table …
  readonly createdBy: { readonly caller: 'human' | 'agent'; readonly userId?: string };  // from ctx.caller (gap 09 TR-PLM-16)
}

export interface DatumFeaturePmi extends PmiBase { readonly kind: 'datum_feature'; readonly label: string; readonly feature: PmiFeature }
export interface SizeDimensionPmi extends PmiBase {
  readonly kind: 'size_dimension';
  readonly feature: PmiFeature;                    // ofSize required
  readonly sizeKind: 'diameter' | 'radius' | 'width' | 'spherical_diameter';
  readonly tolerance:
    | { readonly type: 'plusMinus'; readonly upper: number; readonly lower: number }
    | { readonly type: 'limits'; readonly upper: number; readonly lower: number }       // absolute limits
    | { readonly type: 'fit'; readonly code: string; readonly upper: number; readonly lower: number } // code text only
    | { readonly type: 'basic' };
  readonly count: number;                          // nX = resolved feature count
  readonly sizeModifiers?: readonly string[];      // ISO 14405 (V1), stored as data
}
export interface LocationDimensionPmi extends PmiBase {
  readonly kind: 'location_dimension';
  readonly from: PmiFeature; readonly to: PmiFeature;
  readonly measure: 'distance' | 'angle'; readonly measured: number;
  readonly tolerance: SizeDimensionPmi['tolerance'];
}
export interface GeometricTolerancePmi extends PmiBase {
  readonly kind: 'geometric_tolerance';
  readonly characteristic: GeometricCharacteristic;
  readonly target: { readonly feature: PmiFeature } | { readonly pmiId: string };   // a face set or a size dimension (FOS)
  readonly zone: { readonly value: number; readonly diametral?: boolean; readonly spherical?: boolean;
                   readonly projectedLength?: number; readonly unequallyDisposed?: number; readonly maxValue?: number };
  readonly materialCondition: MaterialCondition;
  readonly modifiers: readonly ZoneModifier[];
  readonly datums: readonly DatumReference[];      // ordered primary, secondary, tertiary; ≤ 3
  readonly compositeOf?: string;                   // V1: lower segment points at the upper FCF id
}
export interface SurfaceTexturePmi extends PmiBase {
  readonly kind: 'surface_texture'; readonly feature: PmiFeature;
  readonly parameter: string; readonly value: number; readonly unit: 'um' | 'uin';
  readonly lay?: string; readonly process?: string;
}
export interface NotePmi extends PmiBase { readonly kind: 'note'; readonly text: string; readonly feature?: PmiFeature }

export type PmiItem = DatumFeaturePmi | SizeDimensionPmi | LocationDimensionPmi | GeometricTolerancePmi | SurfaceTexturePmi | NotePmi;

export interface SavedView {
  readonly id: string; readonly name: string;
  readonly camera: CameraState;                   // existing type
  readonly pmiIds: readonly string[];
  readonly entityIds?: readonly string[];
  readonly section?: { readonly direction: ViewDirection; readonly offset: number };
}

/** Absent on the document until the first PMI command. */
export interface PmiModel {
  readonly standard: PmiStandard;
  readonly generalToleranceNote?: string;          // FR-GDT-10: text only
  readonly items: Record<string, PmiItem>;
  readonly order: string[];
  readonly savedViews: Record<string, SavedView>;
  readonly savedViewOrder: string[];
  readonly import?: { readonly source: 'step_ap242'; readonly fileName: string; readonly unresolved: number };
}
```

`CadDocument` gains `pmi?: PmiModel` (like `drawings?`). Replay: `doc.pmi` items are regenerated by their own PMI feature
steps, but two parts are not produced by steps and would be lost by `replayHistory` (which seeds an empty document): items
with no recording step (loaded/orphan items, cf. `history/carry.ts` `orphanState`) and the saved-view visibility state set by
`activate_saved_view` (metaHistory). Both are carried through the generic `DocumentExtension.carry?(prev, next)` core hook
specified as **TR-PLM-32** in gap 09 (`docs/aerospace/09-plm-configuration-traceability/TECHNICAL_SPEC.md`); because `pmi` is
a core model slice, core registers the same carry function for it (orphan items + visibility). Core change: needs `cad-reviewer`. `DrawingSheet` gains
`pmiMode?: 'off' | 'auto'` (default `off`, keeps existing snapshots unchanged) and `DrawingView` gains
`pmiIds?: string[]` (explicit list overrides `auto`).

### 3.2 Versioning / migration

- Purely additive optional fields: documents without `pmi` load unchanged; no migration step.
- `commands/persistence/pmiValidation.ts` validates loaded `pmi` (ids match keys and `[A-Za-z0-9._-]+`,
  `order` ⊆ items, labels unique, datum refs exist, numbers finite, `facesNear` finite Vec3) — same style
  as `drawingsValidation.ts`; invalid ⇒ `load_document` rejected with the first problem.
- `faceIndices` / `measured` are **derived**: refreshed by every PMI command that touches the item and by
  a post-replay refresh hook (TR-GDT-06); stale values never drive geometry.

## 4. Commands

All names snake_case, toolset `pmi` (new, `packages/mcp/src/toolsets.ts`). "K" = `requiresKernel: true`.
Params are one inline `z.object` each (C3); entity references accept `$alias` in plans.

| Command | Kind | Params sketch | `@affects` | `@invariant` | `@failure` (no-op, affected:[]) | TR |
| --- | --- | --- | --- | --- | --- | --- |
| `set_pmi_standard` | mutating | `{ standard, generalToleranceNote? }` | creates/patches `doc.pmi` header; affected `['pmi']` | items unchanged | same values → no-op | TR-GDT-01 |
| `add_datum_feature` K | mutating | `{ label?, entityId, facesNear: Vec3[≥1], placement? }` | +1 DatumFeaturePmi | label unique; feature resolves to ≥1 face of `entityId` | label taken / not A–Z / excluded by rule table; entity not a 3D solid; point farther than `tolFace` from every face; ambiguous (two faces within tol); no kernel/topology | TR-GDT-02/03 |
| `add_size_dimension` K | mutating | `{ entityId, facesNear[], sizeKind, tolerance, placement? }` | +1 SizeDimensionPmi | nominal = B-rep measurement; `count` = resolved feature count; all features same size within 1e-6 × size | not a feature of size (plane); mixed sizes in a pattern; lower > upper (plusMinus: upper < lower); limits not bracketing measured nominal (warning only) | TR-GDT-04 |
| `add_location_dimension` K | mutating | `{ entityId, from: Vec3[], to: Vec3[], measure, tolerance, basic? }` | +1 LocationDimensionPmi | measured from B-rep (plane–plane distance, axis–axis, axis–plane; angle between normals/axes) | non-parallel planes for distance; same feature twice | TR-GDT-04 |
| `add_geometric_tolerance` K | mutating | `{ characteristic, entityId?, facesNear?, targetPmiId?, zone, materialCondition?, modifiers?, datums?, placement? }` | +1 GeometricTolerancePmi | datums ordered, unique, defined; exactly one target form | undefined datum; repeated datum; > 3 datums; value ≤ 0; MMC/LMC on non-FOS; diametral on a plane; datum refs on form characteristics (straightness, flatness, roundness, cylindricity); characteristic not permitted by the active rule table | TR-GDT-05 |
| `add_surface_texture` K | mutating | `{ entityId, facesNear[], parameter, value, unit?, lay?, process? }` | +1 SurfaceTexturePmi | value > 0 | unknown parameter name (rule table list) | TR-GDT-07 |
| `add_pmi_note` | mutating | `{ text, entityId?, facesNear?, placement? }` | +1 NotePmi | text non-empty | — | TR-GDT-01 |
| `update_pmi` | mutating, idempotent | `{ pmiId, …fields valid for kind, placement?, autoPlacement? }` | patches 1 item | id/kind never change | unknown id; field invalid for kind; same values | TR-GDT-01 |
| `delete_pmi` | mutating, destructive | `{ pmiId }` | removes item + FCFs whose target is it (listed in affected); views' `pmiIds` cleaned | datums still referenced → rejected unless `cascade: true` | unknown id | TR-GDT-01 |
| `create_saved_view` / `update_saved_view` / `delete_saved_view` | mutating | `{ name, direction? \| camera?, pmiIds?, entityIds?, section? }` | +1/±1 SavedView | ids exist | unknown PMI/entity id | TR-GDT-08 |
| `activate_saved_view` | mutating (camera + visibility only) | `{ savedViewId }` | sets `doc.camera`, PMI visibility (visibility survives replay via the carry hook, §3.1 / gap 09 TR-PLM-32) | — | unknown id | TR-GDT-08 |
| `list_pmi` | query (readOnly) | `{ entityId?, kind? }` | none; `data.items[]` with text rendering and face info | — | — | TR-GDT-09 |
| `check_pmi` | query (readOnly) | `{ entityId?, rules?: 'builtin' \| 'builtin+table' }` | none; `data { status: 'pass'\|'warn'\|'fail', errors[{code, pmiIds, message, remediation}], warnings[…same], stats{items, reviewRequired, unverified}, ruleTable: 'none'\|<file hash> }` | deterministic order | no PMI → `data` with zero counts | TR-GDT-10 |
| `analyze_stackup` | query (readOnly) | `{ name?, contributors: [{name, nominal, upper, lower (document length unit; `unit:'deg'` for angles), sensitivity?, distribution?, pmiId?, verified? (default true when pmiId-linked, false when typed)}], expression?, methods[], lowerSpecLimit?, upperSpecLimit?, samples? (≤ 2e6), seed?, sigmaPerHalfTolerance? (default 3) }` | none; `data { unit, nominal, mean, worstCase{min,max,halfTolerance}, worstCaseExactCorners, rss, sigma, pBelow, pAbove, contributions[{name, wcPercent, rssPercent}], monteCarlo?{seed, samples, prng, mean, std, pBelow, acceptance}, sigmaPerHalfTolerance{value, source, defaulted}, provenance{method, formulas, sensitivitySource:'given'\|'autodiff'}, unverified?{contributors[]}, reviewRequired, reviewReason? }` | MC deterministic for (seed, samples); exactly one of `expression` or per-contributor `sensitivity` (linear stack) is given; with `expression`, sensitivities by forward-mode automatic differentiation (dual numbers) over the `parametric/expression` grammar, exact to rounding | expression parse error (reuses `parametric/expression`); samples > cap; contributor `pmiId` unknown or untoleranced | TR-GDT-11 |
| `fastener_tolerance` | query (readOnly) | `{ holeMmc, fastenerMmc, type: 'floating' \| 'fixed', split?, holeLmc?, statedPosition?, actualSize? }` | none; `data { positionTolerance (per part; fixed: T1, T2 from split, default equal), bonus?, allowedPosition?, virtualCondition? }` — bonus = actualSize − holeMmc, allowedPosition = statedPosition + bonus, virtualCondition = holeMmc − statedPosition (FF-03) | — | hole ≤ fastener; `actualSize` outside [holeMmc, holeLmc]; bonus fields requested without `statedPosition` | TR-GDT-12 |
| `accept_pmi_review` | mutating, human gate | `{ pmiIds: string[] (≥1), decision: 'accept' \| 'reject', comment, at, by }` | sets `review` on each item (`accept`: `required:false`, `acceptedBy/At`; `reject`: stays required, reason += comment) | refused for `ctx.caller.kind === 'agent'` (AF-34; same caller model as gap 09 TR-PLM-16, including its local-CLI limit); `at`/`by` host-supplied | `GDT_REVIEW_HUMAN_ONLY`; `GDT_PMI_UNKNOWN`; empty comment on reject | TR-GDT-19 |
| `apply_pmi_set` | mutating | `{ entityId, items: PmiItemInput[], savedViews?, source }` | + many items in one step (import path) | all-or-nothing; unresolved features kept with `faceIndices: []` and counted in `doc.pmi.import.unresolved` | schema-invalid item | TR-GDT-13 |
| `update_sheet` (extended) | mutating | `+ pmiMode?: 'off' \| 'auto'` | sheet patch | — | as today | TR-GDT-14 |
| `update_drawing_view` (extended) | mutating | `+ pmiIds?: string[]`, `pmiAuto?: true` | view patch | ids exist | unknown PMI id | TR-GDT-14 |
| `export_sheet_svg` (extended) | query | unchanged params | `data.pmi: { placed: [{viewId, pmiIds}], skipped: [{pmiId, reason}] }` | PMI geometry derived at export | — | TR-GDT-14 |
| PMI stage of `import_step_exact` (V1; command gap 01, AP242 transport gap 04) | exchange → commands | gap 01/04 params | exact bodies + `apply_pmi_set` per body | one undo group | no XCAF GD&T in file → 0 items, not an error | TR-GDT-15 |
| PMI stage of XCH `export_step_ap242 { includePmi: true }` (V1; gap 04) | query | XCH params | PMI attached by face reference in the XCAF document | read-only | PMI unresolved → listed in `skipped`, not written | TR-GDT-16 |

Feature steps: every mutating command above appends a `FeatureStep` through `execute` (L8);
`activate_saved_view` is a view-state command (`metaHistory`, like camera commands) so it does not
pollute the recipe. Toolset `pmi` lists all of the above; `analyze_stackup`, `fastener_tolerance`,
`list_pmi`, `check_pmi` are additionally listed in the existing `measure` toolset search keywords.

### Requirement ids (technical)

| Id | Pri | Requirement |
| --- | --- | --- |
| TR-GDT-01 | MUST | `doc.pmi` model + `set_pmi_standard`, `add_pmi_note`, `update_pmi`, `delete_pmi`, ids via `ctx.ids.next('pmi')` (step-scoped) |
| TR-GDT-02 | MUST | `add_datum_feature` with label rules: `^[A-Z]{1,2}$`, unique; excluded letters from the active rule table (none built-in) |
| TR-GDT-03 | MUST | Face addressing data come from the **gap 01 face-query port** (single optional kernel port, specified in gap 01 TECHNICAL_SPEC; GDT does not extend `ShapeFace` itself). GDT requires per face: `centroid: Vec3`, `normal?: Vec3` (plane), `axis?: {origin, dir}`, `radius?` (cylinder/cone/sphere/torus minor), `samples: Vec3[]` (≤ 64 points on the face, inside the face boundary), and a point-in-face test (§5.1 `faceContains`). Absent port (Manifold) ⇒ feature-attaching PMI commands no-op with "requires the OCC kernel" |
| TR-GDT-04 | MUST | Size/location measurement from the resolved faces (§5.2) with relative agreement 1e-9 vs analytic for primitives |
| TR-GDT-05 | MUST | FCF validation rules §5.5 implemented as pure functions over `PmiItem` + resolved feature types |
| TR-GDT-06 | MUST | Post-replay refresh: after `replayHistory`, PMI items re-resolve `facesNear` → `faceIndices` / `measured`; failures surface in `check_pmi` (`GDT_FEATURE_UNRESOLVED`, `GDT_SURFACE_TYPE_CHANGED`) — never throw |
| TR-GDT-07 | MUST | Surface texture item + symbol glyph |
| TR-GDT-08 | MUST | Saved views; `activate_saved_view` sets camera through the same code path as `set_camera` |
| TR-GDT-09 | MUST | `list_pmi` text rendering grammar §5.4 (Unicode symbols for display; ASCII fallback `--ascii`) |
| TR-GDT-10 | MUST | `check_pmi` error codes (stable strings) §5.5 |
| TR-GDT-11 | MUST | `lib/stackup.ts` formulas §5.7; `lib/prng.ts` xoshiro128** seeded by SplitMix32 of `seed`; normal by Box–Muller (cos branch, spare kept) |
| TR-GDT-12 | SHOULD | fastener formulas §5.7.6 |
| TR-GDT-13 | MUST | `apply_pmi_set` input schema = the Python bridge JSON (§6.2) |
| TR-GDT-14 | MUST | Sheet PMI rendering §5.8 |
| TR-GDT-15 | SHOULD (V1) | PMI read stage (§5.9) plugged into gap 04's `import_step_exact` (XCAF document from opencascade.js-XDE or OCP), producing the §6.2 JSON → `apply_pmi_set`; exact face attachment needs exact import (D-1, `import_step_exact`, gap 01) |
| TR-GDT-16 | SHOULD (V1) | PMI write stage (§5.10) plugged into gap 04's `export_step_ap242 { includePmi }` (`STEPCAFControl_Writer` GD&T mode) |
| TR-GDT-17 | MUST | All PMI params schemas snapshot-tested in `toToolSchemas()` contract test |
| TR-GDT-19 | MUST | Review flag + human gate (FR-GDT-31/32): `review` set from `ctx.caller` on create/edit/import; `accept_pmi_review` refuses agents; `check_pmi` warns `GDT_REVIEW_REQUIRED` per item; gap 09 `release_item` refuses while any PMI item is unreviewed (`PLM_PMI_UNREVIEWED`) |
| TR-GDT-20 | MUST | Error contract (FR-GDT-33): every refusal returns `data.error = { code, ids?, paths?, remediation }` and the summary starts `<command> rejected: <code>`; codes = §7.2; zone/projected/UZ value checks are done in `run` (not zod `.positive()`), so they get `GDT_ZONE_NON_POSITIVE` instead of the generic invalid-params text |
| TR-GDT-21 | MUST | Unverified propagation + provenance + named defaults (FR-GDT-34/35): `unverified` on items and stack-up contributors propagates to `analyze_stackup.data.unverified` and `check_pmi` warnings `GDT_UNVERIFIED_INPUT`; `provenance` and `{value, source, defaulted}` on every defaulted numeric |
| TR-GDT-18 | MUST | Coverage gate 90/85/90/90 for `commands/pmi/**`, `geometry/pmi*.ts`; `lib/stackup.ts` 100 % lines (pure math) |

## 5. Kernel / algorithms

### 5.1 Face resolution (`geometry/pmiFeatures.ts`)

Input: solid entity, points `p_k`. Steps:
1. `handle = ctx.kernel.evaluate(recipeOf(entity))`; `topo = ctx.kernel.topology(handle)`; null ⇒ reject
   "requires the OCC kernel (exact topology)".
2. For each `p_k`, distance to face *f* = min over `f.samples` and the analytic surface distance when
   `surface ∈ {plane, cylinder, sphere, cone}` (plane: |(p−o)·n|; cylinder: | ‖(p−o) − ((p−o)·d)d‖ − r |),
   accepted only if the projected point lies inside the face (point-in-face test of the gap 01 face-query
   port, TR-GDT-03; when the port offers no such test, the nearest sample distance is used).
3. `tolFace = max(1e-3 × bbox diagonal, 1e-3 mm)`. Pick the nearest face; reject if > tolFace;
   reject as ambiguous if the second nearest is within `tolFace` **and** of a different underlying surface
   (coincident split faces of the same surface are merged into the feature).
4. Return indices (deduplicated, sorted) + surface type (or `mixed`).

Replay: identical algorithm on the regenerated B-rep (KI5 edgesNear precedent). A face whose surface type
changed is an error (`GDT_SURFACE_TYPE_CHANGED`), not a silent re-attachment.

### 5.2 Measurement

| Feature | Measured value | Source of truth |
| --- | --- | --- |
| cylinder (hole/shaft) | Ø = 2 × `radius` from `BRepAdaptor_Surface::Cylinder().Radius()` | TR-GDT-03 `radius` |
| width (two opposite parallel planes) | distance between planes along the normal, requires |n1·n2| ≥ cos(1e-9 rad) and opposite material sides | plane origins + normals |
| sphere | SØ = 2 × radius | `radius` |
| location plane–plane | |(o2 − o1)·n1| | normals |
| location axis–axis | distance between parallel axes | axes |
| angle | acos(|n1·n2|) or between axes, degrees | — |

Hole vs shaft (internal vs external FOS) from the face orientation (normal pointing towards the axis =
internal), needed for MMC = minimum hole size / maximum shaft size in §5.7.6.

### 5.3 Annotation plane auto-placement (`geometry/pmiPlacement.ts`)

- Plane feature: plane containing the face normal and the world axis most perpendicular to it
  (front/top/right candidates), origin at face centroid; FCF placed `offset = 0.15 × bbox diag` along the
  outward normal; leader from the frame's nearest corner to the centroid.
- Cylinder feature: plane perpendicular to the axis through its end-cap centre (view along the hole) for
  position/size; leader to a point on the rim.
- Tie-break (deterministic): when two world axes are equally perpendicular to the feature normal/axis (|n·a| equal within
  1e-9), take the first in the fixed order Z, X, Y — normal ±Z (e.g. datum A) → plane containing Z and X, normal ±Y (FRONT
  view); normal ±Y (datum B) → plane containing Y and Z, normal ±X (RIGHT view); normal ±X (datum C) → plane containing X and
  Z, normal ±Y (FRONT view).
- Collision avoidance: greedy, items sorted by id, shift along plane x in steps of one frame height until
  no 2D bounding-box overlap with already placed items of the same plane (deterministic).
- Placement is `auto: true` until the user moves it (`update_pmi { placement }` sets `auto: false`).

### 5.4 Text rendering grammar (list_pmi, SVG)

`FCF := symbol "|" [Ø|SØ] value [Ⓜ|Ⓛ] [Ⓟ len] [Ⓕ] [Ⓣ] [Ⓢt] [UZ v] { "|" datum [Ⓜ|Ⓛ] }`.
Size: `[nX ] Ø nominal +u/-l` or `[nX ] Ø lower–upper`. Unicode symbols: ⏤ straightness, ⏥ flatness,
○ roundness, ⌭ cylindricity, ⌒ profile of a line, ⌓ profile of a surface, ∠ angularity,
⟂ perpendicularity, ∥ parallelism, ⌖ position, ◎ concentricity/coaxiality, ⌯ symmetry, ↗ circular
runout, ⌰ total runout (candidate code points, mostly in the Unicode "Miscellaneous Technical" block;
to be checked against the Unicode charts before use); SVG export draws them as
paths (`geometry/pmiSymbols.ts`), never relying on fonts. Glyph geometry is llull's own drawing; the
exact proportions prescribed by the standards are not reproduced (paywalled) and are configurable.

### 5.5 Well-formedness rules (`check_pmi`, also enforced at command time where local)

Built-in rules are **logical consistency** rules that follow from the data model, not quoted clauses:

| Code | Severity | Rule |
| --- | --- | --- |
| `GDT_DATUM_UNDEFINED` | error | an FCF references a label with no `datum_feature` on the same solid |
| `GDT_DATUM_DUPLICATE` | error | two datum features share a label |
| `GDT_DATUM_REPEATED` | error | the same label appears twice in one datum reference frame |
| `GDT_DATUM_TOO_MANY` | error | > 3 datum references |
| `GDT_ZONE_NON_POSITIVE` | error | zone value ≤ 0, projected length ≤ 0, UZ value outside [0, zone] |
| `GDT_MC_ON_NON_FOS` | error | MMC/LMC on a target that is not a feature of size |
| `GDT_DIAMETRAL_ON_PLANE` | error | Ø zone on a planar target |
| `GDT_FORM_WITH_DATUM` | error | straightness / flatness / roundness / cylindricity with datum references |
| `GDT_LIMITS_INVERTED` | error | size limits with lower > upper |
| `GDT_FEATURE_UNRESOLVED` | error | `facesNear` resolves to no face after replay |
| `GDT_SURFACE_TYPE_CHANGED` | error | resolved surface type differs from the stored one |
| `GDT_TARGET_DANGLING` | error | `target.pmiId` missing |
| `GDT_NOMINAL_OUTSIDE_LIMITS` | warning | measured nominal outside limits tolerance |
| `GDT_FEATURE_UNTOLERANCED` | warning (opt-in) | a face of a solid with ≥ 1 PMI item is not covered by any PMI and no general note exists |
| `GDT_DATUM_UNUSED` | warning | datum feature never referenced |
| `GDT_TABLE_RULE` | error/warning | a customer rule-table entry fails (§5.6) |

### 5.6 Standard-specific rule tables (customer data)

A JSON file (`pmi-rules.<standard>.json`, loaded by the composition root and injected into the context as
`ctx.pmiRules`, default empty) lists: permitted characteristics per standard, excluded datum letters,
permitted modifier × characteristic pairs, surface-texture parameter names, general-tolerance table
(optional, user-supplied values). llull ships an **empty template with keys only**; the content must be
filled by the customer from licensed copies of ASME Y14.5-2018 / ISO 1101:2017 etc. [R1][R3]. This keeps
llull free of paywalled content (TEMPLATE rule) and makes the check auditable.

### 5.7 Stack-up (`lib/stackup.ts`)

Notation: contributor *i* with nominal *m_i*, limits [m_i + l_i, m_i + u_i]; mean c_i = m_i + (l_i + u_i)/2;
half tolerance t_i = (u_i − l_i)/2; sensitivity a_i (given for a linear stack, or by forward-mode automatic differentiation
of `expression` at the means: dual-number evaluation over the same grammar as `parametric/expression`, so linear
coefficients come out exactly ±1, ½ …; a central difference is **not** acceptable, see item 5).

1. Worst case (linearised): y_mean = f(c); T_wc = Σ |a_i| t_i; [y_mean − T_wc, y_mean + T_wc].
2. Exact corners (non-linear check): min/max of f over the 2^n limit combinations (n ≤ 16; above: skipped, reported).
3. RSS: T_rss = √Σ (a_i t_i)².
4. σ model: σ_i = t_i / k (normal, k = `sigmaPerHalfTolerance`, default 3) or t_i/√3 (uniform);
   σ_y = √Σ (a_i σ_i)² (variance of a sum of independent variables).
5. Probabilities: all-normal linear ⇒ P(y < L) = Φ((L − y_mean)/σ_y) (Φ via erf, Abramowitz–Stegun
   7.1.26-class approximation is **not** acceptable: use a double-precision erfc implementation with
   relative error < 1e-12 in the tested range); all-uniform linear ⇒ exact generalised Irwin–Hall CDF
   P(Σ U_i ≤ x) = (1/(n! Π w_i)) Σ_{S ⊆ {1..n}} (−1)^{|S|} (x − Σ lo_i − Σ_{i∈S} w_i)_+^n (n ≤ 12); otherwise MC only. Evaluate it on centred terms (lo_i = −|a_i| t_i, x = L − y_mean) and with exact coefficients for linear stacks: a central-difference a_i at |c_i| = 100 carries ~1e-9 relative error, which moves P by ≫ 1e-12 (review finding; the reference generator now takes explicit `sensitivities`).
6. Contribution % = (a_i σ_i)² / σ_y² × 100 (RSS) and |a_i| t_i / T_wc × 100 (WC).
7. Monte Carlo: N samples (default 100 000, cap 2 000 000), xoshiro128** seeded by SplitMix32(seed),
   uniform u ∈ (0,1) from the top 24 bits / 2^24 offset by 2^-25; normal via Box–Muller; reports mean,
   unbiased std, min, max, P(y<L), P(y>U), and the 5σ statistical acceptance bounds
   (mean ± 5σ_y/√N, std ± 5σ_y/√(2N), p ± max(5√(p(1−p)/N), 1e-5) — the absolute 1e-5 floor keeps tiny tail
   probabilities such as SU-03's 2.8e-9 testable with N = 2e5, as in the reference generator). The Python reference generator uses CPython's
   Mersenne Twister, so cross-implementation checks use the acceptance bounds, not bit equality (VC-GDT-33).
8. Fasteners (§FR-GDT-19): floating T = H − F; fixed T1 + T2 = H − F (equal split (H − F)/2); MMC bonus
   = actual size − MMC size (internal feature); virtual condition (internal, MMC) = MMC size − T.
   These follow from the clearance geometry (derivation in `validation/generate_stackup_reference.py`).

Budgets: 1e6 samples × 10 contributors < 1.5 s in Node on a 2020 laptop (pure loop, no allocation per
sample); the command is synchronous and capped.

### 5.8 PMI on drawing sheets (`commands/drawings/pmiPainter.ts`)

1. Select PMI for a view: explicit `view.pmiIds`, else when `sheet.pmiMode === 'auto'`: items whose
   annotation-plane normal n satisfies |n · toViewer| ≥ cos(1°) for the view's `directionFrame`
   (`geometry/viewDirections.ts`), and whose feature belongs to a solid shown in the view (`viewSolids`).
   Iso, detail and section views: auto selects none in MVP (explicit ids only).
2. Project the leader target and frame anchor with `frame.project` → view model coordinates → paper mm via
   the view scale and position already computed by `layout.ts`.
3. Draw FCF cells (symbol | tolerance | datums) as `DrawingPrimitive` polylines + glyph paths with
   `style: 'annotation'`, text height configurable (default 3.5 mm paper), frame height 2× text height.
4. Clip: items whose frame falls outside the view's paper bounds + margin are moved by the same greedy
   rule as §5.3 in paper space; still colliding ⇒ placed and reported in `warnings`.
5. Section views: datum/feature symbols of cut faces are drawn on the cut outline (V1).
6. Output `data.pmi.placed/skipped`; skipped reasons: `GDT_SHEET_PLANE_NOT_PARALLEL`, `GDT_SHEET_SOLID_NOT_IN_VIEW`,
   `GDT_FEATURE_UNRESOLVED`, `GDT_SHEET_VIEW_KIND_UNSUPPORTED`.

### 5.9 AP242 semantic PMI import (PMI read stage of `import_step_exact`, V1)

PMI read stage (runs inside `import_step_exact` — gap 01 command, AP242 PMI transport by gap 04; shown here with the OCP/Python API, identical
class names in an opencascade.js XDE build):
- `STEPCAFControl_Reader` with `SetGDTMode(True)`, `SetNameMode(True)`, `SetViewMode(True)`; transfer to
  an XCAF document; `XCAFDoc_DocumentTool.DimTolTool_s(doc.Main())`.
- Enumerate dimension labels (`GetDimensionLabels`), geometric tolerance labels (`GetGeomToleranceLabels`),
  datum labels (`GetDatumLabels`); read objects (`XCAFDoc_Dimension::GetObject` →
  `XCAFDimTolObjects_DimensionObject`; `XCAFDoc_GeomTolerance::GetObject` →
  `XCAFDimTolObjects_GeomToleranceObject` with `GetType`, `GetValue`, `GetTypeOfValue`,
  `GetMaterialRequirementModifier`, `GetZoneModifier`, `GetValueOfZoneModifier`, `GetModifiers`,
  `GetMaxValueModifier`, `GetPlane`, `GetPointTextAttach` [R26]); datum objects with
  `XCAFDimTolObjects_DatumSingleModif` modifiers [R26]; referenced shapes via `GetRefShapeLabel`.
- For every referenced face: surface type, centroid, 1–4 interior sample points (llull `facesNear`), area.
- Output JSON (§6.2). Enumerations mapped by table (§6.1). Unknown enum ⇒ item kept as `note` with the raw
  text and counted in `unmapped`.
- OCCT documents that GD&T import follows the CAx-IF AP242 PMI practices and imports GD&T only when
  attached to shapes or shape groups [R28]; NIST files may hold items on constructive geometry → counted
  as `unattached` (expected, compared against the census per category).

Dependency D-1: STEP import is tessellated today (`import_step` → `import_mesh`). Exact import is the single command
`import_step_exact`, owned by gap 01 KRN and extended by gap 04 XCH (verification, AP242 assembly/PMI transport). Until it exists, imported PMI features keep their `facesNear` and `surface` but `faceIndices: []`,
status `unresolved_mesh`; `list_pmi` still lists them (inspection planning works), `check_pmi` reports
`GDT_FEATURE_UNRESOLVED` as info, not error, for imported items.

### 5.10 AP242 semantic PMI export (PMI write stage of gap 04 `export_step_ap242`, V1)

- Build the exact shapes exactly as `export_step` does today (`export_code` → CadQuery → OCP shape), keep a
  map llull solid id → OCP solid; resolve each PMI `facesNear` again on the OCP B-rep (same algorithm as
  §5.1, implemented in Python: `BRepExtrema_DistShapeShape` point–face distance) — robust to face-order
  differences between opencascade.js and OCP builds (KI5 precedent for edges).
- Create XCAF labels: shape (`XCAFDoc_ShapeTool`), datums (`SetDatum`), dimensions (`SetDimension`),
  geometric tolerances (`SetGeomTolerance` + `SetDatumToGeomTol`), populate objects with the mapping
  tables; `STEPCAFControl_Writer` with `SetGDTMode(True)`, schema switched to AP242 through OCCT's
  `write.step.schema` interface static (accepted value for AP242 to confirm in the shipped OCP version — Q-3).
  XCAF method names in §5.9/§5.10 beyond those fetched from the headers [R26] (e.g. `SetDatumToGeomTol`,
  `GetRefShapeLabel`) are taken from the OCCT reference manual index [R28] and must be confirmed in the M6 spike.
- Known limitation: OCC writer reportedly writes semantic PMI without presentation [R27] → FR-GDT-25 (V2).
- Verification: NIST SFA CLI (`sfa-cl`, Windows build of the Tcl tool [R18]) semantic PMI report on the
  exported file in CI on a Windows runner (VC-GDT-22); the census script (stdlib) as a cross-platform
  pre-check.

## 6. Interop & persistence

### 6.1 Mapping table (llull ⇄ AP242 entity ⇄ OCC XCAF)

| llull | AP242 entity (as seen in NIST files, census) | OCC XCAF |
| --- | --- | --- |
| `datum_feature` | `DATUM_FEATURE` + `DATUM` | `XCAFDoc_Datum` / `XCAFDimTolObjects_DatumObject` |
| `datums[]` (DRF) | `DATUM_SYSTEM`, `DATUM_REFERENCE_COMPARTMENT`, `DATUM_REFERENCE_ELEMENT` | datum labels attached to the tolerance (`SetDatumToGeomTol`) |
| `boundary: 'MMB'/'LMB'` | `DATUM_REFERENCE_MODIFIER_WITH_VALUE` / modifier enum in compartment | `XCAFDimTolObjects_DatumSingleModif_MaximumMaterialRequirement` / `…Least…` |
| characteristic `flatness` … `total_runout` | `FLATNESS_TOLERANCE` … `TOTAL_RUNOUT_TOLERANCE` (+ `LINE_PROFILE_TOLERANCE`, `SURFACE_PROFILE_TOLERANCE`, `COAXIALITY_TOLERANCE`, `CONCENTRICITY_TOLERANCE`, `SYMMETRY_TOLERANCE`) | `XCAFDimTolObjects_GeomToleranceType_*` (Flatness … TotalRunout; ProfileOfLine, ProfileOfSurface, CircularityOrRoundness) |
| `materialCondition MMC/LMC` | `GEOMETRIC_TOLERANCE_WITH_MODIFIERS` with `.MAXIMUM_MATERIAL_REQUIREMENT.` / `.LEAST_MATERIAL_REQUIREMENT.` | `XCAFDimTolObjects_GeomToleranceModif_Maximum_Material_Requirement` / `…Least…` (material-requirement modifier also via `GetMaterialRequirementModifier`) |
| modifiers free state, tangent plane, statistical, separate requirement … | `.FREE_STATE.`, `.TANGENT_PLANE.`, `.STATISTICAL_TOLERANCE.`, `.SEPARATE_REQUIREMENT.` | `…_Free_State`, `…_Tangent_Plane`, `…_Statistical_Tolerance`, `…_Separate_Requirement` |
| `zone.projectedLength` | `PROJECTED_ZONE_DEFINITION` | zone modifier `Projected` + `ValueOfZoneModifier` |
| `zone.unequallyDisposed` | `UNEQUALLY_DISPOSED_GEOMETRIC_TOLERANCE` | zone modifier (UZ) + value |
| `zone.maxValue` | `GEOMETRIC_TOLERANCE_WITH_MAXIMUM_TOLERANCE` | `SetMaxValueModifier` |
| all around / all over | `ALL_AROUND_SHAPE_ASPECT` | `…_All_Around`, `…_All_Over` |
| `size_dimension` diameter/radius/width | `DIMENSIONAL_SIZE` (+ `_WITH_DATUM_FEATURE`), `ANGULAR_SIZE` | `XCAFDimTolObjects_DimensionType_Size_Diameter/Radius/Thickness/Angular …` |
| `location_dimension` | `DIMENSIONAL_LOCATION`, `DIRECTED_DIMENSIONAL_LOCATION`, `ANGULAR_LOCATION` | `…_Location_LinearDistance*`, `…_Location_Angular`, `…_Location_Oriented` |
| `tolerance plusMinus / limits / fit` | `PLUS_MINUS_TOLERANCE` + `TOLERANCE_VALUE`, `LIMITS_AND_FITS` | dimension qualifier / upper-lower values; class of tolerance |
| `saved view` | `CAMERA_MODEL_D3` (+ `DRAUGHTING_MODEL`) | `XCAFDoc_View` / `XCAFView_Object` (`SetViewMode`) |
| `placement.plane` | `ANNOTATION_PLANE` | `SetPlane` / `GetPlane` |
| (graphic PMI, V2) | `TESSELLATED_ANNOTATION_OCCURRENCE`, `ANNOTATION_CURVE_OCCURRENCE`, `DRAUGHTING_CALLOUT` | `SetPresentation` (TopoDS shape) |

### 6.2 Bridge JSON (import output = `apply_pmi_set` input)

```json
{ "schema": "llull.pmi.v1", "source": {"file": "nist_ctc_01_asme1_ap242-e1.stp", "apSchema": "AP242_…"},
  "bodies": [{ "bodyIndex": 0, "name": "…",
    "items": [
      {"kind": "datum_feature", "label": "A", "feature": {"surface": "plane", "facesNear": [[0,0,0]], "area": 1234.5}},
      {"kind": "geometric_tolerance", "characteristic": "position", "zone": {"value": 0.25, "diametral": true},
       "materialCondition": "MMC", "modifiers": [], "datums": [{"label": "A"}, {"label": "B", "boundary": "MMB"}],
       "target": {"feature": {"surface": "cylinder", "facesNear": [[…]]}}, "placement": {"plane": {…}, "position": [x, y]}}
    ],
    "savedViews": [{"name": "…", "camera": {…}, "pmiRefs": [0, 3]}],
    "unmapped": [{"raw": "…", "reason": "unknown modifier"}], "unattached": 2 }] }
```

Persistence: `doc.pmi` serialises with the document JSON (`.llull.json`), autosave, live snapshot, golden
id-normalisation (`tests/golden/normalize.ts` must normalise `pmi-<step>.<k>` like other step ids).

## 7. UI / CLI / MCP surfaces

### 7.1 Surfaces (CLI first, `../AGENT_FIRST.md`)

- **CLI (primary)**: no new sub-command; every PMI command via `llull <command> [params]` / `exec`, plans via
  `run <plan> [--validate] [--continue]`, `--json` for `data`, `--save` for `export_sheet_svg`, `render_view` (PNG) and
  `export_step_ap242` (gap 04); `--kernel occt` for feature-attaching commands in `--doc` mode; `--dry-run` works for every
  mutating PMI command (AF-42). `llull guide` gains a GD&T section (units, `facesNear`, minimal plate plan; AF-03).
  `render_view` draws PMI frames/datum symbols on their annotation planes so a multimodal agent can check placement (AF-22).
- **MCP**: toolset `pmi` (discoverable via `search_tools` / `enable_toolset`); query commands carry `readOnlyHint`;
  descriptions state units, the `facesNear` contract, the OCC requirement, the refusal codes and the next command (AF-02);
  a prompt `tolerance_part` (V1) in `packages/mcp/src/prompts.ts` walks datum → size → FCF → `check_pmi`.
- **UI (review/approval)** (`src/ui/panels/PmiPanel.tsx`, viewport `src/ui/viewport/3d/PmiLayer.tsx`): lists items with
  their codes and review state; accept/reject buttons dispatch `accept_pmi_review` as a human caller; face picking yields
  `facesNear` = picked world point (never indices); frames drawn as on-plane billboards with drei `<Text>`/lines;
  saved-view buttons call `activate_saved_view`. Presentation only (rules/react.md).

### 7.2 Stable error / finding codes (AF-11)

Every refusal returns `data.error = { code, ids, paths, remediation }`, exit code 1; every `check_pmi` finding has the
same shape inside `errors[]` / `warnings[]`. Codes are part of the public contract (snapshot-tested with the tool schemas).

| Code | Sev | When (command) | Offending ids / paths | Remediation (text returned) |
| --- | --- | --- | --- | --- |
| `GDT_KERNEL_NO_TOPOLOGY` | refuse | any feature-attaching command without exact topology | `entityId` | "rerun with --kernel occt (desktop) — PMI needs exact faces" |
| `GDT_ENTITY_NOT_SOLID` | refuse | `entityId` is not a 3D solid | `entityId` | "pass the id of a solid (llull describe_scene)" |
| `GDT_POINT_NOT_ON_FACE` | refuse / error | a `facesNear` point is farther than `tolFace` from every face | `facesNear[i]` | "pick a point on the face (inspect_topology lists face centroids)" |
| `GDT_FACE_AMBIGUOUS` | refuse | two different surfaces within `tolFace` | `facesNear[i]`, face indices | "move the point to the face interior" |
| `GDT_DATUM_LABEL_INVALID` | refuse | label not `^[A-Z]{1,2}$` or excluded by the rule table | `label` | "use the next free letter (omit label)" |
| `GDT_DATUM_DUPLICATE` | refuse / error | label already used on the solid | `label`, existing pmi id | "choose another letter or update_pmi the existing datum" |
| `GDT_DATUM_UNDEFINED` | refuse / error | FCF references a label with no datum feature | `datums[i].label` | "add_datum_feature with that label first" |
| `GDT_DATUM_REPEATED` | refuse / error | same label twice in one DRF | `datums` | "list each datum once, primary → tertiary" |
| `GDT_DATUM_TOO_MANY` | refuse / error | > 3 datum references | `datums` | "keep at most 3 references" |
| `GDT_DATUM_REFERENCED` | refuse | `delete_pmi` of a datum still referenced | pmi ids of FCFs | "delete or edit those FCFs, or pass cascade: true" |
| `GDT_ZONE_NON_POSITIVE` | refuse / error | zone, projected length ≤ 0, UZ outside [0, zone] | `zone.*` | "tolerance values are > 0 in document units" |
| `GDT_MC_ON_NON_FOS` | refuse / error | MMC/LMC on a target that is not a feature of size | pmi id / `materialCondition` | "target a size dimension (targetPmiId) or drop the modifier" |
| `GDT_DIAMETRAL_ON_PLANE` | refuse / error | Ø zone on a planar target | `zone.diametral` | "remove diametral for planar features" |
| `GDT_FORM_WITH_DATUM` | refuse / error | form characteristic with datum refs | `datums` | "form tolerances take no datums" |
| `GDT_CHARACTERISTIC_NOT_PERMITTED` | refuse / error | rule table forbids it for the standard | `characteristic` | "see pmi-rules.<standard>.json" |
| `GDT_NOT_FOS` | refuse | size dimension on a non feature of size | `facesNear` | "use add_location_dimension for planes" |
| `GDT_SIZE_MIXED` | refuse | pattern faces of different size | face indices | "split into one size dimension per size" |
| `GDT_LIMITS_INVERTED` | refuse / error | lower > upper | `tolerance` | "swap the limits" |
| `GDT_NOMINAL_OUTSIDE_LIMITS` | warn | measured nominal outside limits | pmi id | "check the model or the limits" |
| `GDT_PMI_UNKNOWN` | refuse | unknown `pmiId` / `targetPmiId` | id | "list_pmi for valid ids" |
| `GDT_FIELD_INVALID_FOR_KIND` | refuse | `update_pmi` field not valid for the item kind | path | "llull describe update_pmi" |
| `GDT_VIEW_REF_UNKNOWN` | refuse | saved view references unknown PMI/entity | ids | "remove the id or create the item" |
| `GDT_SURFACE_PARAMETER_UNKNOWN` | refuse | surface-texture parameter not in the rule-table list | `parameter` | "use Ra/Rz or fill the rule table" |
| `GDT_FEATURE_UNRESOLVED` | error | `facesNear` resolves to no face after replay | pmi id | "update_pmi with a point on the new face" |
| `GDT_SURFACE_TYPE_CHANGED` | error | resolved surface type differs | pmi id | "re-attach the item" |
| `GDT_TARGET_DANGLING` | error | `target.pmiId` missing | pmi id | "delete or retarget the FCF" |
| `GDT_FEATURE_UNTOLERANCED` | warn (opt-in) | face of a toleranced solid not covered, no general note | face index | "add PMI or set_pmi_standard generalToleranceNote" |
| `GDT_DATUM_UNUSED` | warn | datum never referenced | pmi id | "reference it or delete it" |
| `GDT_TABLE_RULE` | error/warn | customer rule-table entry fails | pmi id, rule id | rule's own text |
| `GDT_REVIEW_REQUIRED` | warn (never hidden) | item `review.required` (agent-created/edited or imported) | pmi ids | "a qualified engineer must accept_pmi_review in the desktop app" |
| `GDT_REVIEW_HUMAN_ONLY` | refuse | `accept_pmi_review` from an agent caller | pmi ids | "ask the owner to have a qualified engineer review in the app" |
| `GDT_UNVERIFIED_INPUT` | warn (never hidden) | unresolved/unmapped import, no rule table, typed stack-up contributor | ids / contributor names | "link the contributor to a PMI item or confirm the value with its source" |
| `GDT_IMPORT_UNMAPPED` | warn | AP242 item with unknown enum kept as note | raw text | "report to llull; check the item manually" |
| `GDT_STACKUP_EXPRESSION` | refuse | expression parse error / unknown name | `expression` | "use + - * / ( ) and contributor names" |
| `GDT_STACKUP_SAMPLES_CAP` | refuse | samples > 2e6 | `samples` | "use ≤ 2000000" |
| `GDT_STACKUP_CONTRIBUTOR_UNTOLERANCED` | refuse | `pmiId` contributor without tolerance | contributor | "add a tolerance to the PMI item" |
| `GDT_STACKUP_SENSITIVITY_CONFLICT` | refuse | both `expression` and `sensitivity` given | contributors | "give either expression or sensitivities" |
| `GDT_FASTENER_HOLE_LE_FASTENER` | refuse | hole MMC ≤ fastener MMC | `holeMmc` | "no clearance: no positional tolerance is possible" |
| `GDT_SHEET_PLANE_NOT_PARALLEL` / `GDT_SHEET_SOLID_NOT_IN_VIEW` / `GDT_SHEET_VIEW_KIND_UNSUPPORTED` | info (`data.pmi.skipped`) | sheet placement | pmi id, view id | "add a view facing the plane / list pmiIds explicitly" |

### 7.3 Agent-first compliance (`../AGENT_FIRST.md`)

| AF | Where satisfied |
| --- | --- |
| AF-01, AF-02 | FR-GDT-28; all PMI commands are registry commands in toolset `pmi`; descriptions per §7.1 |
| AF-03 | FR-GDT-36; `llull guide` GD&T section |
| AF-04, AF-10 | FR-GDT-24; params state units; `data` shapes in §4 (`measuredMm`/`unit`, stack-up `unit`) |
| AF-05 | FR-GDT-28; `validation/draft_plan_gdt_plate.json` runs with `run --validate` |
| AF-11 | FR-GDT-33, TR-GDT-20, §7.2 |
| AF-12, AF-13 | `list_pmi` filters by entity/kind; sheets/STEP via `--save`; deterministic ids `pmi-<step>.<k>`, seeded MC |
| AF-20 | FR-GDT-11 `check_pmi` (pass/warn/fail) |
| AF-21, AF-22 | FR-GDT-13 CLI equivalent (plane data in `list_pmi`), `render_view --save` with PMI |
| AF-23 | VC-GDT-* phrased as CLI scripts (validation/README §4) |
| AF-30 | built-in logical rules §5.5 + customer rule tables §5.6 (sourced data, never paywalled content) |
| AF-31, AF-35 | FR-GDT-35, TR-GDT-21 (`sigmaPerHalfTolerance`, `samples`, `tolFace` named; provenance) |
| AF-32 | FR-GDT-34, TR-GDT-21 |
| AF-33, AF-34 | FR-GDT-31/32, TR-GDT-19 (`accept_pmi_review` human-only; gap 09 release blocked while unreviewed) |
| AF-36 | FR-GDT-36 owner summary |
| AF-40 | AP242 import (V1) reports `--progress`, respects `--timeout` |
| AF-41 | OCP/CadQuery bundled on desktop; NIST SFA only in CI (not needed by the operator) |
| AF-42 | `--dry-run` on all mutating PMI commands |

## 8. Performance & robustness budgets

| Item | Budget |
| --- | --- |
| Face resolution | ≤ 5 ms per point for a 2 000-face solid (topology cached by `recipeKey`, samples precomputed once per handle) |
| Post-replay refresh | ≤ 10 % of replay time for 200 PMI items |
| `check_pmi` | ≤ 50 ms for 500 items |
| `export_sheet_svg` with PMI | ≤ +30 % vs without, A3 sheet, 100 PMI items |
| `analyze_stackup` | 1e6 samples × 10 contributors ≤ 1.5 s; hard cap 2e6 samples |
| AP242 import (Python) | NIST FTC 09 (6.1 MB) ≤ 20 s on desktop incl. tessellation |
| Robustness | no command throws on malformed PMI; every failure is a no-op with a reason (guard + `noop`) |

## 9. Test strategy (mapped to VC ids)

| Layer | File(s) | Covers | VC |
| --- | --- | --- | --- |
| unit | `tests/unit/pmi/datum.test.ts`, `tolerance.test.ts`, `dimension.test.ts`, `surface.test.ts`, `views.test.ts` | happy + every failure code, `is pure` | VC-GDT-01, 03, 04 |
| unit (OCC) | `server/tests/occtPmiFeatures.test.ts` (OCC worker, like `server/tests/occtParametricEdges.test.ts`) | facesNear resolution, ambiguity, replay after resize | VC-GDT-02 |
| unit | `tests/unit/lib/stackup.test.ts` | `stackup_reference.json` SU-01..05, FF-01..03; uniform CDF; erfc accuracy | VC-GDT-30..35 |
| unit | `tests/unit/lib/prng.test.ts` | determinism per seed, uniformity (χ² on 1e5 draws, p > 1e-3) | VC-GDT-33 |
| contract | `tests/unit/contract/toolSchemaSnapshot.test.ts` snapshot (`__snapshots__/toolSchemas.json`) | new schemas | VC-GDT-52 |
| contract | `tests/unit/persistence.test.ts` + `tests/unit/contract/persistenceV2.test.ts` | `pmiValidation` round trip and rejections | VC-GDT-50 |
| golden | `tests/golden/plans.ts` `kernelPlans.gdt_plate` (from `validation/draft_plan_gdt_plate.json`) | id-normalised snapshot + replay equality | VC-GDT-01, 50 |
| component | `tests/component/PmiPanel.test.tsx` | param gathering, no geometry math | VC-GDT-53 |
| drawings | `tests/unit/drawings/pmiPainter.test.ts` | auto selection, placed/skipped, SVG contains frame/glyph groups | VC-GDT-10, 11 |
| server | `server/tests/stepPmi.integration.test.ts` (needs Python + OCP; skipped without) | NIST census equality on import; export → re-import equality | VC-GDT-20, 21 |
| quality gate | `quality/corpus.json` new entries `gate: "step-pmi"` pinned by `validation/nist_pmi_files.json` | per-category census equality, `knownIssues` ratchet | VC-GDT-20 |
| production gate | scenario "supplier MBD intake": import NIST FTC 06 → list_pmi → check_pmi → sheet with PMI → export SVG | end-to-end | VC-GDT-24 |
| external | NIST SFA `sfa-cl` on Windows CI | semantic PMI report of exports | VC-GDT-22 |
| agent-first (CLI) | `server/tests/cli-pmi.test.ts`: runs the plate plan, rejection plan and SU plans through `node server/bin/llull.cjs … --json`, compares with `validation/expected_results.json` | error codes + remediation, `reviewRequired`, human gate, unverified propagation, provenance/defaults | VC-GDT-54..58 |

## 10. Delivery plan

| Milestone | Content | Depends on | Effort (eng-weeks) |
| --- | --- | --- | --- |
| M1 | `geometry/pmiFeatures.ts` over the gap 01 face-query port, `model/pmi.ts`, persistence validation | gap 01 face-query port | 2 |
| M2 | Commands: standard, datum, size, location, FCF, surface, note, update/delete, list, check; golden plan | M1 | 3 |
| M3 | Viewport PMI layer + panel + saved views | M2 | 2.5 |
| M4 | Sheets: pmiPainter, `pmiMode`, symbols | M2, drawings feature (exists) | 2 |
| M5 | `lib/stackup.ts`, `lib/prng.ts`, `analyze_stackup`, `fastener_tolerance` | — (parallel) | 1.5 |
| M6 (V1) | PMI read/write stages + `xcafMapping.ts` + `apply_pmi_set`, quality gate on NIST files, SFA CI | M2; gap 01 KRN (`import_step_exact`, exact attachment); gap 04 XCH (its AP242 PMI transport extension, `export_step_ap242`, XCAF document) | 4 |
| M7 (V1) | composite FCF, datum targets, all-around, ISO 14405 modifiers, PMI-linked stacks | M2, M5 | 2.5 |
| V2 | graphic PMI, PDF sheets, zone visualisation, TDP bundle, 2D/3D vector loops | M6 | 6+ |

Total MVP (M1–M5) ≈ 11 eng-weeks; V1 ≈ +6.5.

## 11. Open questions / decisions needed

| Id | Question | Proposed answer |
| --- | --- | --- |
| Q-1 | Does the opencascade.js build expose XCAF GD&T classes? | Not needed for MVP (PMI model is llull data). Gap 04 plans a custom opencascade.js build with XDE toolkits; the OCP bridge on desktop is the fallback (KI6) |
| Q-2 | Exact STEP B-rep import (D-1) owner? | Decided: one command `import_step_exact`, owned by gap 01 KRN, extended by gap 04 XCH; PMI import degrades to `unresolved_mesh` until then |
| Q-3 | AP242 schema switch value in the shipped OCP/OCCT (`write.step.schema`) and whether "e2/e3/e4" editions are writable | Spike in M6 against SFA |
| Q-4 | Ship any rule-table content? | No (paywalled); empty template + customer fill; optionally partner-supplied |
| Q-5 | Should PMI be entities (`kind: 'pmi'`) for selection/layers? | No: separate model like drawings; selection via panel; revisit if layer control is required |
| Q-6 | ASME vs ISO symbol differences in rendering (e.g. datum feature triangle style) | Two glyph sets keyed by `standard`; proportions configurable |
| Q-7 | Inch documents: surface texture µin under ASME? | `unit` per item; default from `standard` + `doc.units` |
| Q-8 | Which current editions of ISO 5459 and ISO 14405-1 apply (catalogue showed a 2024 ISO 5459 entry and the 2016 ISO 14405-1 as withdrawn)? | Confirm with ISO catalogue before V1 |

## 12. References

[R1]–[R35] as in `FUNCTIONAL_SPEC.md` §11, plus:

- [R28] OCCT STEP translator user guide, GD&T section (quoted via OCCT commit page mirror) — https://git.rbts.co/OpenCascade/occt/commit/a8a3b37c0d5dd416a0f98a031be7a4fc05075e52 ; OCCT tracker #26827 (reading FCF position from STEP) — https://tracker.dev.opencascade.org/view.php?id=26827 (accessed 2026-10)
- [R29] OpenCascade, aerospace use cases (PMI import from STEP AP242) — https://opencascade.com/use_cases_industry/aerospace (accessed 2026-10)
- [R30] bldrs-ai/conway, NIST STEP metadata design notes (independent entity counts for nist_ctc_01) — https://github.com/bldrs-ai/conway/blob/main/design/new/step-metadata-nist.md (accessed 2026-10)
- [R36] usnistgov/SFA source: `sfa-nist.tcl` (expected-PMI coverage logic), `sfa-cl.tcl` (command line) — https://github.com/usnistgov/SFA/tree/master/source (accessed 2026-10)
- llull internal: `docs/decisions/KI5-shape-kernel-boundary.md`, `docs/decisions/KI6-desktop-app-cli-first.md`, `.claude/rules/architecture.md`.
