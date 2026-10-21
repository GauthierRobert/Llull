# FE pipeline for PHY-03 / PHY-04 — implementation design (2026-10-16)

Owner decision (2026-10-16): build the minimal 05 FEA slice that the thermal packs need, and the blocked PHY-03 / PHY-04
milestones on top of it. This note fixes the placement and the interfaces shared by the work lanes. Specs stay authoritative
for behaviour: `docs/aerospace/05-fea-cae-handoff/TECHNICAL_SPEC.md` (05), `docs/physics/03-thermal-analysis/TECHNICAL_SPEC.md`
(PHY-03), `docs/physics/04-thermo-mechanical/TECHNICAL_SPEC.md` (PHY-04).

## 1. Placement

| Concern | Where | Spec reference |
| ------- | ----- | -------------- |
| Shared analysis data types (05 §3 subset + PHY-03 §3.1 + PHY-04 §3.1), artifact read types, ports | `packages/core/src/model/analysis.ts` (+ `analysisThermal.ts`, `analysisThermomech.ts` if size requires) | 05 TR-FEA-02, PHY-03 §2.1 (both proposals) |
| Ports on `ExecutionContext` | `feaArtifacts?: FeArtifactPort \| null`, `humanSignature?: HumanSignaturePort \| null` (types in `model/analysis.ts`, fields in `commands/types.ts`) | 05 §4.1, TR-FEA-91 |
| 05 slice (set-up commands, deck writer, FRD/DAT readers, summarisers, record commands, report/check) | new plugin package `packages/domain-cae` (`@cae/*`), `CadPlugin { name: 'cae', toolset: 'analysis' }` | 05 §2 |
| Thermal FE discipline | `packages/domain-cae/src/thermal/` (Proposal **B** of PHY-03 §2.1: discipline inside `domain-cae`) | PHY-03 §2.1 |
| Thermo-mechanical FE discipline | `packages/domain-cae/src/thermomech/` (same) | PHY-04 §2 |
| Pure physics queries already built | unchanged in core (`commands/thermal`, `commands/thermomech`, `commands/materiallab`) | §13 of each pack |
| Meshing (Gmsh 4.15.2 Python API), solving (`ccx`), artifact store | `server/` (`server/python/llull_bridge.py` op `mesh`, `server/src/fea/*`), CLI verbs | 05 §5.4, §5.9 |

Why Proposal B: no package may import another package (`plugins-and-kernels-depend-on-core-only`) and the physics FE parts must
call the 05 deck writer and readers; inside one package they compose by plain imports, with no new core extension port.

## 2. Data flow

```
create_analysis (heat_steady | heat_transient | thermo_static | static) ─┐ set-up commands record the definition
add_fea_constraint / add_fea_load / set_mesh_controls / add_thermal_bc …  ├─ in doc.analysis.cases[id] (pure, feature steps)
set_reference_temperature / set_temperature_field …                       ┘
        │
  ✱ fea_mesh  (server): export the analysed solids to STEP (ctx.kernel.exportStep, OCC) → bridge op `mesh` (Gmsh):
              tet mesh + target resolution (facesNear / pointsNear → nearest Gmsh surface / node by closest point)
              → FeMeshArtifact JSON → FeArtifactStore (sha256) → dispatch record_fe_mesh { analysisId, summary }
  ✱ fea_solve (server): writeInp(doc, case, mesh) (pure @cae) → `ccx -i job` → parseFrd / parseDat (pure @cae)
              → FeResultsArtifact JSON → store → dispatch record_fea_results { analysisId, summary }
  queries:   analysis_report, check_analysis, analysis_report, check_thermal, check_temperature_limits, check_thermo_mechanical,
             thermal_distortion_report read the summaries, and the artifacts through ctx.feaArtifacts when they need arrays.
```

`record_fe_mesh` / `record_fea_results` are trusted only after re-reading the artifact through `ctx.feaArtifacts`, checking its
sha256 and recomputing the summary with the same pure summariser (05 §4.1). No port or no artifact ⇒ no-op with a code.

## 3. Shared interfaces (lanes code against these)

