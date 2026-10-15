# Gap 08 — Aerospace materials & standard parts — Technical spec

Gap id **MAT** · Status: specification (no implementation) · Written 2026-10-15
Functional: [FUNCTIONAL_SPEC.md](FUNCTIONAL_SPEC.md) · Validation: [validation/README.md](validation/README.md)

---

## 1. Current state in llull

| Area | File(s) | Today | Limit for aerospace |
| ---- | ------- | ----- | ------------------- |
| Material record | `packages/core/src/model/types.ts` (`Material`, `MaterialFinish`, `CadDocument.materials`) | `{ name, density, color, metalness, roughness, finish? }`, keyed by name | No form/temper/spec/basis/provenance; density unit implicit |
| Material commands | `packages/core/src/commands/document/materials.ts` | `create_material` (replace by name), `assign_material` (sets `BaseEntity.materialId`) | One scalar density; PBR mixed with physics |
| Mass | `packages/core/src/commands/inspect/measureSolid.ts` (`mass_properties`), `inspect/solidVolume.ts` | volume closed-form (primitives) / `exact` (OCC topology) / `mesh`; mass = V × density, `unit: 'g'` always; instance children resolve own → instance → fallback density | In an `in` document a density of 0.101 (lb/in³) would be reported as "g" — wrong unit label |
| Persistence | `commands/persistence/guards.ts` `validateMaterialValue`, `serialization.ts` (`CURRENT_SCHEMA_VERSION = 2`) | validates density > 0, hex colour, PBR ranges | Unknown fields? must be extended + migrated |
| BOM | `commands/assembly/billOfMaterials.ts` | rows per `componentId` (count, perEntityKindCounts) | No part number, no standard part, no material lines |
| Assemblies | `commands/assembly/assemblies.ts` (`create_component`, `insert_instance`) | `Component {id, name, entities, order}`; `InstanceEntity.componentId` | Usable as the fastener-instance mechanism |
| Kernel | `packages/core/src/geometry/kernel.ts` (`GeometryKernel.evaluate/tessellate/topology/exportStep`), KI5 | Recipes with `boolean` nodes; OCC exact | Hole cut for fastener stack = boolean difference recipe (exists) |
| Toolsets | `packages/mcp/src/toolsets.ts` | `create_material assign_material` in `3d`; `mass_properties` in `measure`; `bill_of_materials` in `assembly` | No `materials`/`fasteners` toolset |
| Domain plugins | `src/app/plugins.ts` installs building / industrial / civil from `@aec` | `steel/profiles.ts` is a precedent for a catalogue in a plugin | No aerospace plugin |

## 2. Target architecture

### 2.1 Layer placement (laws L1–L10)

| Concern | Layer | Why |
| ------- | ----- | --- |
| Unit conversion (exact constants, dimension algebra for density/stress/temperature) | `packages/core/src/lib/quantity.ts` (pure leaf) | Pure helper used by core and plugins |
| Material record envelope (`MaterialRecord`, `PropertyValue`, `Provenance`, `Basis`, markings) | `packages/core/src/model/material.ts` | Materials are core document data (already in `CadDocument`); gap 06 composite records extend the same envelope |
| Material commands (`create_material` v2, `set_material_property`, `import_material_library`, `get_material`, `get_material_allowable`, `diff_material_libraries`) | `packages/core/src/commands/document/` (new files, registered in `document/catalog.ts`) | Generic CAD capability, not aerospace-only |
| `mass_properties` unit-awareness | `commands/inspect/measureSolid.ts` | Fix in place |
| Private library access | Injected port `ctx.libraries: MaterialLibraryProvider` (type in `commands/types.ts`), implemented in `server/` (desktop reads `~/.llull/libraries/`) and in `src/ui` (browser: IndexedDB) | Core cannot touch fs/DOM (L2); same pattern as `ctx.kernel` (L9) |
| Fastener catalogue model, selection, stack insertion, rows, joint hook | **New plugin package `packages/domain-aero/`** (`@aero`), plugin `aeroFasteners` (`toolset: 'fasteners'`) | Domain capability ⇒ plugin (L10); core never imports it |
| BOM standard-part / material rows | `commands/assembly/billOfMaterials.ts` reads optional `Component.partRef` + `materials` (generic, no aero knowledge) | BOM is core; plugin only fills `partRef` |
| Export-control / licence gating | Core: marking propagation + `exportGate()` pure check; `server/` + `@mcp` enforce on share/cloud paths | L6 thin server: it calls the same pure check |
| Composition | `src/app/plugins.ts` adds `installPlugin(aeroFastenersPlugin)` | Composition root only |

Dependency: `@aero → @core` only (same as `@aec`). Needs `tsconfig.base.json` alias `@aero/*`, dependency-cruiser
rule clone of `domain-aec`, knip workspace entry.

### 2.2 Technical requirements

