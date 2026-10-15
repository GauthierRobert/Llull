# XCH — Aerospace data exchange (AP242, IGES, JT, QIF, LOTAR) — Technical specification

Gap id: **XCH** · Companion of [`FUNCTIONAL_SPEC.md`](FUNCTIONAL_SPEC.md) · Validation: [`validation/README.md`](validation/README.md)
· References [Rn] are listed in §12 (same numbering as the functional spec).

## 1. Current state in llull

| Area | Where | What it does | Limit for aerospace |
| ---- | ----- | ------------ | ------------------- |
| Exact STEP export | `packages/core/src/commands/brep/topology.ts` `export_step_exact` (read-only, `requiresKernel`) → `GeometryKernel.exportStep(shapes)` (`packages/core/src/geometry/kernel.ts`) → `packages/kernel-occt/src/occtStep.ts` `writeStep` (`STEPControl_Writer`, `STEPControl_AsIs`) | One STEP product per solid, AP214 (OCC default schema), Emscripten FS scratch path `/out.step` | AP214 only; no XCAF document so no assembly, no GVP, no PMI, no layers/materials; `instance` entities skipped ("explode_instance first") |
| Names/colours | `packages/core/src/commands/brep/stepLabels.ts` `labelStep` | Regex rewrite of `PRODUCT('Open CASCADE STEP translator …')` and appended `STYLED_ITEM` colour chain | Text-level patching; fragile across OCC versions; not extensible to GVP/PMI (needs entity graph, not regex) |
| STEP export (code path) | `packages/mcp/src/exchangeTools.ts` `export_step` → Python `server/python/llull_bridge.py` `_export_step` (CadQuery) | Exports the generated CadQuery program as STEP AP214 | Host-level tool (not a registry command); AP214; meshes for non-analytic features |
| STEP import | `exchangeTools.ts` `import_step` → bridge `op_import_step` (`cq.Assembly.importStep`, then `_triangles`) → `import_mesh` | One mesh entity per solid with world placement, name, colour | Exact B-rep lost; assembly flattened; GVP and PMI ignored (gap 01 KRN owns STEP → B-rep) |
| Mesh/visual exports | `packages/core/src/commands/exchange/{exportStl,exportFormats,exportGltf}.ts` | STL, OBJ, glTF from display meshes | Visualization only |
| DXF / DWG | `exchange/importDxf.ts`; `import_dwg` host tool with external converter | 2D | n/a (pattern reused for JT converter) |
| Mass properties | `packages/core/src/commands/inspect/measureSolid.ts` `mass_properties`; `ShapeTopology.volume` | Volume (exact with OCC for mesh results) and mass | **No surface area, no centroid** → cannot compute CAx-IF GVP today |
| Independent STEP reference | `quality/step_reference.py` (OCP: `STEPCAFControl_Reader`, `BRepGProp`, `BRepBndLib.AddOptimal_s`) | Quality-gate ground truth: solids, faces, area, volume, boxes, colours, names | Reads only; already the right shape for GVP recompute (reuse its algorithm) |
| Quality corpus | `quality/corpus.json` (AP214 assemblies, OCCT/FreeCAD/pythonocc samples, synthetic files) | Step-import gate | No AP242/PMI/GVP files, no IGES |
| Kernels | `packages/kernel-occt` uses `opencascade.js` **^1.1.1** (package-lock) in browser + server worker; desktop also bundles CPython + CadQuery/OCP (KI6) | Two OCC runtimes | Unknown whether the 1.1.1 build binds `STEPCAFControl_*`, `XCAFDoc_*`, `IGESControl_*`; must be verified (Q1) |

## 2. Target architecture

### 2.1 Layer placement (laws L1–L10)

```
src/ui (Import/Export dialogs, Validation badge, report table)      server/ + desktop/ (file I/O, converters, Python bridge)
        │ dispatch(name, params)                                           │ read file → params; write data → file
        ▼                                                                  ▼
packages/core/src/commands/exchange/   (Lane 1)                    packages/mcp/src/exchangeTools.ts (host tools: path/base64 plumbing only)
   export_step_ap242   import_step_exact   export_iges   import_iges
   verify_exchange_file (query)   geometric_validation_properties (query)
packages/<aero plugin>/src/exchange/   (domain: LOTAR, QIF)  create_archive_package / verify_archive_package / export_qif
        │ ctx.kernel (requiresKernel)
        ▼
GeometryKernel (core interface)  ── + exchange port methods (§2.3)
        ▼
packages/kernel-occt (opencascade.js custom build: TKDESTEP/TKXDESTEP/TKDEIGES/TKXCAF)    [target]
server/python/llull_bridge.py (OCP STEPCAFControl / IGESCAFControl)                       [interim, desktop-only]
```

- **L1/L5**: every capability is a `defineCommand` (snake_case) — no file I/O in core: commands take file **content**
  (`text` for STEP Part 21 / IGES, which are ASCII) and return file content in `data`. Hosts (`server/`, `desktop/`,
  CLI `file=` / `--save`) do the I/O, exactly like `export_step_exact` / `import_dxf` today.
- **L9**: STEP/IGES parsing and writing live behind the kernel interface (new methods §2.3). Core never parses
  Part 21 except the **independent verifier** (pure TypeScript port of `validation/extract_validation_properties.py`,
  in `packages/core/src/lib/step21/`), which reads embedded GVP and a census — deliberately *not* through OCC so the
  check is independent of the reader under test.
- **L10**: AP242/IGES are generic CAD exchange → core `exchange` catalog. LOTAR packaging and QIF are aerospace
  domain → a plugin (proposed `packages/domain-aero`, shared with gaps 03/09; Q4).