```ts
// core model/analysis.ts (read-only artifact shapes; JSON-serialisable, no typed arrays)
export interface FeMeshArtifact {
  readonly kind: 'fe_mesh'; readonly unitSystem: UnitSystem; readonly mesher: string; readonly mesherVersion: string;
  readonly inputHash: string;
  readonly nodes: readonly (readonly [id: number, x: number, y: number, z: number])[];       // ids 1..n
  readonly blocks: readonly { readonly type: FeElementType; readonly entityId: EntityId; readonly elements: readonly (readonly number[])[] }[]; // [elementId, n1, n2, …]
  readonly nodeSets: Readonly<Record<string /* target key */, readonly number[]>>;
  readonly faceSets: Readonly<Record<string /* target key */, readonly (readonly [elementId: number, face: number])[]>>;  // CalculiX face label 1..6
  readonly targets: Readonly<Record<string, { readonly residual: number }>>;              // resolution residual per target key
}
export interface FeResultsArtifact {
  readonly kind: 'fe_results'; readonly meshHash: string; readonly inputHash: string; readonly solver: string; readonly solverVersion: string;
  readonly steps: readonly {
    readonly step: number; readonly time: number;
    readonly fields: Readonly<Record<'DISP' | 'STRESS' | 'NDTEMP' | 'FLUX' | 'RFL' | 'TOSTRAIN' | string, {
      readonly components: readonly string[]; readonly values: Readonly<Record<string /* node id */, readonly number[]>> }>>;
  }[];
  readonly dat?: { readonly tables: readonly { readonly title: string; readonly time: number; readonly rows: readonly (readonly number[])[] }[] };
}
export interface FeArtifactPort { get(hash: string): FeMeshArtifact | FeResultsArtifact | null }   // sync read (server: disk cache)
export interface HumanSignaturePort { verify(signature: unknown, payloadSha256: string): { readonly signer: string; readonly signatureId: string } | null }
```

Target keys: `C_<constraintId>`, `L_<loadId>`, `B_<thermalBcId>`, `R_<refinementIndex>`, `P_<probeId>`, `T_<limitId>` (ids made safe for
CalculiX set names by the writer). Hashes: `sha256Hex(canonicalJson(artifact))` (`lib/sha256`, `lib/canonicalJson`).

`@cae` pure functions used by the server transports:

```ts
writeInp(doc: CadDocument, analysisId: string, mesh: FeMeshArtifact): { text: string } | { code: string; message: string }
parseFrd(text: string): FeResultsArtifact['steps'];       parseDat(text: string): NonNullable<FeResultsArtifact['dat']>
meshSummary(mesh, meshHash): MeshSummary;                 resultsSummary(doc, analysisId, mesh, results, resultsHash): ResultsSummary
analysisInputHash(doc, analysisId, scope: 'mesh' | 'full'): string
meshRequest(doc, analysisId): { entityIds, targets: [{ key, entityId, facesNear?, pointsNear? }], controls }   // for the bridge
```

`writeInp` dispatches on `analysisType`: model block (05: nodes, elements, sets, `*SOLID SECTION`, materials) + discipline sections
(05 static, `thermal/deck.ts` for `heat_*`, `thermomech/deck.ts` for `thermo_static`). Materials come from the document `Material`:
mechanical E, ν from the PHY-02 constitutive set (`elastic_isotropic`) or from PHY-01 property models `E` / `nu`; thermal k, cp,
density from PHY-01 models (tabulated over the case temperature range) or `Material.density`; CTE per PHY-04 §3.3.

## 4. Scope boundaries

Built: solid idealization only (tet C3D4 / C3D10); static, heat_steady, heat_transient, thermo_static; constraints fixed / pinned /
displacement / symmetry (planar); loads force / pressure / gravity; thermal BCs of PHY-03 §3.1; PHY-04 field sources uniform /
expression / thermal_result (same mesh) / table. Not built (stay in the 05 backlog): modal, buckling, shells, plane stress,
midsurface, defeature, Nastran BDF, OP2, `dispose_margin`, quality port beyond Gmsh's own metrics,
UI panels, cavity radiation deck and contact conductance (PHY-03 V1: see its §13). Built since this note (PHY-04 TECHNICAL_SPEC §14):
`compute_margins`, `fea_import_field`, the steady coupled procedure and mesh mapping, and bonded multi-part meshes (`set_mesh_controls bonding: 'conformal'`: all
parts fragmented in one Gmsh model so touching parts share interface nodes, STEP only; 05 TECHNICAL_SPEC §13).
Human gates (`dispose_thermal_limit`, `dispose_fit_result`) verify through `ctx.humanSignature`; no implementation is installed
(09 PLM is not built), so every call is refused with the `*_HUMAN_GATE` code, which is the specified agent-path behaviour.