| Id | Pri | Requirement | FR |
| -- | --- | ----------- | -- |
| TR-MAT-01 | MUST | `lib/quantity.ts`: parse/convert units with exact factors; dimension check; rel error ≤ 1e-12 | FR-MAT-02 |
| TR-MAT-02 | MUST | `mass_properties` returns `mass`, `massUnit`, `densityQuantity`, `densitySource`; legacy `unit:'g'` field kept when massUnit = g | FR-MAT-05 |
| TR-MAT-10 | MUST | Density resolution order: record preferred density → legacy `Material.density` (g/(doc unit)³) → `density` param; the source used is reported | FR-MAT-05, FR-MAT-23 |
| TR-MAT-11 | MUST | `MaterialRecord` / `PropertyValue` / `Provenance` types (§3.1) with zod schemas; one `preferred` per key | FR-MAT-01/03/04 |
| TR-MAT-12 | MUST | `get_material_allowable` exact-key match; no basis substitution; `forCertification` refuses `superseded`, `typical`, `supplier_unstated` | FR-MAT-06 |
| TR-MAT-13 | SHOULD | Temperature tables: linear interpolation, no extrapolation, `percentOfRT` mode | FR-MAT-07 |
| TR-MAT-14 | MUST | Persistence v3 + migration 2→3; legacy materials unchanged | FR-MAT-23 |
| TR-MAT-15 | SHOULD | `diff_material_libraries` keyed by `(material.id, PropertyValue.id)` | FR-MAT-24 |
| TR-MAT-16 | MUST | Private-library resolution is the host-dispatched session command `resolve_material_libraries` after `load_document` (§3.2); exact sha256 match only; otherwise records stay `unresolved` with the last snapshot hash and value queries return `available:false` | FR-MAT-08, FR-MAT-21 |
| TR-MAT-20 | MUST | `FastenerFamily` model with part-number grammar; integer sixteenths/32nds arithmetic | FR-MAT-11 |
| TR-MAT-21 | MUST | `select_fastener` algorithm §5.2 (grip modes, washer shim ≤ 1/8 in, protrusion ≥ 1 pitch) | FR-MAT-12/13/14 |
| TR-MAT-22 | MUST | `insert_fastener_stack`: one FeatureStep; boolean cut via `ctx.kernel`; component per part number; derivation guard | FR-MAT-15 |
| TR-MAT-23 | MUST | `Component.partRef` + BOM `standardParts` / `materials` sections, backward-compatible `rows` | FR-MAT-16 |
| TR-MAT-24 | SHOULD | Geometry from catalogue dims; unknown dims ⇒ `representative`, excluded from mass | FR-MAT-17 |
| TR-MAT-25 | SHOULD | `insert_fastener_row` pitch/edge checks; batched boolean | FR-MAT-18 |
| TR-MAT-26 | SHOULD | Catalogue files loaded at runtime (no code per family) | FR-MAT-19 |
| TR-MAT-30 | MUST | Licence + export marking on libraries/records; document marking = most restrictive | FR-MAT-09 |
| TR-MAT-31 | MUST | Values of `storage:'private'` libraries never serialized (save, snapshot, live-sync log, export_code) | FR-MAT-08, FR-MAT-21 |
| TR-MAT-32 | MUST | MCP responses redact private-licensed values for non-local clients; `exportGate()` enforced in server for share/cloud | FR-MAT-09 |
| TR-MAT-40 | MUST | Seed library = public-domain values only, each with primary locator | FR-MAT-10 |
| TR-MAT-41 | MUST | `sources.lock.json` pins primary PDFs by sha256; CI check that every seed value's `sourceId` is locked | FR-MAT-04, FR-MAT-10 |

### 2.3 Kernel needs

- Hole cut: `boolean` recipe node `{ op: 'boolean', boolean: 'subtract', a: plate, b: cylinder }` already exists (KI5). OCC exact; Manifold
  mesh fallback acceptable for preview (`supports('boolean')` true on both).
- Fastener solids: revolve of a 2D half-profile (a `revolve_profile` solid, entering recipes as a `solid` leaf) or primitive composition
  (cylinder shank + head). Generated once per part number into a `Component`; instances reuse it (KI5 cache
  keys by `recipeKey`, so N instances cost one evaluation).
- Stack thickness measurement along an axis: ray–solid intersection. MVP: analytic for boxes/cylinders and
  `topology()`-based face-plane intersection for exact solids; V1: `GeometryKernel.intersectLine?(handle, origin,
  dir)` optional method (new, `supports`-gated) → list of entry/exit parameters (OCC `IntCurvesFace_ShapeIntersector`
  / `BRepIntCurveSurface_Inter`).

## 3. Data model

### 3.1 Material record (core, `model/material.ts`)

