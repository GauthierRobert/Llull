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
| Kernels | `packages/kernel-occt` uses `opencascade.js` **^1.1.1** (`package.json`; 1.1.1 in `package-lock.json`) in browser + server worker; desktop also bundles CPython + CadQuery/OCP (KI6) | Two OCC runtimes | Unknown whether the 1.1.1 build binds `STEPCAFControl_*`, `XCAFDoc_*`, `IGESControl_*`; must be verified (Q1) |

## 2. Target architecture

### 2.1 Layer placement (laws L1–L10)

```
src/ui (Import/Export dialogs, Validation badge, report table)      server/ + desktop/ (file I/O, converters, Python bridge)
        │ dispatch(name, params)                                           │ read file → params; write data → file
        ▼                                                                  ▼
packages/core/src/commands/exchange/   (Lane 1)                    packages/mcp/src/exchangeTools.ts (host tools: path/base64 plumbing only)
   export_step_ap242   import_step_exact (owned by 01 KRN; extended here)   export_iges   import_iges
   verify_exchange_file (query)   geometric_validation_properties (query)
packages/<aero plugin>/src/exchange/   (domain: LOTAR, QIF)  create_archive_package / verify_archive_package / export_qif
        │ ctx.kernel (requiresKernel)
        ▼
GeometryKernel (core interface)  ── + exchange port methods (§2.3)
        ▼
packages/kernel-occt (opencascade.js custom build: TKDESTEP/TKDEIGES/TKXCAF)    [target]
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
| OCP (CadQuery) in bundled CPython | desktop app, server with `LLULL_PYTHON` | interim (MVP fallback) | Write side implemented in `llull_bridge.py` (`op_export_xde`, `op_gvp`); exposed through the host exchange tools while the WASM build lands, same JSON contract as §2.3. The read side follows 01 KRN's `importShapes` (01 TECHNICAL_SPEC Q1 / TR-KRN-05) |

Decision needed (Q1): keep both (WASM primary, Python fallback) or Python-only on desktop. Recommendation: WASM
primary because it keeps XCH commands pure registry commands reachable from every caller (L1), with the Python path
as the escape hatch for features OCC-WASM cannot do in time (e.g. GD&T export).

### 2.3 Kernel interface extension (core, `packages/core/src/geometry/kernel.ts`)

Ownership (decided 2026-10-15, see 01 KRN TECHNICAL_SPEC §2.0): **01 KRN** owns the read side and the mass properties —
`GeometryKernel.importShapes(format: 'step' | 'iges', bytes, options)` (healed definitions as BRep blobs, the XDE
product tree, names, colours, embedded GVP attributes in file units, file length unit; 01 TR-KRN-20/23), the `brep` blob
recipe leaf + `heal` node (01 §3), and the single `massProperties(handle, { eps, reference })` method returning volume,
area, centroid, inertia **and the optimal bbox** this pack needs (01 TR-KRN-40). XCH defines **no** `readExchange`, no
`MassProps` of its own and no `imported` recipe leaf: an `imported` leaf keyed only by the file sha256 would hold no
payload and could not re-evaluate after reload. Imported solids (STEP and IGES) carry 01's `brep` blob leaf.

`exportStep(shapes)` stays for backwards compatibility. XCH adds only the **write** side (optional member; Manifold
returns `null`, as it does for `exportStep`):

```ts
export type StepSchema = 'ap242' | 'ap214' | 'ap203';
export type TessellationMode = 'off' | 'alongside' | 'only';

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