- **L3/L8**: imports are mutating commands producing entities with step-scoped ids; exports and checks are
  read-only queries (`annotations: { readOnly: true, requiresKernel: true }`), so they never enter the feature history.
- **L6/KI6**: offline on desktop; the server stays a thin host. No network access in any command.

### 2.2 Two runtimes, one contract

| Runtime | Where | Status | Use |
| ------- | ----- | ------ | --- |
| opencascade.js custom build with XDE toolkits | browser, server worker, desktop | target | All XCH commands as registry commands; offline in the browser too. Custom builds are a supported opencascade.js workflow (YAML list of bindings, e.g. `STEPCAFControl_Reader`, `XCAFDoc_ShapeTool`, `TDocStd_Document`) [R24]; an OCCT 8.0.1 WASM STEPCAF reader with `XCAFDoc_DimTolTool` exists (LGPL-2.1) [R26] |
| OCP (CadQuery) in bundled CPython | desktop app, server with `LLULL_PYTHON` | interim (MVP fallback) | Same operations implemented in `llull_bridge.py` (`op_export_xde`, `op_import_xde`, `op_gvp`); exposed through the host exchange tools while the WASM build lands. Same JSON contract as §2.3 so the swap is invisible to callers |

Decision needed (Q1): keep both (WASM primary, Python fallback) or Python-only on desktop. Recommendation: WASM
primary because it keeps XCH commands pure registry commands reachable from every caller (L1), with the Python path
as the escape hatch for features OCC-WASM cannot do in time (e.g. GD&T export).

### 2.3 Kernel interface extension (core, `packages/core/src/geometry/kernel.ts`)

`exportStep(shapes)` stays for backwards compatibility. Add an **exchange port** (optional members; Manifold returns
`null`, as it does for `exportStep`):

```ts
export type StepSchema = 'ap242' | 'ap214' | 'ap203';
export type TessellationMode = 'off' | 'alongside' | 'only';

export interface MassProps {
  readonly volume: number;                 // document units^3; 0 for open shells
  readonly area: number;                   // sum of face areas, document units^2
  readonly centroid: Vec3;                 // volume centroid (solids) or area centroid (shells)
  readonly bbox: readonly [number, number, number, number, number, number]; // optimal box (BRepBndLib::AddOptimal)
}

/** XDE-like tree handed to the writer: products own shapes, occurrences place products. */
export interface ExchangeProduct {
  readonly key: string;                    // stable: component id or entity id
  readonly name: string;
  readonly description?: string;
  readonly shapes: readonly ShapeHandle[];
  readonly color?: string;                 // #rrggbb
  readonly layer?: string;
  readonly material?: { readonly name: string; readonly density?: number };
  readonly writeValidationProperties: boolean;
}
export interface ExchangeOccurrence {
  readonly parent: string | null;          // product key; null = root
  readonly product: string;
  readonly name?: string;
  readonly placement: Mat4;                // column-major 4x4, rigid (no scale)
}
export interface ExchangeWriteRequest {
  readonly format: 'step' | 'iges';
  readonly schema?: StepSchema;            // step only
  readonly unit: DocumentUnit;
  readonly products: readonly ExchangeProduct[];
  readonly occurrences: readonly ExchangeOccurrence[];
  readonly tessellation?: TessellationMode;
  readonly pmi?: readonly ExchangePmi[];   // gap 03 objects, V1
  readonly header: { readonly fileName: string; readonly originatingSystem: string; readonly author?: string; readonly timestamp: string };
}
export interface ExchangeReadResult {
  readonly unit: DocumentUnit | 'unknown';
  readonly schemaName: string | null;
  readonly products: readonly (Omit<ExchangeProduct, 'shapes' | 'writeValidationProperties'> & {
    readonly shapes: readonly ShapeHandle[];
    readonly embeddedGvp?: readonly EmbeddedGvp[];
  })[];
  readonly occurrences: readonly ExchangeOccurrence[];
  readonly tessellated: readonly { readonly product: string; readonly mesh: MeshData }[];
  readonly pmi: readonly ExchangePmi[];    // V1
  readonly messages: readonly string[];    // untranslated entity types, healing notes
}

export interface GeometryKernel {
  // … existing members …
  massProperties?(shape: ShapeHandle): MassProps | null;
  writeExchange?(request: ExchangeWriteRequest): string | null;   // Part 21 / IGES text
  readExchange?(format: 'step' | 'iges', text: string, options: { sew: boolean; tessellated: boolean }): ExchangeReadResult | null;
}
```

Handles minted by `readExchange` carry an `import` recipe leaf (`ShapeRecipe` op `imported`, keyed by the file
sha256 + product key) so they re-evaluate after eviction (KI5 rule: a handle stays valid). This recipe leaf is
shared with gap 01 KRN (Q3) — XCH must not define a competing one.

### 2.4 Technical requirements