```ts
export type Basis = 'A' | 'B' | 'S' | 'typical' | 'supplier_unstated' | 'company' | 'unspecified';
export type GrainDirection = 'L' | 'LT' | 'ST' | 'isotropic';
export type LicenceFlag = 'public-domain-us-gov' | 'licensed-no-redistribution' | 'company-proprietary' | 'vendor-catalogue' | 'legacy';
export type ExportMarking = { readonly regime: 'none' } | { readonly regime: 'EAR99' } | { readonly regime: 'EAR'; readonly eccn: string }
  | { readonly regime: 'ITAR'; readonly category?: string };

export interface Provenance {
  readonly sourceId: string;            // key into MaterialLibrary.sources
  readonly locator?: string;            // "Table 3.2.3.0(b1)", "Fig. 3.2.3.1.1(a)"
  readonly accessed?: string;           // ISO date
  readonly note?: string;
}
export interface Quantity { readonly value: number; readonly unit: string }   // unit grammar: lib/quantity.ts
export interface PropertyValue {
  readonly id: string;                  // stable within the material, e.g. "Ftu.L.A.t0.020-0.128"
  readonly property: MaterialPropertyName;   // 'density' | 'E' | 'Ec' | 'G' | 'nu' | 'Ftu' | 'Fty' | 'Fcy' | 'Fsu' | 'Fbru' | 'Fbry' | 'elongation' | 'cte' | 'k' | 'cp'
  readonly quantity: Quantity;
  readonly basis: Basis;
  readonly direction?: GrainDirection;
  readonly thickness?: { readonly min: number; readonly max: number; readonly unit: string };
  readonly edOverD?: number;            // bearing e/D (1.5 | 2.0)
  readonly temperature?: TemperatureDependence;   // absent = room temperature
  readonly provenance: Provenance;
  readonly preferred?: true;            // at most one preferred per (property, direction, basis, thickness, edOverD)
}
export interface TemperatureDependence {
  readonly mode: 'absolute' | 'percentOfRT';
  readonly exposureHours?: number;
  readonly points: ReadonlyArray<readonly [tempValue: number, value: number]>;   // strictly increasing T
  readonly temperatureUnit: 'degF' | 'degC' | 'K';
}
export interface MaterialRecord {
  readonly id: string;                  // "aa7075_t6_sheet"
  readonly name: string;                // display
  readonly designation: string; readonly temper?: string; readonly productForm?: string;
  readonly specs: ReadonlyArray<{ readonly body: string; readonly id: string; readonly revision?: string }>;
  readonly properties: ReadonlyArray<PropertyValue>;
  readonly licence: LicenceFlag; readonly exportMarking: ExportMarking;
  readonly superseded?: { readonly by: string; readonly note: string };   // MIL-HDBK-5J → MMPDS
  readonly libraryRef?: { readonly libraryId: string; readonly version: string; readonly sha256: string };
}
```

`Material` (existing) becomes the **render + legacy** view: `CadDocument.materials[name]` keeps
`{name, density, color, metalness, roughness, finish?}` and gains optional `recordId?: string` linking to
`CadDocument.materialRecords[recordId]` (new optional section). Density resolution order for mass
(TR-MAT-10): record preferred density → legacy `density` (interpreted g/(doc unit)³) → `mass_properties` param.

### 3.2 Library (import/export unit)

```ts
export interface MaterialLibrary {
  readonly format: 'llull-material-library'; readonly schemaVersion: 1;
  readonly id: string; readonly version: string; readonly title: string;
  readonly licence: LicenceFlag; readonly exportMarking: ExportMarking;
  readonly storage: 'embedded' | 'private';
  readonly sources: Record<string, { citation: string; url?: string; edition?: string; sha256?: string; accessed?: string }>;
  readonly materials: ReadonlyArray<MaterialRecord>;
}
```

Document stores `materialLibraries: Record<libraryId, { version, sha256, storage, licence, exportMarking, title }>`.
`storage: 'private'` ⇒ `materialRecords` entries from it are **not serialized**. The saved document keeps, per
private library, `{ libraryId, version, sha256 }` (the hash of the library snapshot last resolved) and per record only
`{ id, libraryRef }`.

**Resolution step (TR-MAT-16).** Persistence stays pure and port-free (`load_document` and `DocumentExtension.restore` get no
`ctx`). Private values are filled by a separate mutating command `resolve_material_libraries {}` that reads the injected port
`ctx.libraries.get(libraryId, version, sha256)`:

1. The host (`server/` for CLI and desktop, `src/ui` for the browser) dispatches it right after every `load_document`, and the
   UI offers it again after the user registers a library (`llull libraries add`).
2. For each `libraryRef` whose provider snapshot has the **same sha256**, it fills the records. It is a session command: it is
   not appended to `featureHistory` and it is never serialized (TR-MAT-31), so undo/redo and replay never carry private values.
3. Provider missing, library missing, or **different sha256** ⇒ the record stays a stub `{ id, libraryRef, unresolved: true,
   reason: 'provider missing' | 'library missing' | 'hash mismatch' }`. It keeps the last snapshot hash; values are **never**
   silently replaced by another version or by the legacy density.

**Replay without the provider.** `replay_history` re-runs steps against the stubs: mutating steps that need a private value
(for example `assign_material` of an unresolved record) still apply their structural effect, while every query that needs the
value (`mass_properties`, `get_material_allowable`, `select_fastener` material checks) returns `available: false` with the
reason, never a number. Once the provider appears with the recorded hash, `resolve_material_libraries` restores the same values,
so a replay is value-identical; with a new hash the user must run `import_material_library` for the new version explicitly
(a recorded, diffable step, TR-MAT-15).

### 3.3 Fastener catalogue (plugin `@aero`, `fasteners/catalogModel.ts`)