export interface GeometryKernel {
  // … existing members; importShapes / massProperties / faceQuery from 01 KRN …
  writeExchange?(request: ExchangeWriteRequest): string | null;   // Part 21 / IGES text
}
```

GVP values written by `writeExchange` come from 01's `massProperties` (volume, area, centroid, bbox).

### 2.4 Technical requirements

| Id | Prio | Requirement | FR | VC |
| -- | ---- | ----------- | -- | -- |
| TR-XCH-01 | MUST | `GeometryKernel.writeExchange` writes STEP with a selectable schema (AP242DIS / AP214IS / AP203 OCC values) through an XDE document; OCC kernel implements it, Manifold returns null | FR-XCH-01 | VC-XCH-01, -03 |
| TR-XCH-02 | MUST | `geometric_validation_properties` reads volume, area, centroid, optimal bbox from 01 KRN's `GeometryKernel.massProperties` (TR-KRN-40, owned by 01); mesh fallback (signed tetrahedra) flagged `method:'mesh'` | FR-XCH-02, -03 | VC-XCH-01 |
| TR-XCH-03 | MUST | No file I/O, network or clock in core commands: content in/out via params/`data`; host passes `sha256`, `timestamp` | FR-XCH-21, -22 | all |
| TR-XCH-04 | MUST | Output profile §6.1 (header, FILE_SCHEMA, one PRODUCT per component/free solid) | FR-XCH-01 | VC-XCH-03 |
| TR-XCH-05 | MUST | REAL values written with ≥ 15 significant digits; same document + timestamp ⇒ byte-identical file | FR-XCH-02 | VC-XCH-01, -03 |
| TR-XCH-06 | MUST | GVP (volume, surface area, centre point; bbox SHOULD; assembly GVP) written per CAx-IF GVP RP using XCAF validation attributes | FR-XCH-03 | VC-XCH-02 |
| TR-XCH-07 | MUST | Components ↔ PRODUCT, instances ↔ NEXT_ASSEMBLY_USAGE_OCCURRENCE with rigid placement; names, colours via XCAF (retire `stepLabels.ts` regex) | FR-XCH-04 | VC-XCH-04 |
| TR-XCH-08 | MUST | Extension of 01 KRN's `import_step_exact` (command, reader `importShapes`, `brep` blob leaf, healing and report owned by 01): XDE product tree → components / instances, provenance with embedded GVP, comparison bands §5.3, never blocking | FR-XCH-05, -06 | VC-XCH-05, -06 |
| TR-XCH-09 | SHOULD | Semantic PMI import mapping §5.4 with text-level magnitude cross-check; every census record mapped or reported | FR-XCH-07 | VC-XCH-07 |
| TR-XCH-10 | SHOULD | Semantic PMI export (schema forced to AP242) with graphic presentation | FR-XCH-08 | VC-XCH-08 |
| TR-XCH-11 | SHOULD | Tessellated read (`read.step.tessellated`=1/2) → mesh entities; write modes 'alongside'/'only' | FR-XCH-09 | VC-XCH-09 |
| TR-XCH-12 | MUST | IGES read through 01 KRN's `importShapes(format: 'iges', …)`, healed solids stored in the same `brep` blob leaf; sewing at max(file resolution, 1e-6·diag) and untranslated-type census; IGES calls serialised | FR-XCH-10 | VC-XCH-10 |
| TR-XCH-13 | SHOULD | IGES 5.3 write, B-rep mode default, faces mode optional | FR-XCH-11 | VC-XCH-11 |
| TR-XCH-14 | MUST | Exact unit factors on import/export and on embedded GVP before comparison | FR-XCH-12 | VC-XCH-12 |
| TR-XCH-15 | SHOULD | Archive package layout §6.3; verify recomputes sha256 + GVP vs manifest | FR-XCH-13, -14 | VC-XCH-13 |
| TR-XCH-16 | MUST | Robustness budgets §8: size limit before parse, guarded OCC calls, WASM memory released, no throw out of a command | FR-XCH-15 | VC-XCH-14 |
| TR-XCH-17 | SHOULD | NIST SFA analysis of every llull-written AP242 gate file (0 syntax errors) | FR-XCH-18 | VC-XCH-17 |
| TR-XCH-18 | MUST | Independent pure-TS Part 21 reader (`packages/core/src/lib/step21/`): tokenizer, record map, GVP extraction, entity census — port of `validation/extract_validation_properties.py`, tested against its JSON output | FR-XCH-06, -18 | VC-XCH-02, -05, -07 |
| TR-XCH-19 | MUST | `export_step_exact` stays a registered command delegating to the `export_step_ap242` implementation (AP214, flat, no GVP) so existing plans and tools are unchanged | FR-XCH-21 | VC-XCH-03 |

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
  readonly unverified: { readonly value: boolean; readonly reasons: readonly ('import_gvp_red' | 'import_gvp_not_checkable' | 'verify_skipped')[] }; // TR-XCH-24
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
  `insert_instance`), leaf solids → `mesh` entities with `brep` = 01 KRN's `brep` blob leaf (+ `heal` node) (KI5).
- PMI → gap-03 model (`doc.pmi`, owned by 03). XCH defines only the mapping (§5.4).
- Ids: `stp-<step>.<k>` for imported entities, `comp-stp-<step>.<k>` for components (step-scoped, replay-stable, L8).
- Timestamp: commands never call `Date.now()`; hosts pass `timestamp` for export headers (deterministic tests).
- Document version: `exchange` is one slice of the single `llull-document` v3 envelope owned by 01 KRN
  (01 TECHNICAL_SPEC §3.1, one v2 → v3 migration; the slice itself is optional and needs no data migration).
  Recipe validation of the `brep` leaf is 01's (blob exists, sha256 matches).

## 4. Commands

| Name | Kind | Toolset | Params (zod sketch) | data |
| ---- | ---- | ------- | ------------------- | ---- |
| `geometric_validation_properties` | query, `requiresKernel` | measure | `{ entityIds?: string[], includeAssemblies?: boolean }` | `{ unit, items: [{ id, name, volume, area, centroid, bbox, method:'brep'|'mesh' }], assemblies?: [...] }` |
| `export_step_ap242` | query, `requiresKernel` | exchange | `{ entityIds?: string[], schema?: 'ap242'|'ap214'|'ap203' (default 'ap242'), includeValidationProperties?: boolean (true), assembly?: 'structured'|'flat' ('structured'), tessellation?: 'off'|'alongside'|'only' ('off'), includePmi?: boolean (true), fileName?: string, timestamp?: string, acceptUnverified?: boolean (human gate) }` | `{ format:'step', schema, step, products, occurrences, gvp:[…], selfCheck: GvpCheck, skipped, policy, provenance, reviewRequired }` |
| `import_step_exact` (owned by 01 KRN; this row = XCH extension) | mutating, `requiresKernel` | exchange | 01's params (`stepBase64` \| `text` \| `blobId`, `fileName`, `heal`, `sew`, `precisionMode`, `keepOriginal`, `name`) **+** `sha256?: string`, `mode?: 'append'|'replace'`, `tessellated?: boolean (true)`, `verify?: boolean (true)`, `gvpPolicy?: Partial<GvpPolicy>` | 01's `report` **+** `{ products, components, gvpCheck, messages }` |
| `verify_exchange_file` | query (kernel optional) | exchange | `{ text: string, format?: 'step'|'iges', gvpPolicy?: … }` | `{ schemaName, unit, census, embeddedGvp, recomputed?: { volume, area, centroid, bbox }[] (01 `massProperties`), comparisons, band, issues, unverified, reviewRequired, policy }` — without a kernel: census + embedded GVP only |
| `export_iges` | query, `requiresKernel` | exchange | `{ entityIds?: string[], mode?: 'brep'|'faces' ('brep'), fileName?, timestamp? }` | `{ format:'iges', iges, solidCount, selfCheck }` |
| `import_iges` | mutating, `requiresKernel` | exchange | `{ text, fileName?, sha256?, sew?: boolean (true), mode? }` | `{ entities, openShells, untranslated: Record<type,count> }` |
| `create_archive_package` | query, `requiresKernel` | aero (plugin) | `{ entityIds?: string[], partNumber: string, revision: string, timestamp: string }` | `{ files: [{ name, text, sha256 }], manifest, reviewRequired: { value: true, reasons: ['archive_record'] } }` (host writes them) |
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
 * (owned by 01 KRN; tags below describe the XCH extension)
 * @affects creates 1 mesh entity per imported solid (brep = 01 KRN `brep` blob leaf), 1 component per product with
 *   children, 1 instance per occurrence; sets doc.exchange.provenance for each product
 * @invariant ids are step-scoped (stp-<step>.<k>); units converted to doc.units; a yellow/red GVP never blocks
 * @failure empty/garbage/truncated text, no kernel, reader returned nothing translatable -> no-op, summary names the cause
 */
export const importStepExact = defineCommand({ name: 'import_step_exact', annotations: { requiresKernel: true }, … });
```