| Id | Prio | Requirement | FR | VC |
| -- | ---- | ----------- | -- | -- |
| TR-XCH-01 | MUST | `GeometryKernel.writeExchange` writes STEP with a selectable schema (AP242DIS / AP214IS / AP203 OCC values) through an XDE document; OCC kernel implements it, Manifold returns null | FR-XCH-01 | VC-XCH-01, -03 |
| TR-XCH-02 | MUST | `GeometryKernel.massProperties` returns volume, area, centroid, optimal bbox from the exact B-rep; mesh fallback (signed tetrahedra) flagged `method:'mesh'` | FR-XCH-02, -03 | VC-XCH-01 |
| TR-XCH-03 | MUST | No file I/O, network or clock in core commands: content in/out via params/`data`; host passes `sha256`, `timestamp` | FR-XCH-21, -22 | all |
| TR-XCH-04 | MUST | Output profile §6.1 (header, FILE_SCHEMA, one PRODUCT per component/free solid) | FR-XCH-01 | VC-XCH-03 |
| TR-XCH-05 | MUST | REAL values written with ≥ 15 significant digits; same document + timestamp ⇒ byte-identical file | FR-XCH-02 | VC-XCH-01, -03 |
| TR-XCH-06 | MUST | GVP (volume, surface area, centre point; bbox SHOULD; assembly GVP) written per CAx-IF GVP RP using XCAF validation attributes | FR-XCH-03 | VC-XCH-02 |
| TR-XCH-07 | MUST | Components ↔ PRODUCT, instances ↔ NEXT_ASSEMBLY_USAGE_OCCURRENCE with rigid placement; names, colours via XCAF (retire `stepLabels.ts` regex) | FR-XCH-04 | VC-XCH-04 |
| TR-XCH-08 | MUST | `readExchange` + `import_step_exact`: exact solids, assembly tree, provenance with embedded GVP, comparison bands §5.3, never blocking | FR-XCH-05, -06 | VC-XCH-05, -06 |
| TR-XCH-09 | SHOULD | Semantic PMI import mapping §5.4 with text-level magnitude cross-check; every census record mapped or reported | FR-XCH-07 | VC-XCH-07 |
| TR-XCH-10 | SHOULD | Semantic PMI export (schema forced to AP242) with graphic presentation | FR-XCH-08 | VC-XCH-08 |
| TR-XCH-11 | SHOULD | Tessellated read (`read.step.tessellated`=1/2) → mesh entities; write modes 'alongside'/'only' | FR-XCH-09 | VC-XCH-09 |
| TR-XCH-12 | MUST | IGES read with sewing at max(file resolution, 1e-6·diag) and untranslated-type census; IGES calls serialised | FR-XCH-10 | VC-XCH-10 |
| TR-XCH-13 | SHOULD | IGES 5.3 write, B-rep mode default, faces mode optional | FR-XCH-11 | VC-XCH-11 |
| TR-XCH-14 | MUST | Exact unit factors on import/export and on embedded GVP before comparison | FR-XCH-12 | VC-XCH-12 |
| TR-XCH-15 | SHOULD | Archive package layout §6.3; verify recomputes sha256 + GVP vs manifest | FR-XCH-13, -14 | VC-XCH-13 |
| TR-XCH-16 | MUST | Robustness budgets §8: size limit before parse, guarded OCC calls, WASM memory released, no throw out of a command | FR-XCH-15 | VC-XCH-14 |
| TR-XCH-17 | SHOULD | NIST SFA analysis of every llull-written AP242 gate file (0 syntax errors) | FR-XCH-18 | VC-XCH-17 |
| TR-XCH-18 | MUST | Independent pure-TS Part 21 reader (`packages/core/src/lib/step21/`): tokenizer, record map, GVP extraction, entity census — port of `validation/extract_validation_properties.py`, tested against its JSON output | FR-XCH-06, -18 | VC-XCH-02, -05, -07 |
| TR-XCH-19 | MUST | `export_step_exact` kept as an alias (AP214, flat, no GVP) so existing plans and tools are unchanged | FR-XCH-21 | VC-XCH-03 |

## 3. Data model

### 3.1 Additions (all optional → no migration of existing documents)

```ts
/** Where an imported product came from and what the sender claimed about it. */
export interface ImportProvenance {
  readonly format: 'step' | 'iges' | 'jt';
  readonly schemaName: string | null;            // e.g. 'AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF { 1 0 10303 442 3 1 4 }'
  readonly fileName: string;
  readonly sha256: string;                       // of the imported bytes (computed by the host, passed in params)
  readonly productName: string;
  readonly sourceUnit: DocumentUnit | 'unknown';
  readonly embeddedGvp?: readonly EmbeddedGvp[];
  readonly gvpCheck?: GvpCheck;                  // computed at import time, re-computable by verify
}

export interface EmbeddedGvp {
  readonly target: 'part' | 'solid' | 'assembly' | 'independent-surface' | 'independent-curve';
  readonly volume?: number;                      // converted to document units^3
  readonly area?: number;                        // 'surface area measure' | 'wetted area measure'
  readonly centroid?: Vec3;
  readonly bbox?: readonly [number, number, number, number, number, number];
  readonly placeholder: boolean;                 // all values 0 → not checkable
}

export type GvpBand = 'green' | 'yellow' | 'red' | 'not-checkable';
export interface GvpComparison {
  readonly property: 'volume' | 'area' | 'centroid' | 'bbox';
  readonly sender: number | Vec3;
  readonly receiver: number | Vec3;
  readonly delta: number;                        // relative for volume/area; absolute distance for centroid/bbox
  readonly band: GvpBand;
}
export interface GvpCheck { readonly band: GvpBand; readonly comparisons: readonly GvpComparison[]; readonly policy: GvpPolicy }
export interface GvpPolicy {
  readonly greenRel: number;                     // default 1e-3
  readonly yellowRel: number;                    // default 1e-2
  readonly greenCentroidPerDiag: number;         // default 1e-3 × bbox diagonal
  readonly yellowCentroidAbs: number;            // default 1 mm expressed in document units
}

export interface CadDocument {
  // … existing …
  /** Absent until the first import; keyed by entity id (part) or component id (assembly node). */
  exchange?: { readonly provenance: Record<string, ImportProvenance> };
}
```

- Products → `Component` (existing `doc.components`), occurrences → `InstanceEntity` (existing
  `insert_instance`), leaf solids → `mesh` entities with `brep` = imported recipe leaf (KI5).
- PMI → gap-03 model (`doc.pmi`, owned by 03). XCH defines only the mapping (§5.4).
- Ids: `stp-<step>.<k>` for imported entities, `comp-stp-<step>.<k>` for components (step-scoped, replay-stable, L8).
- Timestamp: commands never call `Date.now()`; hosts pass `timestamp` for export headers (deterministic tests).
- Document version: bump the persistence minor version; loading an older file needs no migration (fields optional).
  Snapshot/recipe validation (KI5) extends to the `imported` leaf: sha256 hex, product key string.