```ts
export interface FastenerFamily {
  readonly id: string;                       // "NAS6203-6220"
  readonly kind: 'bolt' | 'hi_lok_pin' | 'solid_rivet' | 'blind_rivet' | 'lockbolt' | 'nut' | 'washer' | 'collar' | 'insert';
  readonly standard: { body: string; id: string; revision?: string };
  readonly partNumber: PartNumberGrammar;    // ordered fields: literal | code(table) | int(scale, unit)
  readonly gripIncrement?: Quantity;         // 0.0625 in
  readonly gripMode?: 'min_grip_ge_stack' | 'max_grip_range';   // NAS bolts vs Hi-Lok
  readonly lengthRule?: { readonly kind: 'grip_plus_thread' } | { readonly kind: 'stack_plus_k_d'; readonly k: number; readonly round: 'up' | 'nearest'; readonly step: Quantity };
  readonly sizes: ReadonlyArray<FastenerSize>;
  readonly availableGripDash?: { readonly min: number; readonly max: number };   // per family or per size
  readonly licence: LicenceFlag; readonly provenance: Provenance;
}
export interface FastenerSize {
  readonly dash: string; readonly nominalDiameter: Quantity; readonly thread?: string; readonly threadsPerInch?: number;
  readonly threadLength?: Quantity;                     // grip_plus_thread
  readonly dims: Record<string, { min?: number; max?: number; nominal?: number; unit: string; provenance: Provenance }>;  // headDiameter, headHeight, acrossFlats, height, od, id, thickness …
  readonly holeDiameter?: { min: number; max: number; unit: string; provenance: Provenance };   // close-tolerance hole (V1, from catalogue)
}
```

Catalogues are plugin document data: `CadDocument.aero?.fastenerCatalogs: Record<familyId, FastenerFamily>` via
`DocumentExtension` (validate / restore), plus private catalogues through the same `ctx.libraries` port
(`kind: 'fastener-catalog'`).

### 3.4 Fastener stack (plugin document data)

```ts
export interface FastenerStack {
  readonly id: string;                          // step-scoped "fst-<step>.<k>" (L8)
  readonly axis: { origin: Vec3; direction: Vec3 };
  readonly layers: ReadonlyArray<{ entityId: string; thickness: number }>;   // measured stack, document units
  readonly fastener: { family: string; partNumber: string; instanceId: string };
  readonly washers: ReadonlyArray<{ partNumber: string; instanceId: string; side: 'head' | 'nut' }>;
  readonly nut?: { partNumber: string; instanceId: string };
  readonly holeStepRef: string;                 // FeatureStep id of the boolean cut
  readonly checks: SelectionChecks;             // gap, washerTotal, protrusion, edge/pitch results
}
```

Components get optional `partRef?: { family: string; partNumber: string; description?: string; unitMass?: Quantity }`
(core type, generic) so `bill_of_materials` can group by part number without importing the plugin.

### 3.5 Document version / migration

- `CURRENT_SCHEMA_VERSION` 2 → **3**. Reader accepts 1, 2, 3. Migration 2→3: each legacy `Material` stays as is
  (no `recordId`); new optional sections `materialRecords`, `materialLibraries`, `aero` absent ⇒ empty.
- `validateMaterialValue` accepts optional `recordId` (string, must reference an existing record or a declared
  private library stub). New `validateMaterialRecord` checks: units parse; `basis` enum; `preferred` uniqueness;
  temperature points strictly increasing; licence/marking enums.
- Saved v3 files never contain values of `storage: 'private'` libraries (TR-MAT-31; fuzz VC-MAT-14).

## 4. Commands

All pure (`(doc, params, ctx) → CommandResult`), zod `params`, `snake_case`. Query commands carry
`annotations: { readOnly: true }` and return `data`. Mutating ones append a FeatureStep.

### 4.1 Core — materials (`commands/document/`)

| Command | Kind | Params sketch | Tags |
| ------- | ---- | ------------- | ---- |
| `create_material` (extended, backward compatible) | mutating | existing + `density?: number` OR `densityQuantity?: {value, unit}`; `recordId?` | `@affects materials[name]` `@invariant legacy call ⇒ identical output to today` `@failure unit not a density ⇒ no-op` |
| `define_material_record` | mutating | `{ id, name, designation, temper?, productForm?, specs[], licence, exportMarking }` | `@affects materialRecords[id]` `@failure duplicate id without replace:true ⇒ no-op` |
| `set_material_property` | mutating | `{ material, property, value, unit, basis, direction?, thickness?, edOverD?, temperature?, source: {citation, locator?, accessed?, url?}, preferred? }` | `@affects materialRecords[m].properties` `@invariant one preferred per key` `@failure unit dimension mismatch (e.g. MPa for density) / basis missing ⇒ no-op` |
| `import_material_library` | mutating | `{ library: MaterialLibrary } \| { libraryId, version, sha256 }` (private: resolved via `ctx.libraries`) | `@affects materialLibraries, materialRecords (embedded only)` `@failure hash mismatch / schema error / licence=licensed-no-redistribution with storage=embedded and no override ⇒ no-op` |
| `remove_material_library` | mutating | `{ libraryId }` | `@failure records still assigned ⇒ no-op listing entities` |
| `resolve_material_libraries` | mutating, session (not in `featureHistory`, never serialized) | `{}` (uses `ctx.libraries`) | `@affects materialRecords of private libraries` `@invariant fills only on exact sha256 match; never changes a value of an embedded record` `@failure provider/library missing or hash mismatch ⇒ records stay unresolved with reason` (§3.2, TR-MAT-16) |
| `assign_material` (extended) | mutating | existing; `materialName` may be a record id (auto-creates render view) | unchanged invariants |
| `get_material` | query | `{ material }` | returns record + resolved preferred values + markings |
| `get_material_allowable` | query | `{ material, property, direction?, basis, thickness?, thicknessUnit?, temperature?, temperatureUnit?, edOverD?, forCertification?: boolean }` | `@invariant never returns a different basis than requested; forCertification refuses superseded/typical` `@failure none matching ⇒ data.available=false + candidates[]` |
| `diff_material_libraries` | query | `{ a: {libraryId, version}, b: {...} }` | returns changed/added/removed PropertyValues |
| `mass_properties` (fixed) | query | unchanged + `massUnit?: 'g'\|'kg'\|'lb'` | `@invariant mass unit correct for doc units & density unit`; data adds `densitySource`, `densityQuantity` |