Host plumbing (`packages/mcp/src/exchangeTools.ts`, CLI): `path` / `file=` → `stepBase64` or `text` (Latin-1 decode;
Part 21 is 7-bit ASCII with `\X2\` escapes), host computes `sha256` and passes it; `--save` writes `data.step`. The
existing `import_step` host tool gains `mode: 'exact' | 'mesh'` (01 KRN §4) and keeps the mesh path as the fallback
when no exact kernel is installed.

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

This is llull's **single** GVP band policy (01 KRN's import defers to it; KRN's VC-KRN-04 tolerances are test
tolerances only). Bands are configurable per command call (`gvpPolicy`) and per document setting (V1).

Justification:
- the CAx-IF uses a three-tier result system [R13]; the only numeric default we could verify is CATIA's (1 %
  volume/area, 1 mm centroid) [R14] → **yellow**;
- **green** (one order tighter) is checked against measured data: OCCT 7.9.3 recomputation vs the GVP written by the
  originating CAD systems in the pinned NIST files (01 KRN `validation/nist_gvp_vs_occt.json`, reproduced in review).
  The 6 files whose GVP describe their geometry (CTC-01 e1, CTC-03 e2, CTC-04 e2, FTC-06 e2, STC-10 e2, FTC-09 rd)
  differ by at most 7.5e-5 (volume), 9.4e-4 (area, CTC-04 e2) and 0.0064 mm (centroid): all green. The 4 gross
  disagreements (CTC-02 rc and e2, STC-08 e3, CTC-05 rd after inch conversion: ≥ 1.06e-2 volume) are red;
- CTC-04's area delta sits 6 % under the green limit, so green must not be tightened without new evidence. FTC-07 e2
  (2.1e-4 volume, 3.9e-5 area, 0.021 mm) is green under these bands although 01's stricter test tolerance flags it;
- VC-XCH-06 (CTC-02 AP203 vs AP242, 1.12e-4 / 4.93e-4 / 0.018 mm) compares two senders' GVP with each other; the two
  files' geometries differ by 5.2 % in OCCT volume, so it is **not** used as justification.

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
| Model vs analytic | 1e-9 relative | Gauss integration error of `BRepGProp` on analytic surfaces: ≤ 1.1e-14 measured with OCCT 7.9.3 (01 KRN `occt_crosscheck.json`); same as VC-KRN-01 |
| IGES export → import | 1e-6 relative (provisional) | solids rebuilt by sewing; replace with a measured bound after VC-XCH-11 |
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

## 7. CLI / MCP / UI surfaces

| Surface | Change |
| ------- | ------ |
| CLI (`server/src/cli`) — **primary** | Commands found by `llull search step ap242` / `llull search iges` and documented by `llull describe` (agent-written: what, when, units, refusals, next command — AF-02). `file=<path>` → `stepBase64` / `text` for `import_step_exact`, `import_iges`, `verify_exchange_file`; `--save` for exports; `--save <dir>` for `create_archive_package` (the existing `--save` already writes a directory for multi-file results such as sheets / `export_nc_files`; it writes `data.files`); `verify_archive_package` gets its `{ manifest, files }` from a new CLI `dir=<path>` mapping that reads `manifest.json` and the listed files (host-side, like `file=`); exit code 1 (as for a failed command; 2 stays "bad usage") when `data.band === 'red'` or on a refusal (US-4). `llull guide` gains an XCH section (AF-03): file units vs document units, GVP bands and what to do on each, the minimal receive → verify → deliver sequence (FUNCTIONAL_SPEC §6.1). |
| MCP (`packages/mcp`, Lane 4) | New tools appear automatically from the registry (exchange toolset). Host tools `import_step` / `export_step` keep their Python paths; add `path`/`stepBase64` plumbing for the new commands as for `import_dwg`. Toolset entry in `packages/mcp/src/toolsets.ts` (exchange, measure) + a new `aero` name in `TOOLSET_NAMES` for the plugin commands (as `building` / `civil`). |
| UI (`src/ui`, Lane 2) — review / approval | Validation badge per product, report table (sender / llull / delta / band), assembly tree; reviewer acts for the human gates (TR-XCH-26). Import / Export / Archive dialogs are COULD conveniences that dispatch the same commands. |
| Desktop | File menu entries; bundled Python gets the interim `op_*_xde` operations; `LLULL_JT_CONVERTER` documented (V2). |

### 7.1 Agent-first technical requirements (TR-XCH-20 .. 27)

| Id | Prio | Requirement | FR | VC |
| -- | ---- | ----------- | -- | -- |
| TR-XCH-20 | MUST | Refusals return `data.error`, check findings `data.issues[]`, as `{ code, severity: 'fail'|'warn'|'info', file?, productKey?, entityIds?, property?, paramPath?, remediation }` with the codes of §7.2; exit 1 on refusal or red | FR-XCH-23 | VC-XCH-21 |
| TR-XCH-21 | MUST | `verify_exchange_file` returns `data.band` + `data.issues[]` (pass / warn / fail) and is runnable without a kernel (census + sender GVP) | FR-XCH-24 | VC-XCH-05, -21 |
| TR-XCH-22 | MUST | Units: param descriptions state units; GVP values in `data` as `{ volume, volumeUnit, area, areaUnit, centroid, lengthUnit, bbox }`; `data.fileUnit` and `data.unitFactor` (exact 25.4 / 304.8 / 10 / 1000) on import | FR-XCH-25 | VC-XCH-12, -25 |
| TR-XCH-23 | MUST | Named defaults `{ value, unit, source, defaulted }` for `policy` (green / yellow from §5.3 with their sources), `schema`, `tessellation`, IGES sewing tolerance; `data.provenance` = `ImportProvenance` (import) or `{ llullVersion, kernel, schemaName, timestamp }` (export) | FR-XCH-26 | VC-XCH-25 |
| TR-XCH-24 | MUST | `ImportProvenance` gains `unverified: { value, reasons[] }` (`import_gvp_red`, `import_gvp_not_checkable`, `verify_skipped`); 01 `mass_properties` reads it (TR-KRN-103); export GVP and archive manifest entries copy it | FR-XCH-27 | VC-XCH-22 |
| TR-XCH-25 | MUST | `reviewRequired: { value, reasons[] }` on import reports (band yellow / red / not-checkable), exports with unverified bodies, every archive package (`archive_record`); AF-36 summary order | FR-XCH-28 | VC-XCH-23 |
| TR-XCH-26 | MUST (V1) | `export_step_ap242 { acceptUnverified: true }` (needed when any exported body is unverified, red or faceted — 01 KRN uses the same flag for faceted bodies, TR-KRN-105) and archive acceptance (09 `release_item`) require `ctx.caller.kind === 'human'` (09 TR-PLM-16; advisory in local CLI runs, enforced on an authenticated server); agent → `XCH_HUMAN_GATE` | FR-XCH-29 | VC-XCH-24 |
| TR-XCH-27 | SHOULD | Import stages (read, heal, tree, GVP, PMI) on `--progress`; `--timeout` honoured (01 worker recycle); `--dry-run` works (pure commands); missing JT converter → `XCH_CONVERTER_MISSING` with install hint | FR-XCH-30 | VC-XCH-26 |

### 7.2 Stable error codes (AF-11)

The import core (`KRN_STEP_UNREADABLE`, `KRN_STEP_TESSELLATED_ONLY`, `KRN_STEP_NO_SOLID`, `KRN_IMPORT_TOLERANCE_HIGH`,
`KRN_NO_EXACT_KERNEL`, …) is owned by 01 KRN (its TECHNICAL_SPEC §7.2). XCH adds:

| Code | Severity | Raised by | When | Offending ids / paths | Remediation |
| ---- | -------- | --------- | ---- | --------------------- | ----------- |
| `XCH_FILE_TOO_LARGE` | fail | host before parse (all readers) | bytes > `LLULL_EXCHANGE_MAX_BYTES` (default 200 MB) | file name, size | split the assembly or raise the limit on the desktop host |
| `XCH_SCHEMA_UNKNOWN` | warn | `verify_exchange_file`, `import_step_exact` | FILE_SCHEMA not AP203 / AP214 / AP242 ed. 1–4 | schema string | import is attempted; check the result with `verify_exchange_file` |
| `XCH_UNIT_UNKNOWN` | fail (comparison) | `verify_exchange_file`, import verify | no recognisable length unit in the file | file | GVP not compared (band `not-checkable`); ask the sender for the unit |
| `XCH_GVP_YELLOW` | warn | import verify, `verify_exchange_file` | delta between green and yellow limits (§5.3) | product, property, sender / receiver values, delta | report the numbers to the owner; continue only if the owner accepts the deviation |
| `XCH_GVP_RED` | fail (import still completes) | import verify, `verify_exchange_file` | delta beyond yellow | product, property, values | do not deliver; qualified reviewer decides (human gate for delivery) |
| `XCH_GVP_NOT_CHECKABLE` | warn | import verify, `verify_exchange_file` | sender GVP absent, all-zero placeholder, or `verify: false` | product | geometry marked `unverified`; ask the sender for GVP or proceed with review |
| `XCH_SELFCHECK_RED` | fail | `export_step_ap242`, `export_iges` | re-read of the written file disagrees with the model (same-kernel policy) | product, property | report a defect; do not deliver the file |
| `XCH_NO_SOLIDS` | fail | exports | nothing exportable in `entityIds` | entity ids | pass 3D solid ids (`find_entities`) |
| `XCH_WRITER_UNAVAILABLE` | fail | exports | kernel without `writeExchange` (Manifold) | — | run on the desktop backend / `--kernel occt` |
| `XCH_IGES_OPEN_SHELL` | warn | `import_iges` | shells that did not close after sewing | entity ids, open-shell count | retry with a larger sewing tolerance within limits; keep as surfaces |
| `XCH_IGES_UNTRANSLATED` | warn | `import_iges`, `verify_exchange_file` | IGES entity types OCC does not translate | type → count | expected for non-geometric types; review the list |
| `XCH_PMI_UNMAPPED` | warn (V1) | import with PMI | census record not mapped to the 03 model | record id, type | listed for the reviewer; no silent drop |
| `XCH_PMI_ZERO_MAGNITUDE` | fail (V1) | import with PMI | OCC tolerance value 0 where the text census shows a non-zero `LENGTH_MEASURE` [R25] | record id | use the text-level magnitude; report the reader defect |
| `XCH_ARCHIVE_HASH_MISMATCH` | fail (V1) | `verify_archive_package` | a file's sha256 differs from the manifest | file name | the package is corrupt; restore from another copy |
| `XCH_ARCHIVE_GVP_DRIFT` | fail (V1) | `verify_archive_package` | recomputed GVP outside the same-kernel policy | product, property | check the kernel version note; reviewer decides |
| `XCH_ARCHIVE_KERNEL_VERSION` | warn (V1) | `verify_archive_package` | manifest `occVersion` ≠ running kernel | both versions | cross-version comparison applies; see 01 `KRN_KERNEL_MISMATCH` |
| `XCH_CONVERTER_MISSING` | fail (V2) | `import_jt` host tool | `LLULL_JT_CONVERTER` not set / not executable | — | install the converter and set `LLULL_JT_CONVERTER` |
| `XCH_SFA_UNAVAILABLE` | warn | `xch-sfa` gate scenario | NIST SFA not installed on the gate machine | — | run the scenario on the gate machine (Q10) |
| `XCH_HUMAN_GATE` | fail | `export_step_ap242 { acceptUnverified }`, archive acceptance | agent caller on a human-gated act | act, entity ids | hand the prepared request to a qualified reviewer in the desktop app |

### 7.3 Agent-first compliance (AGENT_FIRST.md)

| AF | Where satisfied |
| -- | --------------- |
| AF-01 | every capability is a registry command (§4); FR-XCH-21; VC-XCH-20 |
| AF-02, AF-03 | §7 CLI row (descriptions, `llull guide` XCH section) |
| AF-04, AF-10 | TR-XCH-22; FR-XCH-25; VC-XCH-12, VC-XCH-25 |
| AF-05 | `validation/plans/*.json` validate with `llull run … --validate` (checked in review against the real zod schemas) |
| AF-11 | TR-XCH-20, §7.2; FR-XCH-23; VC-XCH-14, VC-XCH-21 |
| AF-12 | files only via `--save` (STEP, IGES, archive directory); reports bounded per product |
| AF-13 | TR-XCH-05 byte-identical export for the same `timestamp`; VC-XCH-03 |
| AF-20 | `verify_exchange_file`, `geometric_validation_properties`; FR-XCH-24; VC-XCH-05, VC-XCH-21 |
| AF-21 | GVP deltas and bands, census counts, untranslated-type counts instead of visual inspection |
| AF-22 | `render_view … --save part.png` in FUNCTIONAL_SPEC §6.1 |
| AF-23 | FUNCTIONAL_SPEC §7 (CLI + JSON assertions), `validation/README.md` §4.1 |
| AF-30 | GVP band policy as data with sources (§5.3) applied by the check commands |
| AF-31, AF-35 | TR-XCH-23; FR-XCH-26; VC-XCH-25 |
| AF-32 | TR-XCH-24; FR-XCH-27; VC-XCH-22 |
| AF-33, AF-36 | TR-XCH-25; FR-XCH-28; VC-XCH-23 |
| AF-34 | TR-XCH-26; FR-XCH-29; VC-XCH-24 |
| AF-40, AF-41, AF-42 | TR-XCH-27; FR-XCH-30, FR-XCH-22; VC-XCH-26, VC-XCH-20 |

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
| Agent-first CLI scripts (`--json` + exit codes): wrong calls → codes; STC-06 placeholder GVP → `unverified` propagated to `mass_properties`; CTC-02 e2 / archive → `reviewRequired`; agent `acceptUnverified` → `XCH_HUMAN_GATE`; named defaults + provenance; `--dry-run` / `--progress` on CTC-02 | `tests/unit/exchange/agentFirst.test.ts`, `server/tests/cli*.test.ts` | VC-XCH-21 .. 26 |
| Each command | happy + failure + `is pure` tests (non-negotiables) | all |

Coverage gate 90/85/90/90 applies to `packages/core/src/commands/exchange/**` and the plugin.

## 10. Delivery plan

| Milestone | Content | Depends on | Effort (eng-weeks) |
| --------- | ------- | ---------- | ------------------ |
| M0 Binding list | XCH's class list (XCAF writer, IGES, GD&T) handed to 01 KRN M2, which owns the single custom OCCT 7.9.x build (TKDESTEP/TKDEIGES/TKXCAF; OCCT ≥ 7.8 names, 7.4 splits them into TKSTEP*/TKXDESTEP/TKIGES/TKXDEIGES); verify the bindings in that build | 01 KRN M2 | 0.5 |
| M1 GVP (merged with 01 KRN M3, owner of `massProperties`) | `geometric_validation_properties` query over 01's `massProperties`; TS Part 21 verifier (`lib/step21`) | 01 KRN M3 | 1 |
| M2 AP242 export | `writeExchange` (XDE), `export_step_ap242`, assembly structure, GVP write, self-check; `export_step_exact` delegating; also delivers 01 KRN FR-KRN-13 / TR-KRN-80 | M0, M1 | 3 |
| M3 Import verify (merged with 01 KRN M4, owner of `import_step_exact`, `importShapes`, `brep` leaf) | extension of `import_step_exact`: XDE product tree → components / instances, provenance, bands, `verify_exchange_file`; NIST gate | 01 KRN M4 | 2.5 |
| M4 IGES | `import_iges` (through 01's `importShapes`, `brep` leaf; sewing, census), `export_iges` | M0, 01 KRN M4 | 2 |
| M5 UI/CLI/MCP | dialogs, badge, report table, CLI exit codes, toolsets | M2–M4 | 2 |
| MVP total | | | **11** (was 13: the custom build, `massProperties` and the reader moved to 01 KRN M2 / M3 / M4) |
| V1 | PMI import/export (with 03), tessellated, layers/materials, archive package + verify, SFA gate | 03 GDT | 8 |
| V2 | QIF export, JT converter port, composites/kinematics mapping, AP242 XML read | 06 CMP | 6 |

## 11. Open questions / decisions needed

| Id | Question | Recommendation |
| -- | -------- | -------------- |
| Q1 | XCH on opencascade.js custom build (all callers) vs OCP Python bridge (desktop only)? | Custom build primary; Python interim |
| Q2 | JT: external converter only, or license a JT toolkit? | Converter port; no in-house parser |
| Q3 | Who owns STEP → B-rep import and its recipe leaf? | **Decided**: 01 KRN owns `import_step_exact`, `importShapes` and the `brep` blob leaf; XCH extends the command (verify, provenance, product tree) and defines no leaf of its own |
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

## 13. Implementation status (AERO-4 part 2, branch `feat/xch`)

Built: M0 (TKDESTEP/TKXCAF/TKXSBase/TKDEIGES linked; TKDEIGES optional at link, `LLULL_HAS_IGES`), M1 GVP (`geometric_validation_properties`, TS reader `lib/step21`), M2 (`export_step_ap242`, `export_step_exact` delegates to XDE, ply names and merged sheets carried), M3 (`import_step_exact` product tree, provenance, GVP check, `verify_exchange_file`), M4 (`import_iges`, `export_iges`), M5 (UI badge/report table/import-verify-export controls, CLI exit codes, `file=`/`--save`, toolsets, guide section 12). Kernel chain: core `writeExchange`/`importExchange` ports, `llull-kernel` ops, `xde.rs` cxx bridge.

Deviations: placements are `position` + Euler `rotation` (not a 4x4); `importExchange` also serves IGES (not `importShapes`); `mass_properties`/`measure_solid` expose `data.importUnverified` (not an `unverified` object); OCC writes reals with 13 significant digits (Q5), so byte-identity uses `canonicalizeStep21`; AP242 object identifier is `{1 0 10303 442 1 1 4 }` (Q6); the document unit is written as the file unit (inch documents carry inch numbers); product descriptions are patched by name match.

Measured: native GVP vs analytic references <= 1e-9 relative on 9 parts; AP242 and IGES round trips green (volume/area <= 3e-13 relative); TS reader equals the Python reference on all 28 NIST files; CTC-01 green (V 4.6e-8, centroid 5.9e-7 mm); FTC-09 AP203 inch green (9.8e-11); tampered volume x1.005 yellow, x1.5 red, red bodies refused by export (`XCH_UNVERIFIED_BODIES`, `XCH_HUMAN_GATE`). CTC-02 e2 is GREEN (V 4.9e-9) with product-level recompute; the pack's "red" came from 01 KRN measuring the first solid only. FTC-07 e2 is RED (embedded 105.3 mm3 vs 1.73e6 recomputed, a multi-shell product with open shells): unexplained, left red and reviewable. OCCT IGES samples bearing/hammer sew to open shells (25 and 2 free edges): `KRN_STEP_NO_SOLID`, reported with census, no solid is invented.

### PMI transport contract (hook for 03 GD&T M6)

`ExchangeProduct.pmi` (write) and `ImportedProduct.pmi` (read), type `ExchangePmi` in `geometry/kernelExchange.ts`: datums `{label, faces}`, tolerances `{characteristic, value, diameterZone, faces, datums[]}`, dimensions `{type, value, tolerance?{plus,minus}, faces, facesSecond?}`. Faces are 0-based `TopExp::MapShapes` indices of the product shape. Lengths: document unit on write, mm on kernel read, converted to the document unit in `report.exchange.products[].pmi`. AP242 only (other schemas refuse). Unknown faces/datums/characteristics refuse the write; unmappable items in a file count in `report.exchange.pmiUnmapped` with warning `XCH_PMI_UNMAPPED`. Verified: Rust and server round trips (flatness, position with datum and diameter zone, toleranced linear location), NIST CTC-01 census (1 flatness, 1 perpendicularity, 2 position, 2 surface profile). Not wired to the 03 model (`includePmi` not implemented).

Deferred: JT (converter port, `XCH_CONVERTER_MISSING`), QIF, LOTAR archive package, tessellated read/write modes, SFA gate, PMI wiring to the 03 model and presentation PMI, IGES header timestamp non-determinism. The `llull-kernel` bin tests can fail in parallel (shared OCCT statics); run with `--test-threads=1`.