## 5. Deck and summary contract between the 05 core and the disciplines (Phase 2)

Owned by the 05 lane (`packages/domain-cae/src/decks/`, `src/results/`); the thermal and thermo-mechanical lanes implement the
discipline functions against exactly these types.

```ts
// @cae/decks/context.ts
export interface DeckContext {
  readonly doc: CadDocument; readonly analysisId: string; readonly analysis: AnalysisCase; readonly mesh: FeMeshArtifact;
  readonly unitSystem: UnitSystem;
  readonly lengthToAnalysis: number;                       // document length unit -> analysis length unit
  readonly nset: (targetKey: string) => string;           // NSET name already written by the model block for that key
  readonly faces: (targetKey: string) => readonly (readonly [elementId: number, face: number])[];   // mesh.faceSets[key] ?? []
  readonly elset: (entityId: string) => string;           // ELSET of a part, e.g. P_box_1_1
  readonly materialName: (entityId: string) => string;    // *MATERIAL name used by the part's *SOLID SECTION
  readonly materialOf: (entityId: string) => Material | null;
}
export type DeckSections = { readonly text: string } | { readonly code: string; readonly message: string; readonly ids?: readonly string[] };
```

`writeInp` order: header comment → `*NODE` → `*ELEMENT` per part block → `*NSET` for every keyed target (nodeSets) →
material cards (one `*MATERIAL` per used material: static → 05 mechanical cards; `heat_*` → `thermalMaterialCards(ctx)`;
`thermo_static` → 05 mechanical cards **and** `thermomechMaterialCards(ctx)` appended inside each material) → `*SOLID SECTION`
per part → step sections (static → 05 `staticStep(ctx)`; `heat_*` → `thermalSections(ctx)`; `thermo_static` →
`thermomechSections(ctx)`, which calls the exported 05 helper `mechanicalStepLines(ctx)` for `*BOUNDARY` / `*CLOAD` / `*DLOAD`).

| Module | Exports (exact names) |
| ------ | --------------------- |
| `@cae/decks/inpWriter.ts` (05) | `writeInp(doc, analysisId, mesh): { text } \| { code, message }` |
| `@cae/decks/mechanical.ts` (05) | `mechanicalMaterialLines(ctx, entityId): DeckSections`, `mechanicalStepLines(ctx): DeckSections`, `staticStep(ctx): DeckSections` |
| `@cae/thermal/deck.ts` (thermal) | `thermalMaterialCards(ctx, entityId): DeckSections` (k, cp, density lines under the open `*MATERIAL`), `thermalSections(ctx): DeckSections` (initial conditions, amplitudes, physical constants, step) |
| `@cae/thermomech/deck.ts` (thermomech) | `thermomechMaterialCards(ctx, entityId): DeckSections` (`*EXPANSION, ZERO=`), `thermomechSections(ctx): DeckSections` (initial conditions, step with `*TEMPERATURE`) |
| `@cae/results/frdReader.ts`, `datReader.ts` (05) | `parseFrd(text)`, `parseDat(text)` |
| `@cae/results/summary.ts` (05) | `meshSummary(mesh, meshHash)`, `resultsSummary(doc, analysisId, mesh, results, resultsHash)` — dispatches `heat_*` to `thermalResultsSummary` |
| `@cae/thermal/summary.ts` (thermal) | `thermalResultsSummary(doc, analysisId, mesh, results): ThermalResultsSummary` (§5.5 balance, probes, extremes) |

Field names in `FeResultsArtifact.steps[].fields`: the FRD block names (`DISP`, `STRESS`, `TOSTRAIN`, `NDTEMP`, `FLUX`, `RFL`), components as
written by CalculiX. Element faces use the CalculiX labels (tet: 1 = 1-2-3, 2 = 1-4-2, 3 = 2-4-3, 4 = 3-4-1). Gmsh tet10 node order
differs from CalculiX C3D10: the mesher swaps the last two mid-edge nodes (Gmsh 3-4 / 2-4 edges → CalculiX 2-4 / 3-4) so the artifact
is already in CalculiX order.