### 4.2 Plugin `@aero` — fasteners (toolset `fasteners`)

| Command | Kind | Params sketch | Tags |
| ------- | ---- | ------------- | ---- |
| `import_fastener_catalog` | mutating | `{ catalog: FastenerCatalogFile } \| { libraryId, version, sha256 }` | `@failure grammar invalid / unit errors / missing provenance ⇒ no-op` |
| `list_fastener_families` | query | `{ kind? }` | families, sizes, licence |
| `decode_part_number` | query | `{ partNumber }` | fields (family, diameter, grip, material code); `@failure no grammar matches ⇒ data.matches=[]` |
| `select_fastener` | query | `{ family, diameterDash, stack?: number, stackUnit?, stackIds?: string[], axisPoint?, axis?, nut?, washer?, washerSide?: 'nut'\|'head', maxWasherTotal?: Quantity }` | `@invariant algorithm §5.2`; `@failure out of range / protrusion short / washer total > max ⇒ data.ok=false, reasons[]` |
| `insert_fastener_stack` | mutating, `requiresKernel` | `{ selection \| (select_fastener params), holeMode: 'cut_close_tolerance'\|'cut_clearance'\|'none', holeDiameter? }` | `@affects plates (boolean cut), components (one per part number, created once), instances (fastener, washers, nut), aero.stacks` `@invariant one step; undo restores exactly; ids step-scoped` `@failure selection not ok ⇒ no-op (reasons)`; kernel missing ⇒ no-op |
| `insert_fastener_row` | mutating, `requiresKernel` | `{ from: Vec3, to: Vec3 \| path, pitch \| count, edgeDistance?, ...select params, allowViolations?: boolean }` | `@failure pitch < 3D or edge < 2D (rivets; bolts: catalogue/company rule) ⇒ no-op unless allowViolations (then warnings)` |
| `check_fastener_layout` | query | `{ stackIds? }` | edge distance / pitch / grip consistency after upstream edits (stack thickness changed ⇒ flag "regrip") |
| `joint_capacity` (V2) | query | `{ stackId, sheetMaterial, basis }` | single shear & bearing with basis propagation |

Derivation guard: fastener instances and hole cuts created by a stack are **plugin-owned** (`guards`): direct
`delete_entities` on a fastener instance is redirected to `delete_fastener_stack` semantics (or refused with a
hint), so BOM and stack data never diverge (L8 derivation guards).

### 4.3 BOM (`bill_of_materials`, core, backward compatible)

`params: { includeStandardParts?: boolean (default true when any partRef exists), includeMaterials?: boolean }`.
`data` keeps `rows/totalInstances/distinctComponents` and adds `standardParts: { partNumber, family, description?, count, unitMass?, totalMass? }[]`
and `materials: { materialId, specs, productForm?, solidCount, totalVolume, totalMass, massUnit }[]`.

## 5. Kernel / algorithms

### 5.1 Units (`lib/quantity.ts`)

- Base: mm, g, s, K; exact factors: in = 25.4 mm, ft = 304.8 mm, lb = 453.59237 g, lbf = 4.4482216152605 N,
  psi = lbf/in², ksi = 1000 psi, MPa = N/mm²; °F→K: (T+459.67)·5/9 (affine; percentOfRT tables stay
  in their own unit).
- Parse unit strings `g/cm^3`, `lb/in^3`, `kg/m^3`, `ksi`, `MPa`, `GPa`, `Msi`, `%`, `-`; dimension vectors checked
  (density = M·L⁻³). Conversions are pure multiplicative except temperature.
- Expected: 1 lb/in³ = 27.679904710 g/cm³ (453.59237 / 16.387064), VC-MAT-03.

### 5.2 Grip / length selection (`@aero/fasteners/selectFastener.ts`)