## 4. Commands

| Name | Kind | Toolset | Params (zod sketch) | data |
| ---- | ---- | ------- | ------------------- | ---- |
| `geometric_validation_properties` | query, `requiresKernel` | measure | `{ entityIds?: string[], includeAssemblies?: boolean }` | `{ unit, items: [{ id, name, volume, area, centroid, bbox, method:'brep'|'mesh' }], assemblies?: [...] }` |
| `export_step_ap242` | query, `requiresKernel` | exchange | `{ entityIds?: string[], schema?: 'ap242'|'ap214'|'ap203' (default 'ap242'), includeValidationProperties?: boolean (true), assembly?: 'structured'|'flat' ('structured'), tessellation?: 'off'|'alongside'|'only' ('off'), includePmi?: boolean (true), fileName?: string, timestamp?: string }` | `{ format:'step', schema, step, products, occurrences, gvp:[…], selfCheck: GvpCheck, skipped }` |
| `import_step_exact` | mutating, `requiresKernel` | exchange | `{ text: string, fileName?: string, sha256?: string, mode?: 'append'|'replace', sew?: boolean, tessellated?: boolean (true), verify?: boolean (true), gvpPolicy?: Partial<GvpPolicy> }` | `{ products, entities, components, gvpCheck, messages }` |
| `verify_exchange_file` | query (kernel optional) | exchange | `{ text: string, format?: 'step'|'iges', gvpPolicy?: … }` | `{ schemaName, unit, census, embeddedGvp, recomputed?: MassProps[], comparisons, band, messages }` — without a kernel: census + embedded GVP only |
| `export_iges` | query, `requiresKernel` | exchange | `{ entityIds?: string[], mode?: 'brep'|'faces' ('brep'), fileName?, timestamp? }` | `{ format:'iges', iges, solidCount, selfCheck }` |
| `import_iges` | mutating, `requiresKernel` | exchange | `{ text, fileName?, sha256?, sew?: boolean (true), mode? }` | `{ entities, openShells, untranslated: Record<type,count> }` |
| `create_archive_package` | query, `requiresKernel` | aero (plugin) | `{ entityIds?: string[], partNumber: string, revision: string, timestamp: string }` | `{ files: [{ name, text, sha256 }], manifest }` (host writes them) |
| `verify_archive_package` | query, `requiresKernel` | aero (plugin) | `{ manifest: Manifest, files: [{ name, text }] }` | `{ band, checks: [...] }` |
| `export_qif` (V2) | query | aero (plugin) | `{ entityIds?, qifVersion: '3.0' }` | `{ format:'qif', xml }` |
| `import_jt` (V2) | host tool → `import_mesh` | exchange | `{ jtBase64 | path }` via converter port | as `import_mesh` |

`export_step_exact` stays a registered command that delegates to the `export_step_ap242` implementation with
`{ schema:'ap214', assembly:'flat', includeValidationProperties:false }`, so existing plans, CLI scripts and MCP agents keep
working. (The retired-command map of `persistence/retiredCommands.ts` / `retiredEditCommands.ts` is not usable here: it only
rewrites steps of saved documents in `migrate()`, and a read-only export never enters the feature history, so retiring
`export_step_exact` would make live calls fail as unknown commands.)

Tags (C2) for the two central commands:

```ts
/**
 * @affects nothing — read-only
 * @invariant data.step is ISO 10303-21 text whose FILE_SCHEMA is the requested schema; one PRODUCT per exported
 *   component/solid; one NEXT_ASSEMBLY_USAGE_OCCURRENCE per instance; when includeValidationProperties, one
 *   'geometric validation property' set (volume, surface area, centre point) per solid and per assembly node;
 *   data.selfCheck re-reads data.step and compares GVP with the model (sameKernelRoundTrip policy)
 * @failure no solids, no kernel, kernel without writeExchange, a solid the kernel cannot build, selfCheck red -> no-op, no data
 */
export const exportStepAp242 = defineCommand({ name: 'export_step_ap242', annotations: { readOnly: true, requiresKernel: true }, … });

/**
 * @affects creates 1 mesh entity per imported solid (brep = imported recipe leaf), 1 component per product with
 *   children, 1 instance per occurrence; sets doc.exchange.provenance for each product
 * @invariant ids are step-scoped (stp-<step>.<k>); units converted to doc.units; a yellow/red GVP never blocks
 * @failure empty/garbage/truncated text, no kernel, reader returned nothing translatable -> no-op, summary names the cause
 */
export const importStepExact = defineCommand({ name: 'import_step_exact', annotations: { requiresKernel: true }, … });
```