Inputs: stack `t` (document units → catalogue unit), family F, size S, washer family W (thickness set
`{w_i}`), nut N (height max `h_n`), `maxWasher` (default 1/8 in, AC 43.13-1B 7-37).

1. **min_grip_ge_stack** (NAS/AN bolts): `g = max(gMin, ceil(t / Δg − ε))`, ε = 1e-9·t to absorb float noise.
   If `g > gMax` ⇒ fail `stack exceeds largest grip`.
   **max_grip_range** (Hi-Lok): `g = ceil(16·t − ε)`; covered range `((g−1)/16, g/16]`.
2. Grip value `G = g·Δg`; gap `δ = G − t` (≥ 0).
3. Washers: smallest-cardinality multiset of `{w_i}` (≤ 3 washers) with `Σ ≥ δ` and `Σ ≤ maxWasher`; ties → smallest Σ.
   None ⇒ fail `cannot shim gap δ`. (δ = 0 ⇒ no washer unless user requests bearing washers, which then count in Σ
   and may force g−1: out of MVP.)
4. Length `L = G + threadLength(S)` (grip_plus_thread) — checked against catalogue checkpoints (VC-MAT-06).
5. Protrusion `p = L − t − Σ − h_n,max`; require `p ≥ 1/TPI` (≥ one full thread, AC 43.13-1B) when `h_n` known;
   else report `protrusion: unknown` (not a pass). **llull choices, not source text:** (a) AC 43.13-1B says "at least one
   thread" protrudes; llull reads that as one thread pitch beyond the nut's *maximum* height (conservative: a short nut only
   adds protrusion). (b) `L` is the catalogue length rounded to 0.001 in as distributors list it (0.5625 + 0.323 = 0.8855 →
   0.885), and `p` is computed from that rounded `L`, so it can be up to 0.0005 in below the unrounded value (0.124 vs 0.1245
   for NAS6203-9 on 0.510 in).
6. Rivets (stack_plus_k_d): `L_raw = t + 1.5·D`; `L = ceil(L_raw/step − ε)·step` (`round:'up'` default; `'nearest'`
   selectable, OQ-MAT-04); report shop head ≥ 1.5D × 0.5D, edge ≥ 2D, pitch ≥ 3D.

Complexity O(|W|³) per selection (|W| ≤ 8) — negligible.

### 5.3 Stack measurement

Axis ray `o + s·d`. For each selected solid compute entry/exit parameters; sort; merge contiguous intervals
(gap ≤ `contactTol` = 1e-4 in / 0.0025 mm ⇒ same stack; larger gap ⇒ `fail: gap between layers`). `t = s_exit,last − s_entry,first`.
Exact (OCC) solids: intersect with each face (`BRepIntCurveSurface_Inter`), classify. Boxes/cylinders: closed form.
Non-perpendicular axis vs face normal > 2° ⇒ warning (countersink/angled-surface fasteners out of MVP).

### 5.4 Fastener geometry

Revolve profile from dims (nominal = midpoint of min/max when only range is known; flagged). Hex head: extrude
hexagon (across flats) ∩ chamfer cone. Thread not modelled (cosmetic: gap 07 thread feature). Unknown dims ⇒
`representative: true` proportions (head Ø = 2D, head h = 0.5D) **excluded from mass** unless `allowRepresentativeMass`.

### 5.5 Temperature interpolation

Linear in T between bracketing points; outside [T_min, T_max] ⇒ `available:false, reason:'out of tabulated range'`
(no extrapolation). `percentOfRT` multiplies the RT value of the same key (basis preserved, provenance list = both).

### 5.6 Basis propagation (V2 joint capacity)

Bases are **not a total order** (S carries no statistical assurance and is not comparable with A or B). Result
basis = A only if all inputs are A; B if all ∈ {A, B}; otherwise `mixed` with the per-input list. Never upgraded.

### 5.7 Numerical tolerances

| Quantity | Tolerance |
| -------- | --------- |
| Unit conversion | rel 1e-12 (exact factors) |
| Mass, exact OCC / closed form | rel 1e-6 |
| Mass, mesh fallback | rel 5e-3 (display tessellation, see `solidVolume.ts` note ~1 %) — flagged `method:'mesh'` |
| Grip arithmetic | exact rationals (1/16, 1/32) — implement with integer sixteenths/32nds |
| Stack measurement | 1e-6 in (exact), contact tol 1e-4 in |

## 6. Interop & persistence

### 6.1 Files

| File | Schema | Notes |
| ---- | ------ | ----- |
| `*.llull-matlib.json` | `MaterialLibrary` (§3.2) | Import/export; JSON Schema generated from zod (`toJSONSchema`) and published in `docs/schemas/` |
| `*.llull-fastcat.json` | `FastenerCatalogFile { format:'llull-fastener-catalog', schemaVersion:1, families[], nuts, washers, installationRules, licence }` | Sample: `validation/fastener_catalog_sample.json` (draft v0.1) |
| `sources.lock.json` | `{ sourceId: { url, sha256, size, retrieved } }` | Primary-source pinning for the seed library |
| BOM CSV | `export_bom_csv` (V1; core `exchange`) | columns: level, partNumber, description, qty, material, spec, mass, massUnit |

### 6.2 STEP / AP242

Material name + density can be written as STEP `material_designation` / property definitions on export (gap 04
XCH owns AP242 mapping). Fastener instances export as assembly occurrences named by part number (existing
component export path). No allowables in STEP.

### 6.3 Seed library policy

- `packages/domain-aero/data/seed-mil-hdbk-5j.llull-matlib.json`: **only** values re-read from the primary
  MIL-HDBK-5J PDF (hash in `sources.lock.json`), each with table locator; `licence: public-domain-us-gov`;
  `superseded: { by: 'MMPDS', note: 'cancelled 2003; use current MMPDS for certification' }`.
- Typical-value materials (MatWeb/AA) may appear only with `basis: 'typical'` and are excluded from
  `forCertification` queries. MatWeb terms of use must be checked before bundling (OQ-MAT-06) — until then they
  stay in the validation folder only.
- Fastener sample catalogue ships **encoding rules + distributor-published facts**, `licence: 'vendor-catalogue'`,
  after legal review (OQ-MAT-01).

## 7. UI / CLI / MCP surfaces

- **UI** (`src/ui/panels/MaterialsPanel`, `FastenersPanel`; param-gathering only): library list with licence and
  marking badges; record inspector with property table (filter by basis/direction/thickness), provenance popover;
  fastener insert dialog with live `select_fastener` preview (read-only dispatch) and a confirm that dispatches
  `insert_fastener_stack`; BOM panel sections.
- **CLI**: no new verbs — `llull exec <command> <json>` and `llull run <plan.json>` (`build_project`) cover everything; add
  `llull libraries list|add|remove` as thin wrappers over `ctx.libraries` provider in `server/src/cli` (host-only
  file management, not document mutation).
- **MCP**: new toolset `materials` (`get_material get_material_allowable diff_material_libraries define_material_record set_material_property import_material_library remove_material_library resolve_material_libraries create_material assign_material`).
  `create_material` and `assign_material` **move** out of `3d` (one toolset per command, the `toolsets.ts` invariant);
  `search_tools` still finds them from any toolset. `TOOLSET_NAMES` gains `materials` and `fasteners`; toolset `fasteners` comes from
  the plugin. Private library values are returned to MCP clients only if the library's licence allows
  (`licensed-no-redistribution` ⇒ values returned to local desktop CLI only; cloud MCP gets
  `redacted:true` + basis/locator) — TR-MAT-32.
- **Export gate**: `export_step*`, `export_gltf`, `save/share`, live-sync to a non-loopback server consult
  `exportGate(doc, target)`; ITAR/EAR-marked content ⇒ desktop: confirmation summary; cloud: refusal with reason.

## 8. Performance & robustness budgets

| Operation | Budget (desktop, OCC, mid laptop) |
| --------- | ------------------------------ |
| `select_fastener` (numeric stack) | ≤ 1 ms |
| `select_fastener` (2 exact solids, ray) | ≤ 20 ms |
| `insert_fastener_stack` (first of a part number: build component) | ≤ 300 ms |
| `insert_fastener_stack` (subsequent, cached component) | ≤ 60 ms incl. boolean cut on a ≤ 50-face plate |
| `insert_fastener_row` 100 fasteners, one plate pair | ≤ 10 s; hole cuts batched into one multi-tool boolean recipe node |
| Document growth per fastener instance | ≤ 1 KB (instance + stack record), component shared |
| Library import 1,000 records × 50 properties | ≤ 2 s, validation errors listed with JSON pointers |
| `mass_properties` on assembly with 10⁴ fastener instances | ≤ 1 s (unit mass per component cached by recipeKey) |

Robustness: every failure is a no-op with summary + `data.reasons[]` (never throw); private-library absence
degrades with explicit warnings; replay with changed library hash ⇒ step warning "library changed since step k".

## 9. Test strategy (→ VC ids in validation/README.md)

| Level | Location | Covers |
| ----- | -------- | ------ |
| Unit (core) | `tests/unit/materials/*.test.ts` | quantity parsing/conversion (VC-MAT-03), record validation, preferred uniqueness, allowable query incl. basis refusal (VC-MAT-05), temperature interpolation (VC-MAT-16), legacy load (VC-MAT-01), multi-source (VC-MAT-02), library diff (VC-MAT-13), `is pure` for each mutating command |
| Unit (mass) | `tests/unit/inspect/massProperties.units.test.ts` | VC-MAT-04 table from `validation/expected_results.json` (closed-form primitives; OCC in server suite) |
| Unit (plugin) | `tests/unit/aero/fasteners/*.test.ts` | grammar decode, catalogue checkpoints (VC-MAT-06), grip selection (VC-MAT-07/08/09) driven by `expected_results.json` |
| Contract | `tests/unit/contract/` | toolset membership, `toToolSchemas()` snapshot, plugin install, derivation guard on fastener instances, persistence v3 round-trip, private-library non-serialization fuzz (VC-MAT-14) |
| Golden | `tests/golden/plans.ts` | `mass_7075_block_current` (exists today: 140.5 g), `fastener_stack_nas6203` (VC-MAT-10/11), id-normalized + replay equality |
| Server (OCC) | `server/tests/aeroFasteners.occt.test.ts` | exact hole cut volume = plate − πr²t (rel 1e-6), stack measurement on exact solids, mass rel 1e-6 |
| Integration | `tests/integration/` | dispatch insert → undo → redo; export gate on ITAR marking (VC-MAT-15) |
| Quality gate | `npm run quality` | `validation/generate_mat_reference.py --check` (expected JSON fresh) |
| Production gate | `docs/PRODUCTION_GATE.md` scenario | "bracket splice": 2 plates, 8 NAS6204 stacks, BOM matches expected rows, mass in lb & kg |