Host plumbing (`packages/mcp/src/exchangeTools.ts`, CLI): `path` / `stepBase64` → `text` (Latin-1 decode; Part 21
is 7-bit ASCII with `\X2\` escapes), host computes `sha256` and passes it; `--save` writes `data.step`. The existing
`import_step` (mesh) stays as the fallback when no exact kernel is installed.

## 5. Kernel / algorithms

### 5.1 OCC classes

| Need | OCC (C++ / OCP) | Notes |
| ---- | --------------- | ----- |
| XDE document | `TDocStd_Document`, `XCAFApp_Application`, `XCAFDoc_DocumentTool`, `XCAFDoc_ShapeTool`, `XCAFDoc_ColorTool`, `XCAFDoc_LayerTool`, `XCAFDoc_MaterialTool` | products as labels, `AddComponent(assembly, product, TopLoc_Location)` for occurrences |
| STEP write/read with attributes | `STEPCAFControl_Writer` / `STEPCAFControl_Reader` (`SetColorMode`, `SetNameMode`, `SetLayerMode`, `SetPropsMode`, `SetGDTMode`) | XDE translator handles names, colours, layers, materials, **validation properties**, GD&T, saved views (read) [R8] |
| Schema | `write.step.schema` = `AP242DIS` (5) / `AP214IS` (4) / `AP203` (3); `STEPControl_Writer::Model(true)` after change (`newmodel`) [R8] | OCC default is AP214; GD&T export requires AP242 set explicitly [R8]. Newer OCC: per-call `DESTEP_Parameters.WriteSchema` (thread-safe) [R8] |
| Validation properties | XCAF validation attributes (volume, area, centroid) written by `STEPCAFControl_Writer` when attached to shapes; read per GVP RP §4 (AP214 form) [R8] | We compute the values ourselves (§5.2) and attach them; OCC handles the entity structure |
| Tessellated | `read.step.tessellated` / `write.step.tessellated` (0 Off, 1 On, 2 OnNoBRep); `TESSELLATED_SHAPE_REPRESENTATION`, `TESSELLATED_SHELL`, `TESSELLATED_SOLID` ↔ `Poly_Triangulation` [R8] | Maps to `TessellationMode` 'alongside' (1) / 'only' (needs B-rep-less faces) |
| GD&T | `XCAFDoc_DimTolTool`, `XCAFDoc_Dimension`, `XCAFDoc_GeomTolerance`, `XCAFDoc_Datum` (`Dimensional_Size/Location[_With_Path]`, `Angular_Size/Location` → `XCAFDoc_Dimension`) [R8] | OCC imports GD&T only when attached to shapes or shape groups, not to constructive geometry [R8] |
| IGES | `IGESControl_Reader` / `IGESCAFControl_Reader` / `IGESControl_Writer` (`write.iges.brep.mode`), sewing `BRepBuilderAPI_Sewing`, `ShapeFix_Shape` | Reads ≤ 5.3, writes 5.3 (ANS US PRO/IPO-100-1996); only 3D geometric entities translated; **not thread-safe** — serialise calls [R7] |
| Mass properties | `BRepGProp::VolumeProperties`, `BRepGProp::SurfaceProperties`, `GProp_GProps::Mass/CentreOfMass`, `BRepBndLib::AddOptimal` | Same algorithm as `quality/step_reference.py` |
| glTF (existing need, optional) | `RWGltf_CafWriter` (DE wrapper GLTF RW) [R9] | Only if XDE glTF with product structure is wanted; llull has its own `export_gltf` |
| JT | none in open-source OCC: the DE wrapper lists STEP, IGES, OBJ, STL, PLY, glTF, VRML [R9] | External converter port (§6.4) |

### 5.2 Geometric validation properties (computation)

For each exported solid S (B-rep, document units):

- **Volume** `V = Σ_faces ∫∫ (1/3) (x·n) dA` as computed by `BRepGProp::VolumeProperties` (Gauss integration over
  faces); for analytic shapes the closed forms in `validation/generate_analytic_gvp.py` are the reference.
- **Area** `A = Σ_faces area(f)` (`SurfaceProperties`). The CAx-IF RP names the solid's area "surface area"; NIST files
  also use "wetted area measure" for the same quantity and "independent surface area measure" for free surfaces —
  the reader maps all three; only solid area is compared to solid area.
- **Centroid** `c = CentreOfMass` of the volume properties (solids) or surface properties (shells).
- **Bounding box** optimal (`AddOptimal`, no enlargement), written as two `CARTESIAN_POINT('bounding box corner point')`
  when the RP version used supports it (as in NIST CTC-04 / FTC-07 files).
- **Assembly GVP**: `V_asm = Σ V_i`, `A_asm = Σ A_i`, `c_asm = Σ V_i c_i / V_asm` over all occurrences (placed).
  Instance count is also an assembly validation property in the GVP RP title scope [R11]; MVP writes the counts via
  the product structure and checks them on re-import.

Units: values are expressed in the file's units (written in the document unit); on import they are converted with
exact factors (25.4 mm/in, 304.8 mm/ft, 10 mm/cm, 1000 mm/m) before comparison (FR-XCH-12).

### 5.3 GVP comparison bands

```
relDelta(p)      = |receiver − sender| / max(|sender|, ε)          (volume, area)
centroidDelta    = ‖c_receiver − c_sender‖₂                          (document units)
green  : relDelta ≤ 1e-3  and centroidDelta ≤ 1e-3 · diag(bbox)
yellow : relDelta ≤ 1e-2  and centroidDelta ≤ 1 mm (converted to doc units)     ← CATIA default [R14]
red    : otherwise
not-checkable : sender GVP all zero (placeholder, NIST STC-06) or absent
```

Bands are configurable per command call (`gvpPolicy`) and per document setting (V1). Justification: the CAx-IF uses
a three-tier result system [R13]; the only numeric default we could verify is CATIA's (1 % volume/area, 1 mm
centroid) [R14]; the measured spread between two different CAD systems exporting NIST CTC-02 is 1.12e-4 (volume),
4.93e-4 (solid area) and 0.018 mm (centroid) (`validation/expected_results.json` VC-XCH-06), so green at 1e-3 accepts
genuine inter-CAD differences while flagging anything an order of magnitude worse.

### 5.4 Semantic PMI mapping (V1, with gap 03)

| AP242 (census name) | OCC XCAF | llull (gap 03, names indicative) |
| ------------------- | -------- | ------------------------------- |
| `DIMENSIONAL_SIZE`, `ANGULAR_SIZE` (+ `PLUS_MINUS_TOLERANCE`, `TOLERANCE_VALUE`, limits & fits) | `XCAFDoc_Dimension` | size dimension on a feature (face set) |
| `DIMENSIONAL_LOCATION`, `ANGULAR_LOCATION`, `…_WITH_PATH` | `XCAFDoc_Dimension` | location dimension between two features |
| `DATUM_FEATURE`, `DATUM`, `PLACED_DATUM_TARGET_FEATURE` | `XCAFDoc_Datum` | datum feature / datum / datum target |
| `DATUM_SYSTEM`, `DATUM_REFERENCE_COMPARTMENT` | part of `XCAFDoc_GeomTolerance` | datum reference frame |
| `FLATNESS_TOLERANCE`, `POSITION_TOLERANCE`, `SURFACE_PROFILE_TOLERANCE`, `PERPENDICULARITY_TOLERANCE`, … (often complex instances with `GEOMETRIC_TOLERANCE_WITH_*`) | `XCAFDoc_GeomTolerance` | geometric tolerance (characteristic, zone, modifiers, DRF) |
| `TESSELLATED_ANNOTATION_OCCURRENCE`, `ANNOTATION_CURVE_OCCURRENCE`, `ANNOTATION_PLANE` | presentation in XCAF | graphic presentation (read-only display when no semantics) |

Known OCC defect to guard: tolerance magnitudes inside complex entities read as 0.0 on the NIST files (reported,
with a text re-read workaround) [R25]. TR-XCH-09 therefore requires a text-level magnitude cross-check
(`packages/core/src/lib/step21/`) and VC-XCH-07 fails on any zero magnitude where the census shows a non-zero
`LENGTH_MEASURE`.

### 5.5 IGES specifics

- Read: roots of types 144 (trimmed surface), 143 (bounded surface), 186 (MSBO solid), 510/514 (face/shell) become
  faces/shells; sew with tolerance = max(file "minimum resolution" from the Global section, 1e-6 · diag) (Global
  section parameter values observed: `0.01` and `0.0001`/`0.001` in the OCCT samples) → closed shells become solids.
  Untranslated entity types are counted from the Directory Entry section (same census as
  `validation/xch_corpus.json` `entityCensus`).
- Write: `write.iges.brep.mode` = 1 (B-rep: types 186/514/510/508/504/502) by default; `faces` mode (144 + 128)
  for legacy CAM. Names via `IGESCAFControl_Writer`. Serialise IGES calls (OCC not thread-safe [R7]).

### 5.6 Numerical tolerances

| Quantity | Tolerance | Why |
| -------- | --------- | --- |
| Same-kernel round trip (export → import, OCC → OCC) | 1e-9 relative (V, A), 1e-9 · diag (centroid) | Only REAL serialization intervenes; TR-XCH-05 requires ≥ 15 significant digits (Q5 if OCC writes fewer) |
| Model vs analytic | 1e-6 relative | Gauss integration error of `BRepGProp` on analytic surfaces |
| Import vs embedded GVP | bands §5.3 | Different CAD kernels/tessellations |
| Tessellated vs exact | 5e-3 relative (provisional) | Facet chord error; replace with measured bound after VC-XCH-09 |
| Sewing | max(file resolution, 1e-6 · diag) | IGES files carry their own resolution |

## 6. Interop & persistence

### 6.1 STEP AP242 output profile (llull v1)

- Part 21 header: `FILE_DESCRIPTION(('llull export'),'2;1')`, `FILE_NAME(<fileName>, <timestamp param>, (author), (''),
  <preprocessor>, 'llull <version>', '')`, `FILE_SCHEMA(('AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF { 1 0 10303 442 … }'))`
  (exact object identifier = whatever the OCC version writes for AP242DIS; record it in the golden test, Q6).
- One `PRODUCT` per component / free solid, `NEXT_ASSEMBLY_USAGE_OCCURRENCE` per instance with
  `ITEM_DEFINED_TRANSFORMATION` placement; colours per styling RP; GVP per GVP RP.
- No text-level patching (retire `stepLabels.ts` regex once XDE names/colours are written by `STEPCAFControl_Writer`).

### 6.2 Import profile

Accept AP203 (`CONFIG_CONTROL_DESIGN`, `…403…`), AP214, AP242 ed. 1–4 (object identifiers in NIST files:
`{ 1 0 10303 442 1 1 4 }`, `{ … 442 3 1 4 }`, `{ … 442 4 1 4 }`, `{ … 442 7 1 4 }`) [R4]. Unknown schema → try, and
report. `.stpZ` / AP242 XML (`.stpx`, Part 28) are V2.

### 6.3 Archive package (LOTAR-oriented, plugin)

```
<PN>-<REV>/
  <PN>-<REV>.stp                AP242 with GVP (and PMI when present)
  manifest.json                 { partNumber, revision, created (host timestamp), llullVersion, kernel: { name, occVersion },
                                  schemaName, unit, files: [{ name, sha256, bytes }],
                                  gvp: [{ product, volume, area, centroid, bbox }], pmiCensus, recipeHash }
  verification-report.json      output of verify_exchange_file on the written file (self-check, band)
```

`verify_archive_package` recomputes sha256 (host-supplied bytes), re-imports, recomputes GVP and compares with
`manifest.gvp` under the same-kernel policy, and with a cross-version note when `occVersion` differs. This
implements the *verification evidence* that EN 9300-110/-115 ask for via validation properties [R16][R17]; the
archive process itself (EN 9300-002 requirements) is the organisation's.

### 6.4 JT and QIF

- **JT** (V2): host port `JtConverterPort` mirroring `DwgConverterPort` (`server/`): `LLULL_JT_CONVERTER=<exe>`
  converts JT → STEP AP242 or glTF, then `import_step_exact` / `import_mesh` runs through the command bus. No JT
  parser in llull (ISO 14306 is a full binary spec [R5]; licence and effort, Q2).
- **QIF** (V2): `export_qif` writes QIF 3.0 XML (ISO 23952 [R6]) with `Product` (part reference to the AP242 file by
  sha256), `Characteristics` from gap-03 PMI; validates against the QIF 3.0 XSD in tests (schema files are distributed
  by qifstandards.org [R6]; pin them in the test fixture once downloaded, Q7).

## 7. UI / CLI / MCP surfaces

| Surface | Change |
| ------- | ------ |
| UI (`src/ui`, Lane 2) | File › Import STEP/IGES dialog (append/replace, sew, verify); Export dialog (schema, GVP, PMI, tessellation, assembly); Validation badge per product in the Assembly panel; report table component (sender / llull / delta / band); Archive package dialogs (V1). Param-gathering only — dispatches the commands. |
| CLI (`server/src/cli`) | `file=<path>` → `text` for `import_step_exact`, `import_iges`, `verify_exchange_file`; `--save` for exports; `--save-dir` for `create_archive_package` (writes `data.files`); non-zero exit code (1, as for a failed command; 2 stays "bad usage") when `data.band === 'red'` (US-4). |
| MCP (`packages/mcp`, Lane 4) | New tools appear automatically from the registry (exchange toolset). Host tools `import_step` / `export_step` keep their Python paths; add `path`/`stepBase64` plumbing for the new commands as for `import_dwg`. Toolset entry in `packages/mcp/src/toolsets.ts` (exchange, measure) + a new `aero` name in `TOOLSET_NAMES` for the plugin commands (as `building` / `civil`). |
| Desktop | File menu entries; bundled Python gets the interim `op_*_xde` operations; `LLULL_JT_CONVERTER` documented (V2). |

## 8. Performance & robustness budgets

| Item | Budget |
| ---- | ------ |
| Import 2 MB AP242 part (NIST CTC-02 size, 637 faces) on desktop | ≤ 5 s to exact solids + GVP check; ≤ 1 GB peak |
| Export 50 solids / 200 instances AP242 with GVP | ≤ 10 s |
| `verify_exchange_file` without kernel (census + embedded GVP) on 6 MB file (FTC-09) | ≤ 1 s, streaming tokenizer, O(n) |
| Max input | host limit `LLULL_EXCHANGE_MAX_BYTES` default 200 MB, rejected before parse (VC-XCH-14) |
| Hostile input | never throws out of a command; OCC calls wrapped in the kernel's `guarded('fragile', …)` (as `exportStep` today); IGES calls serialised; WASM memory released on every path (`release()` pattern of `occtStep.ts`) |
| Determinism | same document + same `timestamp` ⇒ byte-identical STEP (golden test) — requires stable label order (product key order = `doc.order`) |

## 9. Test strategy (→ VC ids)

| Test | Location | VC |
| ---- | -------- | -- |
| `geometric_validation_properties` on the 9 analytic plans vs `analytic_gvp_reference.json` | `tests/unit/exchange/gvp.test.ts` (OCC kernel installed) | VC-XCH-01 |
| Export → import round trip of the 9 analytic parts, same kernel | `tests/unit/exchange/stepAp242RoundTrip.test.ts`; `server/tests/occtExchange.test.ts` | VC-XCH-01, -04, -12 |
| Exported GVP read by the **TS port** of `extract_validation_properties.py` | `tests/unit/exchange/stepGvpWriter.test.ts` | VC-XCH-02 |
| Header/schema golden + byte-identical determinism | `tests/golden/` plan `xch_export_ap242` (id-normalized snapshot of `data.step` header + census) | VC-XCH-03 |
| NIST corpus import + GVP bands | `quality/` gate `step-ap242` reading `docs/aerospace/04-interop-ap242-jt-iges/validation/xch_corpus.json` (fetch by archive URL + sha256, never committed) | VC-XCH-05, -06, -07, -09 |
| Python reference of GVP recompute (independent of llull's OCC path) | extend `quality/step_reference.py` with `centroid` + embedded GVP comparison | VC-XCH-05 |
| IGES import/export | `quality/` gate `iges-import`; unit round trip | VC-XCH-10, -11 |
| Archive package | `tests/unit/aero/archivePackage.test.ts` | VC-XCH-13 |
| Fuzz / truncation / garbage / oversize | `tests/unit/exchange/importRobustness.test.ts` (truncate NIST file at 10 offsets, random bytes) | VC-XCH-14 |
| SFA | `npm run production` scenario `xch-sfa` (gate machine with SFA installed; skipped elsewhere with a visible notice) | VC-XCH-17 |
| Layers / materials round trip | `tests/unit/exchange/stepAp242RoundTrip.test.ts` | VC-XCH-18 |
| Composites / kinematics (V2) | TBD with 06 CMP | VC-XCH-19 |
| Same `data` from `store.dispatch`, CLI `--doc`, MCP; no network (sandboxed test) | `tests/integration/exchangeParity.test.ts`, `server/tests/` | VC-XCH-20 |
| Each command | happy + failure + `is pure` tests (non-negotiables) | all |

Coverage gate 90/85/90/90 applies to `packages/core/src/commands/exchange/**` and the plugin.

## 10. Delivery plan

| Milestone | Content | Depends on | Effort (eng-weeks) |
| --------- | ------- | ---------- | ------------------ |
| M0 Spike | Verify opencascade.js 1.1.1 bindings; build custom ocjs with TKXDESTEP/TKDEIGES/TKXCAF; size/perf report | 01 KRN spike | 1.5 |
| M1 GVP | `massProperties` kernel member + `geometric_validation_properties` query; TS Part 21 verifier (`lib/step21`) | — | 1.5 |
| M2 AP242 export | `writeExchange` (XDE), `export_step_ap242`, assembly structure, GVP write, self-check; alias `export_step_exact` | M0, M1 | 3 |
| M3 Exact import + verify | `readExchange`, `import_step_exact`, provenance, bands, `verify_exchange_file`; NIST gate | M0, 01 KRN imported recipe leaf | 3 |
| M4 IGES | `import_iges` (sewing, census), `export_iges` | M0 | 2 |
| M5 UI/CLI/MCP | dialogs, badge, report table, CLI exit codes, toolsets | M2–M4 | 2 |
| MVP total | | | **13** |
| V1 | PMI import/export (with 03), tessellated, layers/materials, archive package + verify, SFA gate | 03 GDT | 8 |
| V2 | QIF export, JT converter port, composites/kinematics mapping, AP242 XML read | 06 CMP | 6 |

## 11. Open questions / decisions needed

| Id | Question | Recommendation |
| -- | -------- | -------------- |
| Q1 | XCH on opencascade.js custom build (all callers) vs OCP Python bridge (desktop only)? | Custom build primary; Python interim |
| Q2 | JT: external converter only, or license a JT toolkit? | Converter port; no in-house parser |
| Q3 | Who owns the `imported` `ShapeRecipe` leaf and STEP → B-rep import? | Gap 01 KRN owns; XCH consumes |
| Q4 | Plugin name for LOTAR/QIF (`packages/domain-aero`?) shared with 03/09 | Align with 09 PLM before M5 |
| Q5 | Digits of REAL values written by OCC (does it guarantee round-trip precision)? | Measure in M0; if < 15 digits relax same-kernel tolerance to 1e-7 |
| Q6 | Exact AP242 object identifier written by the OCC version we ship | Record in golden; document in CAD_EXCHANGE.md |
| Q7 | QIF 3.0 XSD pinning (download, licence) | Pin when V2 starts |
| Q8 | Default schema switch AP214 → AP242 for `export_step` (CadQuery path) too? | Yes after VC-XCH-03/-17 pass |
| Q9 | Participation in a CAx-IF test round (membership) to claim tested interoperability | Product decision; not required for MVP |
| Q10 | NIST SFA platform for CI (verify availability of a command-line build on Linux runners) | Check in M5; else Windows gate runner |

## 12. References

Same list as [`FUNCTIONAL_SPEC.md` §11](FUNCTIONAL_SPEC.md#11-references) ([R1]–[R26]); the ones this document
relies on most:

- [R4] NIST-PMI-STEP-Files (README + files) — NIST — https://raw.githubusercontent.com/usnistgov/SFA/72375d17c09cf7072c30d9393b5c08b7aa272285/Release/NIST-PMI-STEP-Files.zip (accessed 2026-10-15)
- [R7] OCCT IGES Translator user guide — Open Cascade — https://raw.githubusercontent.com/Open-Cascade-SAS/OCCT/3d097a0328e71b826377d4814ab05ec3c3d23871/dox/user_guides/iges/iges.md (accessed 2026-10-15)
- [R8] OCCT STEP Translator user guide (XDE section: colours, layers, materials, validation properties, GD&T; `write.step.schema`; tessellation flags) — Open Cascade — https://raw.githubusercontent.com/Open-Cascade-SAS/OCCT/3d097a0328e71b826377d4814ab05ec3c3d23871/dox/user_guides/step/step.md (accessed 2026-10-15)
- [R9] OCCT Data Exchange Wrapper user guide (supported formats table) — Open Cascade — https://raw.githubusercontent.com/Open-Cascade-SAS/OCCT/3d097a0328e71b826377d4814ab05ec3c3d23871/dox/user_guides/de_wrapper/de_wrapper.md (accessed 2026-10-15)
- [R10] NIST SFA — NIST — https://github.com/usnistgov/SFA (accessed 2026-10-15)
- [R11] CAx-IF GVP Recommended Practices — https://www.mbx-if.org/home/wp-content/uploads/2024/05/rec_prac_gvp_v45.pdf (accessed 2026-10, search extract)
- [R12] CAx-IF PMI Recommended Practices v4.1 — https://www.mbx-if.org/home/wp-content/uploads/2024/06/rec_pracs_pmi_v41.pdf (accessed 2026-10, search extract)
- [R13] CAx-IF 3D Tessellated Geometry RP v1.1 — https://www.mbx-if.org/home/wp-content/uploads/2024/05/rec_prac_3dtess_geo_v11.pdf (accessed 2026-10, search extract)
- [R14] CATIA "About Validation Properties" (default thresholds) — https://help-3dexperience.aesvietnam.com/English/SstUserMap/sst-c-ValidationProperties.htm (accessed 2026-10, search extract, unofficial mirror)
- [R16] EN 9300 series catalogue pages — https://standards.iteh.ai/catalog/standards/cen/bbb8a880-464c-4c0f-85e7-c28fc11bc32f/en-9300-110-2018 (accessed 2026-10, search extract)
- [R17] LOTAR overview (GIFAS 2012) — https://lotar-international.org/wp-content/uploads/2020/05/2012-05-29_GIFAS_LOTAR_Overview_Final_V5.pdf (accessed 2026-10, search extract)
- [R24] OpenCascade.js custom builds — https://ocjs.org/docs/app-dev-workflow/custom-builds (accessed 2026-10, search extract)
- [R25] pzfreo/step-pmi-viewer — https://github.com/pzfreo/step-pmi-viewer (accessed 2026-10-15)
- [R26] naanouff/occt-wasm — https://github.com/naanouff/occt-wasm (accessed 2026-10-15)
- llull: `docs/CAD_EXCHANGE.md`, `docs/decisions/KI5-shape-kernel-boundary.md`, `docs/decisions/KI6-desktop-app-cli-first.md`, `.claude/rules/architecture.md`