## 10. Delivery plan

| Milestone | Content | Depends on | Effort |
| --------- | ------- | ---------- | ------ |
| M1 Units + mass fix | `lib/quantity.ts`, `mass_properties` unit-correct output, `create_material` density quantity | — | 3 d |
| M2 Material records | model, commands, persistence v3, allowable query, provenance, legacy migration | M1 | 8 d |
| M3 Libraries & IP | import/export, `ctx.libraries` provider (server fs + browser IndexedDB), licence/marking flags, export gate | M2; gap 09 marking semantics | 6 d |
| M4 Seed library | re-verify MIL-HDBK-5J values from primary PDF, `sources.lock.json`, ~10 materials | M2; human access to PDF | 4 d |
| M5 Fastener catalogue + select | `@aero` package scaffolding (aliases, arch rules, knip), catalogue model, decode, `select_fastener` | M1 | 7 d |
| M6 Stack insertion | geometry generation, hole cut, components/instances, guards, BOM rows | M5; gap 01 KRN (OCC default), gap 07 FTR (hole feature, optional) | 8 d |
| M7 Rows + layout check | `insert_fastener_row`, `check_fastener_layout` | M6 | 5 d |
| M8 Temperature + diff | temperature tables, `diff_material_libraries` | M2 | 3 d |
| M9 V2 joint hook | `joint_capacity`, gap 05 hand-off | M6, gap 05 | 5 d |

Total MVP (M1–M5) ≈ 28 d; V1 (M6–M8) ≈ 16 d.

## 11. Open questions / decisions needed

| Id | Question | Proposed default |
| -- | -------- | ---------------- |
| OQ-MAT-01 | Legal review: may llull ship a sample catalogue with distributor-published NAS/MS dimensions? | Ship encoding rules only; dimensions user-imported until cleared |
| OQ-MAT-02 | S-basis semantics: MMPDS text (S3) says S applies where T99 fails A-basis requirements; common usage = spec minimum. | Store as given; display "S (specification minimum / no statistical assurance)"; never treat S ≥ A |
| OQ-MAT-03 | New package `domain-aero` vs folder inside `domain-aec`? | New package (AEC and aero toolsets differ; clean knip/arch boundaries) |
| OQ-MAT-04 | Rivet length rounding: "nearest 1/16" (S19 secondary) vs "up". | `up` (conservative: protrusion ≥ 1.5D); configurable |
| OQ-MAT-05 | AN bolt dash: total length (1/8 in) or grip code? Sources disagree. | Do not ship AN rules until read from the NASM/AN sheet |
| OQ-MAT-06 | Can MatWeb typical values be bundled (terms of use)? | No; validation folder only |
| OQ-MAT-07 | Private library values to cloud MCP: redact always, or per-library opt-in? | Redact by default; opt-in flag per library |
| OQ-MAT-08 | Bearing washers under bolt head (always required by some company standards) — model as mandatory washer counted in grip? | V1 option `headWasher: partNumber` included in Σ before gap |

## 12. References

See FUNCTIONAL_SPEC §11 [R1]–[R28] and `validation/sources.md` [S1]–[S40]. Additionally:

- [T1] KI5 — The kernel boundary is a shape, not a mesh — llull — `docs/decisions/KI5-shape-kernel-boundary.md`
- [T2] KI6 — Desktop app (Electron); local agents use the CLI — llull — `docs/decisions/KI6-desktop-app-cli-first.md`
- [T3] AC 43.13-1B Chapter 7 (bolts: grip, washers ≤ 1/8 in, thread protrusion) — FAA — https://www.faa.gov/sites/faa.gov/files/2023-08/AC_43.13-1B_Ch7.pdf (accessed 2026-10)
- [T4] NAS6203…NAS6206 thread-length/grip rule — Airfasco — https://airfasco.com/products/NAS/NAS6203THRUNAS6220/NAS6204.php (accessed 2026-10)
- [T5] MMPDS design allowables definitions — Battelle — https://www.mmpds.org/wp-content/uploads/2015/03/mmpds_2015_2007aeromat_presentation.pdf (accessed 2026-10)
- [T6] NASA RP-1228 Fastener Design Manual — NASA NTRS — https://ntrs.nasa.gov/citations/19900009424 (accessed 2026-10)
- [T7] Open CASCADE Technology reference — `BRepIntCurveSurface_Inter`, `IntCurvesFace_ShapeIntersector` — https://dev.opencascade.org/doc/refman/html/ (not fetched in this session; class names from OCCT public API — verify against the bundled opencascade.js build)
