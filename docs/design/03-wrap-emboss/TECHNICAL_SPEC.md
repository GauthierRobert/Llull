# WRP — Curves and features on curved faces, 3D text — Technical specification

Gap id: **WRP** · Companion: [FUNCTIONAL_SPEC.md](FUNCTIONAL_SPEC.md) · Validation: [validation/README.md](validation/README.md) ·
Laws: `.claude/rules/architecture.md` L1–L10 · Directive: LC1 local-only (native kernel is the target path) · Status: specification
(2026-10-22), nothing built.

---

## 1. Current state in llull

### 1.1 Commands and code nearest to this gap

| Capability                | Command                                                        | Files                                                                                                                                                                                                                                                     | What it really does                                                                                                                                                                                                                                                                         | What it does not do                                                                                                                                                                                                                      |
| ------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Annotation text           | `add_text`                                                     | `packages/core/src/commands/draw2d/annotate.ts`, `model/types.ts` `TextEntity`                                                                                                                                                                            | 2D entity `{ content, height (cap height), anchor left/center/right }` placed on the work plane by `position` / `rotation`                                                                                                                                                                  | No font, no outline, no area; `extrude_profile` refuses kind `text` (`commands/solids/profile.ts`, `CLOSED_SHAPE_KINDS`); not usable by any 3D command                                                                                   |
| Text decal                | `add_decal`, `delete_decal`                                    | `commands/edit/decals.ts`, `lib/blockFont.ts` (108 lines), `geometry/decal.ts`                                                                                                                                                                            | Paints a ≤ 64-character line onto a solid: built-in **5×7 block raster font** (A–Z, 0–9, `- . , : / + & ! ? ' #`, lower case as capitals, unknown characters blank with a note), projected along −`normal` onto faces within a box, stored in the entity-local frame, exported to glTF only | Not geometry (never in STL / STEP); projection, not wrap; no outline font                                                                                                                                                                |
| Surface roughness PMI     | `add_surface_texture`                                          | `commands/pmi/annotation.ts`                                                                                                                                                                                                                              | Ra / Rz / … requirement on faces (OCC topology), `review: REVIEW_REQUIRED`                                                                                                                                                                                                                  | No knurl, no pattern, no geometry                                                                                                                                                                                                        |
| Sketch plane              | `create_sketch_plane`, `place_on_sketch_plane`                 | `commands/draw2d/sketchPlanes.ts`, `model/sketchPlanes.ts`                                                                                                                                                                                                | Named plane from a world plane or a **planar** face (persistent face name, `REF_LOST` when gone), offset and spin; places 2D entities on it                                                                                                                                                 | Refuses non-planar faces ("face N is cylinder, not planar")                                                                                                                                                                              |
| Edges into a sketch       | `project_edges_to_sketch`, `break_sketch_link`                 | `commands/draw2d/sketchLinks.ts`                                                                                                                                                                                                                          | Projects solid **edges onto a plane** (or their crossing points), linked by persistent edge names                                                                                                                                                                                           | The opposite direction of this gap (3D → plane, never plane → face)                                                                                                                                                                      |
| Face split                | `split_face`                                                   | `commands/brep/faceOps.ts` (`FaceOpParams.kind 'splitFace'`, `model/faceOps.ts`)                                                                                                                                                                          | Cuts picked faces by a **plane**; the body stays one solid                                                                                                                                                                                                                                  | No split by curves (no split line, no scribe)                                                                                                                                                                                            |
| Sheet trim by curves      | `trim_surface`                                                 | `commands/surface/trimSurface.ts`, `lib/nurbs/trimLoops.ts`                                                                                                                                                                                               | Projects `nurbs_curve`s onto a **`nurbs_surface` sheet** (closest point or `projectAlong`) and stores (u, v) trim loops                                                                                                                                                                     | Sheets only, not faces of solids; no wrap                                                                                                                                                                                                |
| Sheet-metal bead          | `add_bead`                                                     | `packages/domain-aero/src/sheetmetal/commands/bead.ts`                                                                                                                                                                                                    | Straight formed rib on one flat of a sheet-metal part                                                                                                                                                                                                                                       | Flat faces only, straight path                                                                                                                                                                                                           |
| Developed chart of a face | (internal, 06 CMP)                                             | `packages/domain-aero/src/composites/surface.ts` (`toFlat`, `fromFlat`, `isDoublyCurved`), `curved.ts`                                                                                                                                                    | Plane: face frame; **cylinder: (r·azimuth, axial)**; **cone: polar development, angle = azimuth · sin(semi-angle)**; sphere: azimuthal equidistant; NURBS: scaled (u, v)                                                                                                                    | Lives in a **plugin** (core cannot use it); sphere / NURBS charts are not isometric (plies use drape there)                                                                                                                              |
| Exact region slab         | `faceSlab` recipe node                                         | `model/faceSlab.ts`, `geometry/surfaceWire.ts` (`encodeSurface`, `encodeLoops`, `loopsProblem`), `domain-aero/src/composites/plySlab.ts`, native `face_slab` in `solver/crates/llull-kernel-occt/cpp/surfaces.cxx`, `server/src/native/kernelFeatures.ts` | A plane / cylinder / cone / B-spline face bounded by (u, v) loops, lifted along its normal from `from` to `to`: base face, face on `Geom_OffsetSurface`, one ruled wall per loop edge (`BRepFill::Face`), sewn into a solid                                                                 | Loops are **polygons** (no curved pcurves; cone edges are cut into 24 pieces by `plySlab.ts`); **exactly one outer loop** + holes (`loopsProblem`); Manifold does not support it (`kernel-manifold/src/manifoldKernel.ts` `unsupported`) |
| Face queries              | `FaceQueryPort` (`ctx.kernel.faceQuery`)                       | `packages/core/src/geometry/kernelPorts.ts`                                                                                                                                                                                                               | `faceGeometry` (plane / cylinder / cone / sphere / torus / other params + uv bounds), `evaluateFace`, `projectOnFace`, `tessellateFace` (+ uv), `faceSamples`, `bspline`, `distance`                                                                                                        | No curve projection, no curve-on-face construction, no split by edges                                                                                                                                                                    |
| Curves                    | `create_nurbs_curve`, `interpolate_curve`, `approximate_curve` | `commands/surface/createCurve.ts`, `lib/nurbs/`                                                                                                                                                                                                           | Exact 3D NURBS curve entity (`nurbs_curve`)                                                                                                                                                                                                                                                 | No "lies on face" link, no pcurve                                                                                                                                                                                                        |
| Patterns, threads         | `pattern_along_path`, `set_thread`, `add_external_thread`      | `commands/edit/patternAlongPath.ts`, `commands/features/*`                                                                                                                                                                                                | Pattern along a path; cosmetic / modeled threads                                                                                                                                                                                                                                            | No pattern in a face chart, no knurl                                                                                                                                                                                                     |

`git grep -n "name: '<name>'" -- packages` returns nothing for every command this pack proposes (§4): `wrap_to_face`,
`project_to_face`, `create_curve_on_face`, `unwrap_face`, `emboss_on_face`, `split_face_by_curves`, `import_font`, `list_fonts`,
`text_outline`, `explode_text`, `check_wrap`, `add_knurl`, `pattern_on_face` (checked 2026-10-22 on `origin/main`, 696 command names).

### 1.2 Kernel facts

| Fact                                                                                                                                                                                 | Consequence                                                                                                                                                             | Source                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| The OCCT 7.9.2 prefix is built with `USE_FREETYPE` OFF and the Visualization module off ("built without any windowing or font backend")                                              | `Font_BRepFont` (an alias of `StdPrs_BRepFont`, TKV3d, FreeType-based) cannot render glyphs; enabling it means bundling FreeType and rebuilding the prefix (~45–60 min) | [R17] [R18]                                       |
| `BRepProj_Projection` gives cylindrical (along a direction) and conical projections of edges / wires on a shape                                                                      | `project_to_face` along a direction                                                                                                                                     | [R17]                                             |
| `BRepOffsetAPI_NormalProjection`: projection "according to the normal from each point"; defaults Tol3D 1e-4, Tol2D √Tol3D, C2, MaxDegree 14, MaxSeg 16; `SetMaxDistance`, `SetLimit` | `project_to_face` closest-point mode; llull sets Tol3D explicitly (§5.9)                                                                                                | [R17]                                             |
| `BRepFeat_SplitShape`: add wires / edges **on** a face, rebuild the shape with the split faces; `BRepAlgoAPI_Splitter` splits arbitrary shapes by tools (General Fuse)               | Scribe and split line                                                                                                                                                   | [R17]                                             |
| `BRepFeat_MakePrism` / `BRepFeat_MakeDPrism`: local prism / draft prism protrusions or depressions from a face                                                                       | Pull-direction walls and draft (FR-WRP-13)                                                                                                                              | [R17]                                             |
| The native `face_slab` builds exact walls and offset faces for plane / cylinder / cone / B-spline faces and is unit-tested in `features.rs`                                          | The MVP emboss is an extension, not a new algorithm                                                                                                                     | `solver/crates/llull-kernel-occt/src/features.rs` |

## 2. Target architecture

### 2.1 Layer placement

| Piece                                                                                                        | Layer                                                                                                                                                                      | Why (law)                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Face charts (develop, geodesic polar, parametric), seam handling, distortion metrics                         | `packages/core/src/geometry/surfaceChart.ts` (+ `geodesicChart.ts`), promoted from `domain-aero/src/composites/surface.ts`; composites then imports the core module        | Pure math used by core commands and by the composites plugin; core never imports a plugin (L2, L10)                                    |
| Font reader (TrueType `glyf`, later CFF), layout (advances, kerning), nonzero union of outlines              | `packages/core/src/lib/font/*` (pure leaf: `sfnt.ts`, `cmap.ts`, `glyf.ts`, `cff.ts`, `layout.ts`, `fill.ts`), each ≤ 500 lines                                            | Pure, deterministic, no DOM / no native dependency; replay must not depend on a host library version (L3, FR-WRP-45); decision D-WRP-2 |
| Text outline of a `TextEntity`                                                                               | `packages/core/src/geometry/textOutline.ts`                                                                                                                                | Entity-aware wrapper (same split as `lib/nurbs` / `geometry/nurbsCurve.ts`)                                                            |
| Font bytes for bundled / system fonts                                                                        | injected `FontProvider` port `ctx.fonts` (`packages/core/src/geometry/fontPort.ts`), implemented in `server/` (bundled OFL fonts shipped with the desktop app and the CLI) | Commands never read files (L2); same injection pattern as `ctx.kernel` (L9)                                                            |
| Commands (`wrap_to_face` … `check_wrap`, `add_knurl`)                                                        | new core feature catalog `packages/core/src/commands/wrap/catalog.ts` (toolset `3d`, plus a `wrap` view in `@protocol/toolsets`)                                           | Domain-neutral design capability (L5); not a plugin (every domain wraps text)                                                          |
| Exact construction (curve projection, curves on face, emboss / deboss / scribe, split by curves, pull walls) | `GeometryKernel` / `FaceQueryPort` additions + native `llull-kernel-occt` (`cpp/wrap.cxx`, `src/wrap.rs`), reached through `server/src/native/*`                           | Kernel only via `ctx.kernel`, `requiresKernel: true` (L9); native C++ because the operations are OCCT algorithms (C7)                  |
| Visual review (curves on face, distortion overlay, knurl texture)                                            | `src/ui/viewport/3d/*` render branches fed by entities and `check_wrap` data                                                                                               | Presentation only (L1, L4)                                                                                                             |

### 2.2 Data flow

```
CLI / UI ──execute──> add_text { font } ─────────────> TextEntity (font id) ─ geometry/textOutline (lib/font, doc.blobs) ─> loops
                     import_font { path } ─(host)─────> doc.fonts[id] + doc.blobs[sha256] (font bytes)
                     emboss_on_face { id, face, profileIds, mode, depth, placement }
                        ├─ face pick (persistent name) ─ ctx.kernel.faceQuery.faceGeometry -> SurfaceParams
                        ├─ geometry/surfaceChart: sketch loops (chart) -> (u, v) pcurve loops (exact for plane / cylinder, fitted for cone)
                        └─ recipe { op: 'emboss', source, face, surface, regions, from, to, boolean } -> native: face_slab per region + fuse / cut
                     check_wrap ──────────────────────> reads steps' recorded data + recomputes limits -> findings
```

### 2.3 Laws check

- L1 / L5: every operation is a `defineCommand`; queries (`text_outline`, `unwrap_face`, `check_wrap`, `list_fonts`) return `data`.
- L3 / L8: params are design intent (entity ids, face reference by persistent name, anchor, angle, depth, mode, method) — never
  agent-computed point lists; ids step-scoped; the emboss recipe is re-derived on replay from the step params.
- L4: wrapped curves are `nurbs_curve` entities created by the command; the emboss result is the solid's recipe (`MeshSolidEntity.brep`).
- L7: the sketch stays 2D (one model); the wrap is the 2D ⇄ 3D bridge for faces, like `extrude_profile` for planes.
- L9: chart math and fonts are core (no B-rep); exact curves, splits and solids go through `ctx.kernel` with `requiresKernel`.
  Manifold: `supports('emboss') = false`, the face commands refuse with `CMD_KERNEL_UNAVAILABLE`.
- **Tension to surface (D-WRP-1):** `DocumentBlob` is defined for UTF-8 text payloads (`sha256` of the decoded text, media types
  `model/*`); fonts are binary. Proposed: add `font/ttf` and `font/otf` media types with `sha256` of the raw bytes (base64 stays the
  transport). This touches the blob invariant in `model/types.ts` and the persistence guard — a core contract change, so it is an
  owner decision, not done silently.

## 3. Data model

```ts
// packages/core/src/model/fonts.ts (new) — CadDocument.fonts?: Readonly<Record<string, FontRecord>>
export interface FontRecord {
  readonly id: string; // step-scoped id, e.g. "font-3.1"
  readonly family: string; // name table ID 1 / 16
  readonly style: string; // name table ID 2 / 17
  readonly blob: string; // sha256 key in CadDocument.blobs (mediaType 'font/ttf' | 'font/otf', D-WRP-1)
  readonly format: 'truetype' | 'cff';
  readonly unitsPerEm: number;
  readonly capHeight: number; // OS/2 sCapHeight (font units); fallback: height of 'H' outline, reported
  readonly embedding: 'installable' | 'editable' | 'preview_print'; // OS/2 fsType; 'restricted' is never stored (refused)
  readonly licence?: string; // e.g. "SIL OFL 1.1" (name table ID 13 / caller-supplied)
  readonly provenance: { readonly verified: boolean; readonly source?: string }; // bundled fonts: verified (pinned sha256)
  readonly singleLine?: boolean; // open-stroke engraving font (FR-WRP-24)
}

// packages/core/src/model/types.ts — TextEntity v2 (additive, optional fields)
export interface TextEntity extends BaseEntity {
  readonly kind: 'text';
  content: string;
  height: number; // cap height (unchanged meaning)
  anchor?: 'left' | 'center' | 'right';
  font?: string; // FontRecord id or a bundled family name resolved by import on first use
  verticalAnchor?: 'baseline' | 'cap_middle' | 'cap_top'; // default baseline (today's behaviour)
  letterSpacing?: number; // document units added after each glyph (default 0)
  kerning?: boolean; // default true (SHOULD; MVP ignores)
  lineSpacing?: number; // multiple of the font line gap (SHOULD)
}
// Without `font` a text entity is an annotation as today (not a profile). With `font` it is a closed profile: loops = nonzero union of the
// glyph outlines, placed by anchor / position / rotation (geometry/textOutline.ts).

// packages/core/src/model/wrap.ts (new) — the placement shared by wrap_to_face / emboss_on_face / add_decal(mapping 'wrap')
export type ChartMethod = 'develop' | 'geodesic' | 'parametric' | 'project';
export interface WrapPlacement {
  readonly method: ChartMethod; // 'develop' only on plane / cylinder / cone (K = 0)
  readonly anchor: { readonly chart: Vec2; readonly on: Vec3 }; // sketch-local point <-> point on (near) the face
  readonly angleDeg: number; // sketch +x vs the face reference direction (cylinder / cone: circumferential, +azimuth)
  readonly mirror: boolean; // flip the sketch y axis (wrap seen from inside)
  readonly direction?: Vec3; // method 'project' only (default: sketch plane normal, toward the face)
}
export interface FaceRef {
  readonly faceIndex?: number;
  readonly faceNear?: Vec3;
  readonly faceName?: string;
}

// nurbs_curve entities made by wrap / project / curve-on-face carry where they lie (render, split, check, regeneration)
export interface CurveOnFace {
  readonly entityId: string; // the solid
  readonly faceName: string; // persistent face name (SC-N1)
  readonly pcurve: NurbsCurve2Data; // (u, v) curve; exact for affine charts, fitted within `fitTolerance` otherwise
  readonly fitTolerance: number; // document units (3D), 0 when exact
  readonly chartLength: number; // length in the sketch (chart) frame
}
// NurbsCurveEntity gains `onFace?: CurveOnFace` (optional, additive).

// ShapeRecipe — one new node (exact kernels only), lowered by the native kernel to face_slab per region + fuse / cut / split
export interface EmbossRecipe {
  readonly op: 'emboss';
  readonly source: ShapeRecipe;
  readonly face: number; // unique face index of `source` at evaluation (resolved from the persistent name by the command)
  readonly surface: FaceSlabRecipe['surface']; // wire form (plane / cylinder / cone / bspline), as faceSlab
  readonly regions: ReadonlyArray<UvRegion>; // one outer loop + its holes per region (a text = one region per outer contour)
  readonly mode: 'emboss' | 'deboss' | 'scribe' | 'engrave';
  readonly depth: number; // > 0, document units (0 for scribe)
  readonly walls: { readonly kind: 'normal' } | { readonly kind: 'pull'; readonly direction: Vec3; readonly draftDeg: number };
  readonly toolWidth?: number; // engrave only (V2)
  readonly tolerance: number; // sewing / fit tolerance, document units
}
export interface UvRegion {
  readonly outer: UvLoop;
  readonly holes: ReadonlyArray<UvLoop>;
}
/** A closed (u, v) loop of segments: polygon edges (today's encoding) or 2D NURBS pcurves (new, TR-WRP-05). */
export type UvLoop = ReadonlyArray<
  { readonly kind: 'line'; readonly to: Vec2 } | { readonly kind: 'nurbs'; readonly curve: NurbsCurve2Data }
>;

// Knurl (cosmetic), stored with the PMI model so drawings, STEP AP242 PMI and check_pmi see it
export interface KnurlPmi {
  readonly id: string;
  readonly kind: 'knurl';
  readonly pattern: 'straight' | 'diagonal' | 'diamond';
  readonly pitch: number; // circular pitch actually used, document units
  readonly requestedPitch: number;
  readonly teeth: number; // integer, closes around the circumference
  readonly helixAngleDeg?: number; // diagonal / diamond (default 30, named, D-WRP-8)
  readonly feature: PmiFeatureRef; // faces (existing PMI feature reference)
  readonly review: PmiReview; // REVIEW_REQUIRED like add_surface_texture
}
```

Document version / migration: all fields are optional and additive (`fonts?`, `TextEntity.font?`, `NurbsCurveEntity.onFace?`, new
recipe node, new PMI kind); persistence stays at the current version unless D-WRP-1 (binary blobs) needs a bump; old readers already
reject unknown recipe ops and kinds. `recipeKey` (`geometry/shapeRecipe.ts`) gets an `emboss` case (all non-presentation fields).

## 4. Commands

Notation: Q = query, M = mutating (feature step). K = `annotations.requiresKernel: true`. Toolset `3d` (CLI view `wrap`).
Face references use the existing pattern `{ faceIndex | faceNear | faceName }` + recorded `faceNames` (as `create_sketch_plane`).

| Command                   | Q/M | K           | Params (sketch)                                                                                                                                                                                                                                                                      | @affects                                                                        | @invariant                                                                                                                                                   | @failure (code)                                                                                                                                                                                                                                                                                             |
| ------------------------- | --- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `import_font`             | M   | –           | `path` (CLI / desktop exchange, read by the host) or `base64`; `name?`; `licence?` (text, e.g. "SIL OFL 1.1")                                                                                                                                                                        | `doc.fonts[id]` + `doc.blobs[sha256]`                                           | parsed fully before storing; `fsType` allows embedding; ≤ 4 MB                                                                                               | not a font / truncated → `WRP_FONT_PARSE`; CFF before V1 → `WRP_FONT_FORMAT_UNSUPPORTED`; fsType 2 → `WRP_FONT_EMBEDDING_RESTRICTED`; too big → `WRP_FONT_TOO_LARGE`                                                                                                                                        |
| `list_fonts`              | Q   | –           | —                                                                                                                                                                                                                                                                                    | —                                                                               | bundled (provider) + document fonts with family, style, format, licence, `verified`                                                                          | —                                                                                                                                                                                                                                                                                                           |
| `add_text` (extended)     | M   | –           | existing + `font?`, `verticalAnchor?`, `letterSpacing?`, `kerning?`, `lineSpacing?`                                                                                                                                                                                                  | 1 text entity                                                                   | with `font`: outline resolvable; missing glyphs listed                                                                                                       | unknown font → `WRP_FONT_UNAVAILABLE` (remediation: `list_fonts` / `import_font`); missing glyphs → warning `WRP_GLYPH_MISSING` (step succeeds)                                                                                                                                                             |
| `text_outline`            | Q   | –           | `id` (text with font), `output?: 'summary' \| 'glyphs' \| 'loops'`, `kerning?`                                                                                                                                                                                                       | —                                                                               | `data { loops, outerLoops, holes, area, areaUnit, outlineLength, advanceWidth, lengthUnit, bbox, glyphs[]?, font {family, sha256}, unverified, provenance }` | not a font text → `WRP_TEXT_NO_FONT`                                                                                                                                                                                                                                                                        |
| `explode_text` (COULD)    | M   | –           | `id`                                                                                                                                                                                                                                                                                 | replaces the text by closed `nurbs_curve` 2D loops (quadratic B-splines, exact) | area unchanged                                                                                                                                               | —                                                                                                                                                                                                                                                                                                           |
| `unwrap_face`             | Q   | K           | `id`, `face`, `includeCurves?` (curves on face)                                                                                                                                                                                                                                      | —                                                                               | `data { developable, surfaceKind, sectorAngleRad?, innerRadius?, outerRadius?, radius?, area, outline: chart polylines (bounded), curves[] }`                | K ≠ 0 → `WRP_FACE_NOT_DEVELOPABLE`                                                                                                                                                                                                                                                                          |
| `wrap_to_face`            | M   | K           | `id`, `face`, `entityIds` (2D entities incl. font text), `placement: WrapPlacement` (method default `develop` on K = 0 faces, else required), `fitTolerance?`                                                                                                                        | N `nurbs_curve` entities with `onFace`                                          | develop: chart length = 3D length (≤ 1e-9 rel); `data.curves[] {id, chartLength, length3d, maxLengthStrain}`, `data.distortion`, `data.exact`                | region leaves face → `WRP_OUTSIDE_FACE`; overlap → `WRP_WRAP_OVERLAP`; anchor not on face → `WRP_ANCHOR_OFF_FACE`; develop on K ≠ 0 → `WRP_FACE_NOT_DEVELOPABLE`                                                                                                                                            |
| `project_to_face`         | M   | K           | `id`, `faces?` (default all), `entityIds`, `direction?: vec3` (default sketch normal toward the solid) **or** `mode: 'closest'`, `maxDistance?`                                                                                                                                      | N `nurbs_curve` with `onFace`                                                   | `data.curves[] {id, faceName, length3d}`, `data.missed[] {entityId, fraction}`                                                                               | nothing lands → `WRP_PROJECTION_MISSES_FACE`                                                                                                                                                                                                                                                                |
| `create_curve_on_face`    | M   | K           | `id`, `face`, `mode: 'geodesic' \| 'isoparametric' \| 'uv'`; geodesic: `from`, `to` (points on face); iso: `through` + `direction: 'u'\|'v'`; uv: `uv: [u,v][]`                                                                                                                      | 1 `nurbs_curve` with `onFace`                                                   | geodesic on K = 0 faces = chart segment (exact)                                                                                                              | endpoints off face → `WRP_ANCHOR_OFF_FACE`; no geodesic found → `WRP_GEODESIC_FAILED`                                                                                                                                                                                                                       |
| `emboss_on_face`          | M   | K           | `id`, `face`, `profileIds` (closed 2D profiles, font texts), `mode: 'emboss' \| 'deboss' \| 'scribe' \| 'engrave'`, `depth` (> 0 except scribe), `placement: WrapPlacement`, `walls?: 'normal' \| 'pull'`, `pullDirection?`, `draftDeg?`, `toolWidth?` (engrave), `maxLengthStrain?` | replaces the solid (same id, recipe `emboss`)                                   | `data { volumeDelta, volumeUnit, regionArea, regions, loops, method, exact, distortion, faceKind, angularSpanRad?, unverified, provenance }`                 | open profile (emboss / deboss) → `WRP_PROFILE_OPEN`; self-intersection → `WRP_PROFILE_SELF_INTERSECT`; depth ≤ 0 → `WRP_DEPTH_INVALID`; deboss deeper than the material (radius / wall) → `WRP_DEPTH_EXCEEDS_SOLID`; strain > limit → `WRP_DISTORTION_EXCEEDED`; kernel failure → `WRP_KERNEL_BUILD_FAILED` |
| `split_face_by_curves`    | M   | K           | `id`, `curveIds` (`nurbs_curve` with `onFace` on this solid), (silhouette: the separate command `split_at_silhouette`, §14.7)                                                                                                                                                        | replaces the solid; split faces get new persistent names                        | `data { facesBefore, facesAfter, faces[] {name, area} }`                                                                                                     | curve not on a face of `id` → `WRP_SPLIT_CURVE_NOT_ON_FACE`; nothing split → `WRP_SPLIT_NO_EFFECT`                                                                                                                                                                                                          |
| `check_wrap`              | Q   | K for faces | `ids?` (default every WRP result), `maxLengthStrain?`, `minFeatureSize?`, `fitTolerance?`                                                                                                                                                                                            | —                                                                               | `data { status, findings[] {code, severity, ids, value, limit, unit, remediation}, limits: Record<string, NamedTolerance>, unverified, provenance }`         | unknown id → `WRP_ENTITY_NOT_FOUND`                                                                                                                                                                                                                                                                         |
| `add_decal` (extended)    | M   | –           | existing + `font?`, `mapping?: 'project' \| 'wrap'`                                                                                                                                                                                                                                  | appends 1 decal                                                                 | wrap: the decal width is an arc length on the face                                                                                                           | `WRP_FONT_UNAVAILABLE`, `WRP_FACE_NOT_DEVELOPABLE` (wrap on K ≠ 0)                                                                                                                                                                                                                                          |
| `add_knurl`               | M   | K           | `id`, `face` (cylindrical), `pattern`, `pitch`, `helixAngleDeg?`, `model?: 'cosmetic' \| 'geometry'` (geometry COULD, 02 SWG)                                                                                                                                                        | 1 `KnurlPmi` (+ geometry when asked)                                            | teeth integer; `data { teeth, pitch, requestedPitch }`                                                                                                       | not a cylinder → `WRP_KNURL_FACE_NOT_CYLINDER`; adjusted pitch → warning `WRP_KNURL_PITCH_ADJUSTED`                                                                                                                                                                                                         |
| `pattern_on_face` (COULD) | M   | K           | `id`, `face`, `seedProfileIds`, `mode`, `depth`, `grid { countX, countY, pitchX, pitchY }` in chart units, `placement`                                                                                                                                                               | replaces the solid                                                              | instances fully inside the face or refused                                                                                                                   | `WRP_OUTSIDE_FACE`                                                                                                                                                                                                                                                                                          |

Descriptions (AF-02) state for each: what it does, units, the face kinds per method, what it refuses, and the next command
(`check_wrap`, `mass_properties`, `render_view`).

## 5. Kernel / algorithms

### 5.1 Developed charts (core `geometry/surfaceChart.ts`)

Chart = the sketch's own 2D frame after placement: `c = R(angleDeg) · M(mirror) · (p − anchor.chart)`, then mapped by the face kind.
The anchor face point `on` is projected to the face (`faceQuery.projectOnFace`) to get its parameters (θ₀, z₀) / (s₀, θ₀).

| Face                              | Chart (x, y) → face                                                                    | (u, v) of the OCC surface                                                             | Exact?                                                                      |
| --------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Plane (origin O, xDir, yDir)      | O + x·xDir + y·yDir                                                                    | affine                                                                                | yes, pcurves = sketch curves                                                |
| Cylinder (axis A, xDir, radius r) | azimuth θ = θ₀ + x / r, axial z = z₀ + y                                               | u = θ, v = z: **affine**                                                              | yes: lines → helices, arcs / B-splines keep their (affine) form in (u, v)   |
| Cone (apex, axis, semi-angle α)   | polar chart about the apex image: ρ = slant distance s, chart angle φ = (θ − θ₀) sin α | u = azimuth, v = s (as `plySlab.ts`: `[-θ/ sin α, ρ]` with the kernel's azimuth sign) | lengths exact; pcurves **fitted** (map is not affine) within `fitTolerance` |

Isometry: plane, cylinder and cone have K = 0; the chart preserves every length and area (VC-WRP-01, 02, 06, 07 cross-check this
numerically to ≤ 1e-8). Cone development: sector angle 2π sin α, radii s₁ = r_top / sin α, s₂ = r_base / sin α
(`validation/data/cone_development.json`).

Seam and wrap-around (FR-WRP-06): the chart x range is unwrapped continuously (no modulo) from the anchor; a region spanning
Δθ = Δx / r > 2π (cylinder) or Δφ > 2π sin α (cone) overlaps itself → `WRP_WRAP_OVERLAP`; a region crossing θ = 0 of the periodic
surface is split along the seam into pcurves on both sides (OCC periodic surface, u ∈ [0, 2π)) and re-joined by the kernel. A
region outside the face's trimmed (u, v) domain (`uvBounds` + `faceContains`) → `WRP_OUTSIDE_FACE` with the offending loop.

### 5.2 Doubly curved faces (V1)

- **Geodesic polar (exponential) map** at the anchor: a chart point at polar (ρ, ψ) maps to the end of the geodesic of length ρ
  leaving the anchor in direction ψ (measured from the reference direction). Geodesics are integrated on the face
  (`d²x/dt² + Γ(x)(ẋ, ẋ) = 0` in (u, v), RK4 with step ≤ fitTolerance-driven, Christoffel symbols from `faceSamples` derivatives —
  native, §5.8). Radial lengths are exact by construction; circumferential lengths scale by the Jacobi field; on a sphere of radius
  R the strain is sin(ρ/R)/(ρ/R) − 1 and the area ratio 2R²(1 − cos(ρ/R))/(πρ²) (`sphere_geodesic_wrap.json`, VC-WRP-08).
- **Parametric map** (Rhino ApplyCrv / FlowAlongSrf style [R6] [R7]): (u, v) = (u₀ + x / L_u, v₀ + y / L_v), with L_u, L_v the
  arc-length rates of the iso curves through the anchor. Cheap and covers the whole face, distortion grows with uneven
  parameterisation — reported, never hidden.
- **Distortion metrics** (TR-WRP-11): for each mapped curve, the max relative length strain over its chart segments sampled at ≤
  0.5 mm (or 1/200 of the chart size); for each region, the area ratio (3D face area of the image ÷ chart area, by
  `tessellateFace` + uv quadrature). `data.distortion = { maxLengthStrain, meanLengthStrain, areaRatio, worst {chart, point} }`.
- Limit: `maxLengthStrain` given, else the named default **0.02** (2 %, `source: "llull WRP default (D-WRP-4)"`, `defaulted:
true`); above it `emboss_on_face` refuses (`WRP_DISTORTION_EXCEEDED`) and `check_wrap` fails (`WRP_CHECK_DISTORTION`).

### 5.3 Emboss / deboss / scribe construction (native)

1. Collect closed loops of the profiles (text: §5.4 union), orient (outer CCW, holes CW), group into regions (one outer + holes).
2. Map every loop through the chart to (u, v) pcurves (exact for plane / cylinder, fitted for cone / doubly curved, §5.1–5.2).
3. **Normal walls** (MVP): per region `face_slab(surface, region, from, to)` — emboss `[0, d]` outward, deboss `[−d, 0]` — with the
   loop encoding extended to B-spline pcurve segments (TR-WRP-05); then one fuse (emboss) or cut (deboss) of all slabs with the
   source in a single boolean (`BRepAlgoAPI_Fuse` / `Cut` with a tool list, as `boolean` does). Deboss slabs start 1e-6 × size outside
   the face so the cut does not leave coincident faces (named tolerance).
4. **Pull walls** (V1): extrude the wrapped wire along `pullDirection` (`BRepFeat_MakePrism`, or `BRepFeat_MakeDPrism` with
   `draftDeg`) from the face up to the offset face, as a local operation on the picked face [R17].
5. **Scribe**: build edges from the pcurves on the face (`BRepBuilderAPI_MakeEdge(pcurve, surface)` + `BRepLib::BuildCurves3d`) and
   split with `BRepFeat_SplitShape::Add(wire, face)`; new faces get persistent names from the history (SC-N1).
6. Validity: `BRepCheck_Analyzer` on the result; failure → `WRP_KERNEL_BUILD_FAILED` with the region index.

Volume references (Steiner formula of a normal offset, dV = (1 + 2Hn + Kn²) dA dn): plane V = A d; cylinder emboss
V = A d (1 + d/2r), deboss A d (1 − d/2r); cone V = A d + (d²/2) cot α · Φ (s₂ − s₁) for an annular chart sector
(`emboss_volumes.json`, cross-checked by Pappus and quadrature to ≤ 1e-12). `emboss_on_face` reports `volumeDelta` from the kernel
mass properties; `check_wrap` compares it with the closed form when the face is analytic and flags a mismatch above 1e-6 relative
(`WRP_CHECK_VOLUME_MISMATCH`, an internal-consistency guard).

Depth guard: deboss depth must be < the face's minimum radius of curvature (cylinder: r) and < the local wall thickness (distance
from the face to the opposite side, `faceQuery.distance` along −normal at region samples) → else `WRP_DEPTH_EXCEEDS_SOLID`.

### 5.4 Fonts and text outlines (core `lib/font/`)

| Step                                                                                            | Rule                                                                                                                                                                                                                                                  | Source                              |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Table directory, `head`, `maxp`, `hhea`, `hmtx`, `OS/2`, `name`, `cmap` (4, 12), `loca`, `glyf` | Bounded reads (every offset checked against the table length), depth limit 8 for composites, glyph count ≤ maxp                                                                                                                                       | [R19] [R20]                         |
| Simple glyphs                                                                                   | Flags (on-curve, short vectors, repeat), delta-coded coordinates; implied on-curve midpoint between two off-curve points; segments = lines and quadratic Béziers                                                                                      | [R19]                               |
| Composite glyphs                                                                                | Component offsets (`ARGS_ARE_XY_VALUES`), scale / x-y scale / 2×2 (`x′ = xscale·x + scale10·y`, `y′ = scale01·x + yscale·y`); point-matching placement refused (`WRP_FONT_PARSE`, rare)                                                               | [R19]                               |
| Fill rule                                                                                       | Nonzero winding; overlapping contours (`OVERLAP_SIMPLE`, `OVERLAP_COMPOUND`, common in variable fonts) are united with an exact-curve 2D boolean of the loops before use (polygonal union at 1e-6 em, then the original curve pieces are re-attached) | [R19] [R12]                         |
| Area / length                                                                                   | Exact Green area per quadratic segment: ∮(x dy − y dx) = (2/3)(P₀×C + C×P₁) + (1/3)(P₀×P₁); outline length by adaptive Gauss                                                                                                                          | `validation/generate_font_refs.mjs` |
| Scale                                                                                           | `height` = cap height → scale = height / `OS/2.sCapHeight` (fallback: top of 'H', reported in provenance)                                                                                                                                             | [R20]                               |
| Layout                                                                                          | Advance widths (`hmtx`), pair kerning from `kern` / GPOS PairPos (V1), letter spacing, anchors, lines                                                                                                                                                 | —                                   |
| CFF (V1)                                                                                        | Type 2 charstrings (cubic) in a separate `cff.ts`; same outputs                                                                                                                                                                                       | D-WRP-2                             |
| Embedding                                                                                       | `fsType & 0xF`: 0 installable, 2 restricted → refuse, 4 preview & print, 8 editable; bit 0x0200 "bitmap embedding only" → refuse                                                                                                                      | [R20]                               |

Exactness: TrueType outlines are quadratic, i.e. degree-2 B-splines — represented exactly as `NurbsCurve2Data` (degree 2) in the
(u, v) pcurves on plane and cylinder faces (affine map), so the embossed letters are exact to the font's own geometry.

Bundled default font (D-WRP-3): Fira Sans Regular (OFL 1.1, pinned sha256 `c29556a2…0f93c23`, 456 996 bytes, unitsPerEm 1000,
cap height 689, fsType 0 = installable) [R24] — measured by the reference script; plus a single-line font for engraving in V2
(Relief SingleLine, OFL) [R25].

### 5.5 Projection (native)

`project_to_face` along a direction: `BRepProj_Projection(wire, shape, direction)` (cylindrical projection) restricted to the picked
faces; closest point: `BRepOffsetAPI_NormalProjection` with `SetParams(Tol3D = fitTolerance (default 1e-6 × model size), …,
GeomAbs_C2, 14, 16)`, `SetMaxDistance(maxDistance)`, `SetLimit(true)` [R17]. Each result edge yields a `nurbs_curve` (3D curve) and its
pcurve. Missed parts are reported per source entity as a covered fraction.

### 5.6 Curves on face (native)

Geodesic between two points: shooting on the face (initial direction from the chart line on K = 0 faces — exact; Newton on the
initial angle elsewhere), result approximated by `GeomAPI_PointsToBSpline` within `fitTolerance`. Isoparametric: `Geom_Surface::UIso
/ VIso` through the projected point, trimmed to the face. uv spline: interpolate (u, v) points (core `lib/nurbs` interpolation in
2D) → pcurve → 3D curve.

### 5.7 Decals and knurls

- `add_decal mapping: 'wrap'`: `geometry/decal.ts` maps the decal rectangle through the chart instead of projecting: the patch
  spans `width / r` radians on a cylinder (VC-WRP-23); outline-font decals rasterise the text outline (`lib/font`) instead of the
  5×7 block font; still paint.
- `add_knurl`: teeth N = round(π d / p), pitch used = π d / N, warning when it differs from the request
  (`knurl_cases.json`); rendered as a procedural normal map on the face; drawing note text from the pattern and pitch. No standard
  table is shipped (D-WRP-8).

### 5.8 GeometryKernel / FaceQueryPort additions (`packages/core/src/geometry/kernelPorts.ts`)

```ts
export interface WrapPort {
  // ctx.kernel.wrap (absent on Manifold)
  projectCurves(
    shape: ShapeHandle,
    request: {
      readonly faces: readonly number[];
      readonly curves: readonly NurbsCurveData[];
      readonly direction?: Vec3;
      readonly closest?: { readonly maxDistance: number };
      readonly tolerance: number;
    },
  ): readonly { readonly source: number; readonly face: number; readonly curve: NurbsCurveData; readonly pcurve: NurbsCurve2Data }[] | null;
  geodesic(shape: ShapeHandle, face: number, from: Vec2, direction: number, length: number, tolerance: number): NurbsCurve2Data | null;
  geodesicBetween(shape: ShapeHandle, face: number, from: Vec2, to: Vec2, tolerance: number): NurbsCurve2Data | null;
  curvesOnFace(shape: ShapeHandle, face: number, pcurves: readonly NurbsCurve2Data[]): readonly NurbsCurveData[] | null; // 3D curves of pcurves
}
// ShapeRecipe gains { op: 'emboss' } (§3); FaceOpParams gains { kind: 'splitByCurves'; faces: number[]; pcurves: NurbsCurve2Data[][] }.
```

Native side: `cpp/wrap.cxx` (projection, curves on face, geodesics), `surfaces.cxx` `face_slab` extended to curved loops and to many
regions, `face_ops.cxx` split by curves; Rust bindings in `src/features.rs` / `src/wrap.rs`; request plumbing in
`server/src/native/kernelFeatures.ts`. Every OCCT class used gets an integration test (`server/tests/`) — "bound ≠ works".

### 5.9 Numerical tolerances (named defaults, AF-31)

| Name                                          | Default                                                                    | Unit            | Source                                                                                |
| --------------------------------------------- | -------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------- |
| `fitTolerance` (pcurve fit, projection Tol3D) | 1e-6 × model bounding-box diagonal, ≥ 1e-7 mm                              | document length | llull (D-WRP-4); OCCT NormalProjection default 1e-4 is too coarse for lettering [R17] |
| `maxLengthStrain`                             | 0.02                                                                       | 1               | llull (D-WRP-4)                                                                       |
| `minFeatureSize`                              | none unless the owner names a process (then e.g. FDM 0.4 mm nozzle, given) | document length | AF-31: never invented                                                                 |
| Deboss start offset                           | 1e-6 × diagonal                                                            | document length | llull                                                                                 |
| Sewing tolerance of slabs                     | as `faceSlab` today                                                        | document length | `plySlab.ts` callers                                                                  |

## 6. Interop & persistence

| Item                | Format / rule                                                                                                                                                                                                                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Document            | `fonts` + `blobs` (font bytes, D-WRP-1); `TextEntity.font`; `NurbsCurveEntity.onFace`; recipe `emboss`; `KnurlPmi` in `pmi`                                                                                                                                                                   |
| STEP                | Embossed solids export through the existing exact path (cylinder / offset / ruled faces); knurl as an AP242 PMI note (04 XCH writer)                                                                                                                                                          |
| DXF                 | Font text and `unwrap_face` outlines export as SPLINE (degree 2, exact) or LWPOLYLINE (flattened, tolerance stated) through the existing DXF writer                                                                                                                                           |
| glTF                | Decals as today; knurl texture baked as a normal map                                                                                                                                                                                                                                          |
| Code export         | `export_code language=cadquery`: planar font text → `Workplane.text(...)` (CadQuery has a text primitive; font file passed by path); wraps / embosses on curved faces have no CadQuery equivalent → lowered as an exact B-rep blob import or refused with `WRP_CODEGEN_UNSUPPORTED` (D-WRP-7) |
| Font files in plans | `import_font path=…` reads through the host exchange path (CLI / desktop), like `import_airfoil`                                                                                                                                                                                              |

## 7. CLI / UI surfaces and error codes

- CLI: nothing special — registry → `llull search wrap emboss text font`, `llull describe <cmd>`, plans; `llull guide` gains a WRP
  section (chart axes per face kind, anchor + angle, the minimal emboss plan, how to read `distortion`) (AF-03).
- UI: render branch for `nurbs_curve` with `onFace` (draw on the face, depth-offset), emboss is a normal solid; distortion overlay
  (COULD) from `check_wrap` data; anchor drag = 04 DIR gesture committing one step.

### 7.1 Stable error and finding codes (AF-11)

| Code                                                                                                                           | Raised by                                                    | When                                                                                                       | Ids / path                         | Remediation                                                               |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------- |
| `WRP_ENTITY_NOT_FOUND`                                                                                                         | all                                                          | unknown id                                                                                                 | `params.id`                        | `llull describe_scene` lists ids                                          |
| `WRP_FACE_NOT_FOUND` / `REF_LOST`                                                                                              | face commands                                                | face pick resolves to nothing / recorded name gone                                                         | `params.face`                      | re-pick with `faceNear` on the intended face (`inspect_faces`)            |
| `WRP_FACE_NOT_DEVELOPABLE`                                                                                                     | `wrap_to_face`, `emboss_on_face`, `unwrap_face`, `add_decal` | method `develop` on a face with K ≠ 0                                                                      | `params.placement.method`          | use `method: "geodesic"` or `"parametric"` and read `data.distortion`     |
| `WRP_ANCHOR_OFF_FACE`                                                                                                          | wrap / curve-on-face                                         | anchor point farther than 1e-3 × size from the face                                                        | `params.placement.anchor.on`       | give a point on the face (`inspect_faces` samples)                        |
| `WRP_OUTSIDE_FACE`                                                                                                             | wrap / emboss / pattern                                      | a mapped loop leaves the trimmed face                                                                      | `params.profileIds[i]`, loop index | move the anchor, rotate, or scale the sketch                              |
| `WRP_WRAP_OVERLAP`                                                                                                             | wrap / emboss                                                | chart extent > circumference (cylinder) or > sector (cone)                                                 | `params.profileIds[i]`             | shrink the sketch below `data.fullWrapChartWidth`                         |
| `WRP_PROFILE_OPEN`                                                                                                             | `emboss_on_face` (emboss / deboss)                           | a profile is not closed                                                                                    | `params.profileIds[i]`             | close it, or use `mode: "scribe"` for open curves                         |
| `WRP_PROFILE_SELF_INTERSECT`                                                                                                   | `emboss_on_face`                                             | a loop crosses itself (after the font union)                                                               | profile id, loop index             | fix the sketch; text loops are united automatically                       |
| `WRP_DEPTH_INVALID`                                                                                                            | `emboss_on_face`                                             | depth ≤ 0 or not finite (non-scribe)                                                                       | `params.depth`                     | give depth > 0 in document units                                          |
| `WRP_DEPTH_EXCEEDS_SOLID`                                                                                                      | `emboss_on_face` (deboss / engrave)                          | depth ≥ face radius or ≥ local wall thickness                                                              | `params.depth`, region             | reduce depth below `data.maxDepth`                                        |
| `WRP_DISTORTION_EXCEEDED`                                                                                                      | `emboss_on_face`, `wrap_to_face`                             | max length strain > limit                                                                                  | `params.maxLengthStrain`           | smaller sketch, other anchor, or raise the limit with the owner's consent |
| `WRP_PROJECTION_MISSES_FACE`                                                                                                   | `project_to_face`                                            | nothing (or less than all, with `requireAll`) lands on the faces                                           | `params.entityIds[i]`              | change `direction` or move the sketch plane                               |
| `WRP_SPLIT_CURVE_NOT_ON_FACE` / `WRP_SPLIT_NO_EFFECT`                                                                          | `split_face_by_curves`                                       | curve has no `onFace` on this solid / splits nothing                                                       | `params.curveIds[i]`               | make curves with `project_to_face` / `wrap_to_face` on this solid         |
| `WRP_GEODESIC_FAILED`                                                                                                          | `create_curve_on_face`                                       | shooting did not converge                                                                                  | `params.from`, `params.to`         | pick closer points or `mode: "uv"`                                        |
| `WRP_FONT_UNAVAILABLE`                                                                                                         | `add_text`, `add_decal`                                      | font id / family not in the document nor the provider                                                      | `params.font`                      | `list_fonts`, then `import_font`                                          |
| `WRP_FONT_PARSE`                                                                                                               | `import_font`                                                | not an sfnt font, truncated or out-of-range table                                                          | `params.path`                      | give a .ttf / .otf file                                                   |
| `WRP_FONT_FORMAT_UNSUPPORTED`                                                                                                  | `import_font`                                                | WOFF / WOFF2, collections                                                                                  | `params.path`                      | use a TrueType-outline (.ttf) font                                        |
| `WRP_FONT_VARIATION`                                                                                                           | `import_font`, `add_text`, `add_decal`                       | unknown axis, value outside its range, font without axes or not CFF2 variable                              | `params.variation`                 | name only axes of `data.axes`, inside their range                         |
| `WRP_FONT_EMBEDDING_RESTRICTED`                                                                                                | `import_font`                                                | OS/2 fsType = 2 or bitmap-only                                                                             | `params.path`                      | use a font licensed for embedding (bundled fonts are OFL)                 |
| `WRP_FONT_TOO_LARGE`                                                                                                           | `import_font`                                                | > 4 MB                                                                                                     | `params.path`                      | subset the font or use a bundled one                                      |
| `WRP_GLYPH_MISSING` (warning)                                                                                                  | `add_text`, `text_outline`, `add_decal`                      | characters with no glyph                                                                                   | characters                         | choose a font that covers them                                            |
| `WRP_TEXT_NO_FONT`                                                                                                             | `text_outline`, `emboss_on_face`, `extrude_profile`          | text entity without `font`                                                                                 | `params.id`                        | set `font` (`edit_step_params` on `add_text`)                             |
| `WRP_KNURL_FACE_NOT_CYLINDER`                                                                                                  | `add_knurl`                                                  | face not cylindrical                                                                                       | `params.face`                      | pick the cylindrical face                                                 |
| `WRP_KNURL_PITCH_ADJUSTED` (warning)                                                                                           | `add_knurl`                                                  | π d / p not an integer                                                                                     | `params.pitch`                     | none; the pitch used is in `data.pitch`                                   |
| `WRP_KERNEL_BUILD_FAILED`                                                                                                      | kernel commands                                              | OCCT result invalid / failed                                                                               | region index                       | simplify the profile, increase depth / tolerance, report                  |
| `WRP_CODEGEN_UNSUPPORTED`                                                                                                      | `export_code`                                                | wrap on a curved face in a language without it                                                             | step id                            | export STEP instead                                                       |
| `WRP_CHECK_DISTORTION` · `WRP_CHECK_OUTSIDE_FACE` · `WRP_CHECK_THIN_FEATURE` · `WRP_CHECK_DEPTH` · `WRP_CHECK_VOLUME_MISMATCH` | `check_wrap` (fail)                                          | limit exceeded / region leaves face / stroke width < `minFeatureSize` / depth guard / kernel ≠ closed form | ids, value, limit, unit            | as the matching refusal                                                   |
| `WRP_CHECK_GLYPH_MISSING` · `WRP_CHECK_FONT_UNVERIFIED` · `WRP_CHECK_LIMIT_DEFAULTED`                                          | `check_wrap` (warn; unverified not suppressible)             | as named                                                                                                   | font / text ids                    | pin the font source or confirm with the owner                             |

### 7.2 Result conventions (AF-10, AF-31..35)

- Every number has a unit field or suffix (`length3d` + `unit`, `regionArea` + `areaUnit`, `angleDeg`, `angularSpanRad`). Chart
  quantities are in document units.
- `unverified` on every result that depends on an unverified font; `provenance { method, font? {family, sha256}, inputs }`.
- Named defaults as `NamedTolerance` (`{ value, unit, source, defaulted }`), same type as SRF.
- `reviewRequired` only on `add_knurl` (PMI on parts) and on `check_wrap` when `purpose: "release"` is passed (marking on a released
  part); approval is the existing 09 PLM human gate (AF-34).
- Bounded output: `unwrap_face` outlines ≤ 2 000 points per loop unless `--save`; `text_outline output: "glyphs"` paged by `limit`.

### 7.3 Agent-first compliance

| AF            | Where                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------- |
| AF-01, 02, 03 | registry commands, agent-written descriptions (§4), `llull guide` WRP section                           |
| AF-04         | FR-WRP-47; `depth`, `pitch`, `letterSpacing` in document units; `angleDeg`, `draftDeg`, `helixAngleDeg` |
| AF-05         | FR-WRP-46; `validation/plans/*.json`                                                                    |
| AF-10, 12     | §7.2                                                                                                    |
| AF-11         | §7.1                                                                                                    |
| AF-13         | FR-WRP-45; pure chart + font code, step-scoped ids                                                      |
| AF-20, 30     | `check_wrap`                                                                                            |
| AF-21         | lengths, strain, area ratio, volume delta instead of looking at the render                              |
| AF-22         | `render_view isolate=<id> --save`                                                                       |
| AF-31         | §5.9 named defaults                                                                                     |
| AF-32         | font provenance → `unverified` propagation                                                              |
| AF-33, 34     | knurl / release marking `reviewRequired`; 09 PLM approval                                               |
| AF-35, 36     | `provenance`; one-sentence summaries                                                                    |
| AF-40, 41, 42 | budgets §8, bundled fonts, no network; `--dry-run`                                                      |

## 8. Performance & robustness budgets (desktop, native kernel)

| Operation                                          | Budget                                                                                          | Notes                                     |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `import_font` 500 KB TrueType                      | ≤ 150 ms                                                                                        | full parse + validation, once             |
| `text_outline` 100 characters                      | ≤ 30 ms                                                                                         | cached per (font sha256, content, layout) |
| `wrap_to_face` 50 curves on a cylinder             | ≤ 300 ms                                                                                        | exact pcurves                             |
| `emboss_on_face` 20-character text on a cylinder   | ≤ 1.5 s                                                                                         | one fuse with a tool list                 |
| `emboss_on_face` 100-character text on a cylinder  | ≤ 3 s                                                                                           | VC-WRP-34                                 |
| geodesic wrap of a 30-loop logo on a B-spline face | ≤ 5 s                                                                                           | geodesic shooting native                  |
| Robustness                                         | no crash on malformed fonts (fuzzed parser: truncated tables, loops in composites, huge counts) | every parse error → `WRP_FONT_PARSE`      |

## 9. Test strategy

| Level              | Location                                                                                                 | Content                                                                                                                                                                                                  | VC                                 |
| ------------------ | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Unit (core math)   | `tests/unit/wrap/surfaceChart.test.ts`                                                                   | chart maps vs `data/cylinder_wrap.json`, `cone_development.json`, `sphere_geodesic_wrap.json`, `pull_and_geodesic.json`                                                                                  | 01, 02, 06, 07, 08, 37             |
| Unit (fonts)       | `tests/unit/wrap/font*.test.ts`                                                                          | the pinned Fira Sans fixture (downloaded by a fixture script, sha256-checked; skipped offline with a notice) vs `data/font_firasans_glyphs.json` and `text_cases.json`; a fuzz corpus of truncated fonts | 13, 15, 19, 20, 21                 |
| Unit (commands)    | `tests/unit/wrap/*.test.ts`                                                                              | happy + failure per command, `is pure`, error codes of §7.1, schema snapshot                                                                                                                             | 03, 09, 30, 31                     |
| Agent-first        | `tests/unit/wrap/agentFirst.test.ts`                                                                     | named defaults, `unverified` propagation, provenance, units audit                                                                                                                                        | 28, 29, 31                         |
| Golden             | `tests/golden/` plans from `validation/plans/target_*.json`                                              | id-normalised snapshots + replay equality                                                                                                                                                                | 10, 14, 16, 18                     |
| Kernel integration | `server/tests/nativeWrap.test.ts`                                                                        | every OCCT class used (§1.2, §5.3, §5.5); volumes vs `emboss_volumes.json`                                                                                                                               | 04, 05, 10, 12, 14, 16, 17, 25, 32 |
| Manifold path      | `tests/unit/wrap/noKernel.test.ts`                                                                       | refusals + core-only commands                                                                                                                                                                            | 33                                 |
| Production gate    | scenario "branded bottle": revolve a bottle, wrap + emboss text, deboss a serial, check, STEP round trip | 32                                                                                                                                                                                                       |

### 9.1 Technical requirements

| Id        | Requirement                                                                                                                                                            | Spec             | VCs                    |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ---------------------- |
| TR-WRP-01 | Core `geometry/surfaceChart.ts` (+ geodesic chart): develop / geodesic / parametric maps, promoted from `domain-aero/src/composites/surface.ts`; composites re-uses it | §2.1, §5.1, §5.2 | 01, 02, 06, 07, 08, 37 |
| TR-WRP-02 | Face references by persistent name; seam splitting and wrap-around on periodic faces; overlap / outside-face detection                                                 | §5.1             | 03, 04                 |
| TR-WRP-03 | `NurbsCurveEntity.onFace` (`CurveOnFace` with exact or fitted pcurve) and its render branch                                                                            | §3               | 01, 07, 37             |
| TR-WRP-04 | Recipe node `emboss` (normal walls, regions, modes), lowering and `recipeKey`; scribe via split                                                                        | §3, §5.3         | 04, 10, 12, 14, 16     |
| TR-WRP-05 | Native `face_slab` with B-spline pcurve loops and several regions; pull walls with `BRepFeat_MakePrism` / `MakeDPrism`                                                 | §5.3             | 10, 12, 25             |
| TR-WRP-06 | Native projection (`BRepProj_Projection`, `BRepOffsetAPI_NormalProjection`) and split by curves (`BRepFeat_SplitShape`) behind `WrapPort`                              | §5.5, §5.8       | 05, 17                 |
| TR-WRP-07 | `lib/font`: bounded TrueType parser, composites, nonzero union, exact areas; CFF in V1; fuzz tests                                                                     | §5.4             | 13, 15, 33             |
| TR-WRP-08 | Fonts in the document (`fonts`, binary blobs D-WRP-1), `FontProvider` port with bundled OFL fonts, fsType enforcement                                                  | §2.1, §3         | 19, 20                 |
| TR-WRP-09 | `TextEntity` v2 + `geometry/textOutline.ts`; `extrude_profile` and `emboss_on_face` accept font text                                                                   | §3, §4           | 13, 14, 35             |
| TR-WRP-10 | Commands of §4 with `WRP_*` codes and `check_wrap`                                                                                                                     | §4, §7.1         | 03, 28, 30             |
| TR-WRP-11 | Distortion metrics and the named limit                                                                                                                                 | §5.2, §5.9       | 02, 08, 28             |
| TR-WRP-12 | Decal `mapping: 'wrap'` and outline-font raster                                                                                                                        | §5.7             | 23                     |
| TR-WRP-13 | `KnurlPmi`, closure rule, texture; modeled knurl via 02 SWG                                                                                                            | §3, §5.7         | 24                     |
| TR-WRP-14 | Interop: STEP exact, DXF outlines, CadQuery text lowering, codegen refusal                                                                                             | §6               | 32                     |
| TR-WRP-15 | Purity, determinism, budgets                                                                                                                                           | §2.3, §8         | 18, 34                 |
| TR-WRP-16 | Units, `unverified`, provenance, bounded output                                                                                                                        | §7.2             | 29, 31                 |

## 10. Delivery plan

| Milestone | Content                                                                                                                                                                                                                           | Depends on  | Effort (eng-weeks) |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------ |
| M0        | Decisions D-WRP-1..4; promote the chart to core (`surfaceChart.ts`), composites switched to it (no behaviour change, its tests green)                                                                                             | —           | 1                  |
| M1        | `lib/font` TrueType + `import_font`, `list_fonts`, `FontProvider` with bundled Fira Sans, `TextEntity.font`, `text_outline`, `extrude_profile` of font text (planar 3D text works on Manifold too)                                | M0, D-WRP-1 | 3                  |
| M2        | `unwrap_face`, `wrap_to_face` (develop), `NurbsCurveEntity.onFace` + render branch, `project_to_face` (native projection)                                                                                                         | M0          | 3                  |
| M3        | `emboss_on_face` emboss / deboss / scribe on plane / cylinder / cone: recipe `emboss`, native `face_slab` with curved loops + regions, `check_wrap`                                                                               | M1, M2      | 4                  |
| M4 (V1)   | Geodesic + parametric charts (native geodesics), emboss on doubly curved faces, `split_face_by_curves`, `create_curve_on_face`, pull walls + draft, CFF fonts, kerning, multi-line, `add_decal` font + wrap, `add_knurl` cosmetic | M3          | 6                  |
| M5 (V2)   | Single-line fonts + engrave, multi-face wraps, text on curve, `pattern_on_face`, modeled knurl (02 SWG helical sweep), silhouette split, variable-font instances                                                                  | M4, 02 SWG  | 5                  |

Total ≈ 22 eng-weeks. Cross-pack: **01 DEF** owns body deformation (no overlap: WRP never moves the solid's existing faces),
**02 SWG** helical sweep for a modeled knurl and on-face guide curves (FR-WRP-04 is an input to it), **04 DIR** anchor-drag gesture,
**06 BLD** fillets on emboss edges (the emboss edges get persistent names so 06 can pick them), **07 MSH** mesh emboss / displacement.

## 11. Open questions / decisions needed

| #       | Question                                                                                                                                                                                                                                           | Proposal                                                                                                                                                                                                      |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-WRP-1 | Binary payloads in `CadDocument.blobs` (today UTF-8 text, `model/*` media types)                                                                                                                                                                   | Add `font/ttf`, `font/otf` with sha256 of raw bytes; bump persistence only if old readers would misread                                                                                                       |
| D-WRP-2 | Font engine: TypeScript in core vs native `skrifa` (fontations, MIT / Apache, fuzzed, replaces FreeType in Chrome [R22]) vs OCCT `Font_BRepFont` (needs FreeType, rebuild) vs `ttf-parser` (maintenance mode [R21]) vs opentype.js (MIT, JS [R23]) | **TS in core** for MVP (pure, deterministic, testable in node, no host dependency); keep skrifa as the V1 option for CFF2 / variable fonts if the TS CFF reader proves costly; do not enable FreeType in OCCT |
| D-WRP-3 | Bundled fonts and their size in the desktop / CLI bundle                                                                                                                                                                                           | Fira Sans Regular (457 KB, OFL) + one single-line OFL font in V2; more families as user imports                                                                                                               |
| D-WRP-4 | Default distortion limit and fit tolerance                                                                                                                                                                                                         | 2 % length strain, 1e-6 × diagonal; always reported `defaulted: true`                                                                                                                                         |
| D-WRP-5 | Command catalog placement: new `commands/wrap/` core catalog vs extending `edit` / `brep`                                                                                                                                                          | New `wrap` catalog (one concern, ≤ 500 lines per file)                                                                                                                                                        |
| D-WRP-6 | Shaping (ligatures, complex scripts)                                                                                                                                                                                                               | Out of scope; one character → one glyph + pair kerning; revisit with a shaping library if owners need it                                                                                                      |
| D-WRP-7 | Code export of curved-face embosses                                                                                                                                                                                                                | Exact B-rep blob import in the generated script, or refuse — owner choice                                                                                                                                     |
| D-WRP-8 | Knurl standard tables (DIN 82 / ISO 13444, paywalled)                                                                                                                                                                                              | Ship none; user gives pitch / angle; transcribe a table only from a readable source with two-source agreement                                                                                                 |
| D-WRP-9 | Should `add_text` without `font` become a profile by default (bundled font)?                                                                                                                                                                       | No: keep annotations as they are (backward compatible); `font` opts in                                                                                                                                        |

## 12. References

Same numbering as FUNCTIONAL_SPEC §11 ([R1]–[R27]). llull internal: `.claude/rules/architecture.md`, `docs/aerospace/AGENT_FIRST.md`,
`docs/decisions/LC1-local-only.md`, `docs/decisions/SV1-solver-toolchain-windows.md` (cited by `surfaces.cxx` for the
`MakeThickSolid` crash that made `face_slab` build walls itself).

## 13. As built (M0–M3, DES-3)

Owner decisions applied: binary blobs (`font/ttf`, `font/otf`, sha256 of the raw bytes, no persistence bump); font engine in TypeScript (`packages/core/src/lib/font`);
Fira Sans Regular bundled in `server/fonts/` (SIL OFL next to it, sha256 `c29556a2719bf613ef3d5e070e40d903a8965d9c081beca1375dc1e6e0f93c23`, source
google/fonts@45e3d5269e4a17d823f6d84470bc084dc5ae46f6), read host-side through the `ctx.fonts` port (`LLULL_FONTS_DIR` overrides); 2 % default length-strain limit.

- M0: `geometry/surfaceChart.ts` (plane, cylinder, cone) promoted from composites, which now delegates to it.
- M1: `import_font`, `list_fonts`, `text_outline`, `TextEntity.font` (+ `add_text` layout fields), `extrude_profile` of font text (prism/hole-tool boolean recipe, any kernel).
  Deviation: the layout field is `advanceWidth` (document units), not `advanceWidthMm`. Glyph/point/recursion caps and bounds-checked reads give stable codes (`WRP_FONT_PARSE`).
- M2: `unwrap_face`, `wrap_to_face`, `project_to_face` (`requireAll` added), `NurbsCurveEntity.onFace`. Projection is the sidecar's own sampling with
  `IntCurvesFace_Intersector` (direction) / `BRepExtrema_DistShapeShape` (closest), bisected run boundaries and `GeomAPI_PointsToBSpline` fits, not `BRepProj_Projection`.
  Cone charts are flat polar developments; cylinder/cone 3D curves are cubic interpolants (`fitBySampling`) with the measured deviation reported.
- M3: `emboss_on_face` (emboss, deboss, scribe) on plane, cylinder, cone via recipe node `emboss` (capability `emboss`). Per-region face slabs are fused/cut through the
  existing boolean with coincident faces (no overshoot: it lost accuracy); scribe is `BRepAlgoAPI_Splitter` + `ShapeUpgrade_UnifySameDomain`. Lift sign: slab direction is
  the surface normal at the first loop vertex times the face orientation. `check_wrap` re-measures lengths and volumes. Pcurves are stored with `frame: 'native'`.
- M4 methods answered `WRP_METHOD_UNAVAILABLE` here; §14 builds them.
- Plan fix: `target_cone_wrap_scribe.json` called `inspect_faces` with `id`; the parameter is `entityId`.

Measured (native kernel): cylinder rect emboss +307.5 / deboss -292.5 mm3 (VC-10); text emboss area 104.8862, 5 loops, outline 171.2589, delta 107.5084 (VC-13/14);
cone sector 2.809926 rad, wrapped lengths 20 and 25.13274 (VC-06/07), scribe +1 face; projected 33.92248 vs expected 33.92248 (rel 9e-8); bad inputs give the expected codes (VC-30).

### 13.1 Review fixes

- `cmap` glyph ids are clamped to `numGlyphs` (0 beyond); `textOutline` converts any `FontError` into `WRP_FONT_PARSE` (`outlineErrorCode`), so a hostile font is a coded no-op in `text_outline`, `extrude_profile`, `emboss_on_face`, `wrap_to_face`.
- All-off-curve contours start at mid(last, first); mirrored composite components (det < 0) reverse their contours; `scanGlyphs` has a whole-font budget of 5e6 points.
- Overlap uniting is per crossing cluster (union-find over box-prefiltered crossings); clean glyphs keep exact curves.
- Replay seeds the embedded font records and bytes from the base document, so a replay needs no font provider. `import_font` records `blob` (the sha256) instead of `base64`: the bytes are stored once, in `blobs`.
- Deboss depth limit: the profile's smallest distance to the axis (cylinder radius; cone: smallest v x sin(semi-angle)); none for a bore or a plane. Cone `angularSpanRad` is the azimuth span; `developedSectorRad` is the flat sector angle.

## 14. As built (M4, M5, DES-3b)

Delivered on top of §13; the sections below say what exists, what was decided, what was measured and what is left.

### 14.1 What exists

- Charts (`geometry/chartFrame.ts`, `wrapChart.ts`, `curvedChart.ts`, `faceChart.ts`, `chartInverse.ts`, `chartDistortion.ts`): `develop` (plane, cylinder, cone), `geodesic` (exponential map: analytic on the sphere, RK4 on the geodesic equations of the torus, the development on developable faces) and `parametric` (arc-length scaled (u, v), affine). Every chart carries `method`, `nullMeaning`, `areaG`, and the distortion report (`data.distortion`: signed `maxLengthStrain`, `maxAbsLengthStrain`, area ratio; default limit 0.02, named).
- Native (`llull-kernel-occt`): `surface_loops.cxx` (split from `surfaces.cxx`), sphere (kind 4) and torus (kind 5) surfaces, emboss mode `split` (tools from pcurve chains, `BRepAlgoAPI_Splitter`), surface type `face` (the face's own (u, v), split only), one lift sign for all regions of a node (an instance beyond a quarter turn was lifted inward before).
- Commands: `create_curve_on_face` (geodesic, isoparametric, uv), `split_face_by_curves`, `pattern_on_face` (grid), `add_knurl` (cosmetic `KnurlPmi`, or `model: 'geometry'` for straight V-grooves), `emboss_on_face` modes `emboss | deboss | scribe | engrave` (`toolWidth`), `add_text.onCurve` (text on a curve), `add_decal` (`font`, `mapping: 'wrap'`).
- Fonts (TypeScript, `lib/font`): CFF/Type 2 and CFF2 (`cff.ts`, `type2.ts`, `variation.ts`: see §14.5), GPOS PairPos kerning formats 1 and 2 (`gpos.ts`, before the legacy `kern`), a JSON open-stroke single-line format (`stroke.ts`, blob `font/x-llull-stroke`), multi-line layout. Bundled single-line font `llull-single-line` (`server/fonts/LlullSingleLine.json`, 49 glyphs, generated by `validation/generate_single_line_font.mjs`, CC0-1.0, sha256 `c891a617…d921e`).
- `check_wrap` knows sphere and torus (closed-form volumes, signed strain). Codegen emits a `WRP_CODEGEN_UNSUPPORTED` note for emboss meshes (no faithful CadQuery form).

### 14.2 Decisions and deviations (never silent)

- Plan fix: `target_sphere_geodesic_wrap.json` used the 2 % default limit but the disk a 10 stretches by 2.65 %; the plan now passes `maxLengthStrain` 0.05 (0.2 for the wide disk, which `check_wrap` then fails against 0.05). VC-WRP-28 is unchanged (-0.1033 fail / -0.0265 pass).
- VC-WRP-08 / 28: `maxLengthStrain` is signed as in the pack (-0.0264541); `maxAbsLengthStrain` sits next to it, limits compare the absolute value.
- Volume guard of `check_wrap` for fitted footprints (cone, sphere, torus): the native mass integration of faces trimmed by fitted spline edges differs from the closed form by about tolerance x perimeter x depth. Measured on R 25, disk a 10 / a 4, depth 0.5 / 2: kernel / closed - 1 = -8.1e-6 / -9.6e-6 at the default fit tolerance (about 5e-5), 6e-9 at 1e-8, 1.3e-9 at 1e-9; closed / ideal - 1 = -2.4e-7 (the closed form is right). The guard stays 1e-6 for plane and cylinder (exact pcurves) and becomes `1e-6 + 2 x tolerance x perimeter / area` for the fitted surfaces (`geometry/embossPerimeter.ts`); the recipe tolerance of `emboss_on_face` is now at least the fit tolerance. This loosens the guard for those three surface types only; the loosening is reported in the finding `limit`.
- `split_face_by_curves` volume resolution is the named `VOLUME_RESOLUTION` 1e-5 (measured 8e-7 on a cylinder with a circle patch; the kernel's fixed-rule integration of spline-trimmed faces is the limit), plus 3 x the kernel's own relative error.
- Knurl as an AP242 PMI form: none exists, so the cosmetic knurl is skipped in the STEP PMI export and listed in the export report; the geometry knurl exports as ordinary faces.
- Modeled knurl is straight V-grooves only; diagonal and diamond refuse with `WRP_KNURL_GEOMETRY_UNSUPPORTED`.
- A decal and `add_knurl` are kernel-optional (decal wrap on the cylinder and cone needs no kernel; the geometry knurl needs the exact kernel).

### 14.2b Review fixes (DES-3b)

- Load guard of a decal checks `mapping`, `wrap` and `mask` (mask sides <= 1024, payload length = ceil(w h / 8) bytes), so a hostile file cannot make `decalImage` allocate an arbitrary image. CFF operators check their operand count (`WRP_FONT_PARSE`).
- `add_knurl`: at most 2000 teeth, a non-finite count refused, `helixAngleDeg` refused with the straight pattern (and rejected on load; the load guard also checks pitch = pi d / teeth). The groove tool runs past a face end only where a free end cap stands (a one-loop plane neighbour); at a shoulder or chamfer it ends flush, and the measured volume change must match the closed form within 1e-4 (else refused). Measured on the golden bottle: the neck knurl removes 372.5416 mm3 (was 382.2778 mm3 when the tool notched the cone shoulder).
- `check_wrap`: the fitted-footprint allowance is capped at 1e-3 and reported as `limits.volumeAllowance`; `minFeatureSize` on a cone, sphere or torus emboss reports `WRP_CHECK_STROKE_SKIPPED` and `checked.strokeChecksSkipped`.
- `split_face_by_curves`: volume check relative with a floor of 1e-12, summed face area must match within 1e-5, open curves name their face from interior samples only and anchor on the middle of the curve.
- Rust: `recipe/wrap_nodes.rs` and `features_surface.rs` hold the emboss/split nodes and the surface FFI; test modules moved to `features_tests.rs` and `recipe/nodes_tests.rs`; every file is under 500 code lines.
- Plans are self-contained: the text plan uses the bundled `Fira Sans`; the bad-input plan passes non-font bytes inline.

### 14.3 Measured (native kernel unless noted)

| VC        | Measured                                                                                                                       | Tolerance |
| --------- | ------------------------------------------------------------------------------------------------------------------------------ | --------- |
| VC-WRP-08 | length 61.1696902, signed strain -0.0264541, area ratio 0.9867376                                                              | 1e-6      |
| VC-WRP-28 | -0.1033 (a 20) / -0.0265 (a 10)                                                                                                | 1e-4      |
| VC-WRP-37 | geodesics on r 20: 22.3606798 / 10 / 40.3112887                                                                                | 1e-6 rel  |
| VC-WRP-17 | +1 face, area sum equal, volume within 1e-5 (8e-7 measured)                                                                    | 1e-6 area |
| VC-WRP-24 | 63 teeth, pitch 0.99733100114                                                                                                  | 1e-9      |
| VC-WRP-38 | 36 instances, volume = 36 x the single emboss                                                                                  | 1e-6      |
| VC-WRP-39 | 63 grooves, volume removed = closed form                                                                                       | 1e-6      |
| VC-WRP-40 | "LLULL CAD 2026" at cap 5 mm: 51.1030479 without kerning, 50.8345428 with (independent GPOS reader, 2086 ASCII pairs), grade B | 1e-6 rel  |
| VC-WRP-23 | wrap decal extent 1.5 rad                                                                                                      | 1e-3      |

Golden plan `plans/golden_wrp_native.json` (bottle: revolved polygon, Fira label, single-line serial engraved, dimple pattern, ring split, knurled neck, `check_wrap`): 13/13 steps; snapshot `server/tests/__snapshots__/wrpGolden.json` plus replay equality in `server/tests/wrpGolden.test.ts`. The cylinder face of a revolution has its axis toward -z, so the plan's placements turn the sketch by 180 degrees.

### 14.4 Left

Freeform (B-spline) faces: `create_curve_on_face` supports only iso/uv there, walls are along the outward normal only, scribe is refused (see 14.10); helical knurls above 8 grooves (kernel time) or on a face with a shoulder at an end; knurl as AP242 PMI; `VORG` and the side-bearing variations of `VVAR` (read for their structure, not used), vertical text layout (§14.18); multi-face wraps across edges that are neither rulings nor geodesics, chains over freeform faces, and mitred walls across curved or non-plane sharp edges (plane to plane is §14.15); the silhouette of a torus seen in its equatorial plane and of freeform faces with a cusp, a branch point or a tangential view (§14.16); footprint / chart previews of an emboss and a knurl pattern preview (the curves on faces and the face joins are drawn: §14.17). Per-file branch coverage below 85 % on a few new files (see the report of DES-3b).

### DES-3c (2026-10-30)

- **VC-WRP-32 passes** (native kernel, `server/tests/wrapStepRoundTrip.test.ts`): the embossed and debossed cylinders of `target_cylinder_rect_emboss_deboss`
  written with `export_step_ap242` and read back with `import_step_exact` keep their exact face count and their exact volume within 1e-6 relative.
- **`llull guide` section 15** (wrap, project, emboss, decal, knurl, the loop and the refusal codes; AF-03), tested in `tests/unit/conventions.test.ts`.

### 14.5 CFF `seac`, arithmetic operators and CFF2 variable fonts (DES-3c fonts, 2026-10-30)

Files (`packages/core/src/lib/font/`): `cffIndex.ts` (INDEX / DICT, CFF 1 and CFF2 widths), `type2.ts` (the charstring machine), `cffEncoding.ts` (Standard Encoding, charset), `cff.ts` (CFF 1 / CFF2 glue, FDSelect 0 / 3 / 4,
`seac` composition), `variation.ts` (`fvar`, `avar`, ItemVariationStore, `HVAR`); `font.ts` threads an instance through `parseFont(bytes, variation)`.

**Type 2 operators added.** Arithmetic and storage (12 3 `and`, 4 `or`, 5 `not`, 9 `abs`, 10 `add`, 11 `sub`, 12 `div`, 14 `neg`, 15 `eq`, 18 `drop`, 20 `put`, 21 `get`, 22 `ifelse`, 23 `random`, 24 `mul`, 26 `sqrt`, 27 `dup`, 28 `exch`, 29 `index`, 30 `roll`; 12 0
`dotsection` is ignored). They leave the rest of the stack in place, as the specification says. `seac` is the deprecated four-operand `endchar` (`adx ady bchar achar`, optional leading width):
the character codes go through the CFF Standard Encoding to a string id, the charset (formats 0, 1, 2 and the predefined ISOAdobe) to a glyph; the accent is drawn at (adx, ady) from the base origin
(Type 2 has no sidebearing correction, unlike Type 1). Hint operators were already skipped; the mask byte count is now checked against the end of the charstring and the stem count is bounded.

**Decisions (never silent).**

1. `random` returns a fixed sequence per glyph: a 32-bit LCG (seed 0x9e3779b9, x' = 1664525 x + 1013904223) mapped to (0, 1]. A glyph therefore always draws the same outline, whatever the evaluation order or cache state
   (replay, L3). The specification only asks for a pseudo-random number in (0, 1].
2. `seac` components are one glyph each and must not be accented themselves (no recursion); `seac` in a CID-keyed font and with a predefined Expert charset is refused (the encoding is the Standard Encoding of name-keyed fonts).
3. CFF2 refuses what CFF2 removed (`endchar`, arithmetic, `dotsection`); a CFF2 charstring has no width and closes its last contour implicitly.
4. CFF2 outlines and (since §14.14) TrueType `gvar` outlines can be instanced; `avar` version 2 and `MVAR` are read too. A font with neither refuses a non-default `variation` with `WRP_FONT_VARIATION`.
5. Normalised coordinates are rounded to 2.14 fixed point (as fontTools does), `avar` segment maps apply to the rounded value, region scalars follow the OpenType interpolation algorithm. Advances come from `HVAR`
   (rounded to a font unit); a CFF2 font without `HVAR` keeps its `hmtx` advances. Cap height follows `MVAR` (`cpht`) when the font has one (§14.14).
6. Real fonts: none is pinned in the repository (only Fira Sans, TrueType) and the machine is offline, so the references are generated fonts whose outlines follow from the charstring programs (`tests/unit/wrap/variableFonts.ts`).
   Pin a real CFF2 font (for example Source Serif Variable, OFL) in `validation/sources.md` before relying on this reader for production fonts.

**Bounds (named refusals, all `WRP_FONT_PARSE`).** Operand stack 96 (CFF) / 513 (CFF2), subroutine depth 10, 200 000 operators and 20 000 points per glyph, 96 / 256 stem hints, 32 storage cells, every operand finite and under 2^31
(`div` by zero, `sqrt` of a negative number, a non-integer cell / index / roll count refuse), an INDEX of at most 262 144 entries, at most 64 axes, 4096 regions and 4096 variation data subtables, region indexes inside the list,
`blend` with fewer operands than n x (regions + 1), `vsindex` outside the store, a store whose axis count differs from `fvar`.

**Font-wide bounds (review round).** Per-glyph caps alone do not bound a font, so: at most 256 font dicts, each read lazily, INDEXes parsed once per offset (dicts may share one Subrs INDEX); a variation data subtable lists at most as many regions as the
store has and all subtables together at most 65 536 region indexes; one operator budget of 20 000 000 for the whole scan of a font (import and every instance re-scan; `WRP_FONT_PARSE`); the FDSelect is read once into a per-glyph table (ranges strictly increasing,
starting at glyph 0, ending at or past the glyph count); a number prefix whose bytes run past its charstring and `return` in CFF2 are refused. `FontRecord.variation` is validated on load (plain record, 4-character tags, finite numbers, at most 64,
no reserved keys; path `fonts.<id>.variation.<tag>`). Instances are parsed and scanned once per (blob, variation) and cached. The adversarial fonts that prove this are built in `tests/unit/wrap/hostileFonts.ts` and run by the hostile-input harness and
`fontLimits.test.ts`. No OFL variable CFF2 font exists in the repository or `node_modules` (only WOFF2 web fonts), so a pinned real font stays a follow-up.

**Interface.** `import_font`, `add_text` and `add_decal` take `variation` = { axisTag: designValue } (absolute from the font defaults; omitted axes keep their default). `import_font` returns `data.axes` (tag, min, default, max) and
`data.variation`. One font blob backs one `FontRecord` per instance (`FontRecord.variation`, non-default axes in tag order); asking for an instance that exists returns the record, so emboss, wrap, extrude and decals read it through
`loadFont` unchanged. An unknown axis, a value outside its range, a font without axes or a font that is not CFF2 variable refuse with `WRP_FONT_VARIATION` (path `variation` / `font`).

**Tests.** `tests/unit/wrap/type2.test.ts` (one oracle per operator, seac, hint masks, bounds), `cff2.test.ts` (region scalars, `avar`, `vsindex`, subroutines, FDSelect 0 / 3 / 4, `HVAR`, every refusal),
`variableCommands.test.ts` (import, add_text, add_decal, text_outline, emboss_on_face, wrap_to_face, extrude_profile, save / load, replay), `fontFuzz.test.ts` (every byte of the generated fonts replaced by seven hostile values at the
default and at an instance: always a font or a stable code, no internal error text) and two entries of the hostile-input harness (`tests/helpers/hostile/coreReaders.ts`).

**Measured.** One instance of the 6-glyph generated font parses and scans in 0.03 ms (2000 instances, node, this machine).

**Left.** `VVAR`, named-instance lookup by name, a pinned real CFF / CFF2 font in the validation pack.

### 14.6 Multi-face wraps (DES-3c, VC-WRP-36)

`emboss_on_face` and `wrap_to_face` take `chain`: more faces (face refs) the sketch runs over. Files (`packages/core/src/commands/wrap/`): `chainCharts.ts` (unfolding), `clipRegions.ts` (exact half-plane clipping), `embossChain.ts`, `wrapChain.ts`.
No native code changed: the native `emboss` recipe is applied once per face, as steps of one recipe.

**Unfolding.** The root face has the user's chart (placement, angle, mirror). A face that shares an edge with a placed face is placed by that edge: the edge is sampled (17 points), mapped through the parent's chart and through the child's own develop
chart, both must be one straight line of the same length (else `WRP_CHAIN_EDGE_CURVED`: a circular cap edge does not develop to a line), and the child chart is anchored on the first edge point with the angle (and mirror) that makes its chart reproduce the parent's
coordinates of every sample (residual held to the fit tolerance, all four mirror / sign candidates tried, the one whose handedness agrees with the root's preferred). Each chart is then a develop chart, so every length and angle is kept inside a face and
across the edge: the strain is 0 by construction (`data.distortion`). The azimuth of a cylinder is taken in the turn that holds the face's own u range (a half-turn face makes a nearest-turn rule ambiguous; found and fixed with the stadium test).
Supported faces: plane and cylinder (affine charts), cone, sphere and torus since 14.13; freeform faces are `WRP_CHAIN_FACE_UNSUPPORTED`; a face with no edge to the chain is `WRP_CHAIN_NOT_ADJACENT`. At most 16 faces.

**Clipping.** The line each shared edge develops to cuts the sketch: lines are cut at the crossing, NURBS segments by knot insertion at the crossing parameter (roots found by sampling and bisection), a region cut by the line is closed by a chord along it, a hole cut by
it becomes part of the boundary (area 50 - 8 = 42 in the unit test), loops entirely on one side stay. The parts' areas add up to the sketch area (checked to 1e-9 relative; else `WRP_CHAIN_CLIP_FAILED`). A boundary tangent to an edge, or crossings that do not pair into chords, is
`WRP_CHAIN_CLIP_FAILED` too. `wrap_to_face` keeps the runs without chords: each becomes a curve on its own face (`data.faces`, `curves[].face`), a loop crossing an edge becomes open pieces.

**Emboss across the faces.** Each face's part is mapped by its chart, checked on the face and embossed in chain order: `recipe_k = emboss(source: recipe_{k-1}, face: the face found again by an interior probe point)`. Walls on a shared smooth edge are the same plane, so the pieces fuse.
**Deviation (never silent):** one command and one result, but the kernel steps are one per face, not a single multi-face tool; sharp (convex / concave) edges are refused for emboss and deboss except plane to plane (mitred since §14.15; otherwise `WRP_CHAIN_EDGE_SHARP`: slabs on both sides would meet in a line, not a surface; a mitre needs a
native half-space cut of the tools). `scribe` and `wrap_to_face` cross sharp edges. `data.expectedVolumeDelta` is the sum of the closed forms per face.

**Measured (native kernel, `server/tests/nativeWrapChain.test.ts`).** Stadium (box 40 x 20 x 10 + two r 10 cylinders), band 6 x 30, depth 1: areas 60 + 120, volume change 186 = 60 + 120 x 1.05 (1e-6 relative); three faces (band 60 long over plane, cylinder end, opposite plane) 369.4248;
deboss -174; wrap of a 40 long line 10 + 30; across the sharp 90-degree edge 5 + 3; replay equal. Golden VC-WRP-36 in `validation/expected_results.json`. New codes: `WRP_CHAIN_FACE_UNSUPPORTED`, `WRP_CHAIN_NOT_ADJACENT`, `WRP_CHAIN_EDGE_CURVED`, `WRP_CHAIN_EDGE_SHARP`, `WRP_CHAIN_CLIP_FAILED`.

### 14.7 Silhouette split (DES-3c)

`split_at_silhouette { id, direction, tolerance? }` (toolset 3d) divides the faces of a solid along its outline seen along `direction`: the parting line of a mould. Files: `commands/wrap/silhouette.ts` (the curves), `splitAtSilhouette.ts` (the command).

**Method.** The silhouette is where the face normal is perpendicular to the direction d, found in closed form on the exact faces the kernel reports (`faceGeometry`): a cylinder (axis a) gives the two generatrices at azimuth of +-(a x d); a cone (half angle alpha) the generatrices
where tan(alpha) (a . d) = |d_perp| cos(phi - psi) (none when the right side exceeds 1, e.g. seen along the axis); a sphere the great circle perpendicular to d (a rational quadratic NURBS, exact); a plane none (parallel to d: `edgeOn`, whose boundary is the parting line).
Each generatrix is built from two interior `evaluateFace` samples extended linearly (exact for a straight line; a cone's apex end cannot be evaluated), verified by the kernel (|n . d| <= 1e-6 at the middle, the middle inside the face, the faces on both sides of the line inside the face);
a line on the seam or on the face's u bounds, or on an edge, is an edge already and is reported in `data.silhouette.onEdge`. Each piece becomes a `nurbs_curve` with `onFace` (pcurve in the kernel's own (u, v)), and the faces are divided with `split_face_by_curves` (same volume and area checks, same
codes). `split_face_by_curves` learned one thing: the azimuth of a cone apex sample is taken from its neighbour (a generatrix ends at the apex).
**Deviation (never silent):** no HLRBRep / BRepAlgo call. OCC's outline algorithms are tolerance-driven polyline projections; the closed forms are exact, need no native rebuild and cover the faces that mould parting lines are made of. Torus (a quartic) and freeform faces are
`WRP_SILHOUETTE_UNSUPPORTED` with the face and reason, as is a sphere patch the great circle leaves; `WRP_SILHOUETTE_NONE` when no face has an interior silhouette (a box along an axis: `edgeOn` lists its 4 parallel faces). A sampled, fitted curve for torus / freeform faces stays open.

**Measured (native kernel, `server/tests/nativeSilhouette.test.ts`).** Cylinder r 20 h 40 along x: 2 lines of length 40 at y = +-20, 3 -> 4 faces, the two halves 800 pi each, volume unchanged (1e-5); sphere r 25 along z: the equator 2 pi r = 157.08, two hemispheres of area 2 pi r^2 (1e-4), along (1, 2, 2) an oblique great
circle (halves 1e-3); cone r 20 h 40 along x: 2 lines of the slant length 44.72, 2 -> 3 faces, halves pi r slant / 2; cylinder along y: the seam reported, one split; replay equal. Stub-port unit tests (`tests/unit/wrap/silhouette.test.ts`) cover the branches. Codes: `WRP_SILHOUETTE_NONE`, `WRP_SILHOUETTE_UNSUPPORTED`.

### 14.8 Pull walls and draft (DES-3c, VC-WRP-25 / 26)

`emboss_on_face` takes `walls: "normal" | "pull"`, `pullDirection` and `draftDeg` (files `embossPull.ts`, `embossRun.ts`). No native code changed: the relief is a recipe of exact booleans.

**Construction.** The regions are mapped as usual. For `walls: "pull"` each region's boundary is projected along the pull into the plane perpendicular to it and extruded as a prism over a window along the pull that holds the whole layer; holes are subtracted prisms.
Without a draft the outline of each loop is the exact image of the (u, v) pieces fitted by lines and cubic Beziers (Hermite ends from the exact tangent) split until the quarter points are within `fitTolerance` of it (`footprintOutline.ts`; the `extrusion` keeps the exact `curves`), so a circle is a handful of
Bezier faces, not a 480-sided polygon (a polygon prism made one native boolean 28 s long). With a draft the walls must be planar (the native draft reads planes, cylinders, cones), so the outline is a polygon whose chord sag against the image is within max(`fitTolerance`, 3e-5 x the diagonal) (at most 256 samples per piece).
`data.footprintDeviation` reports the largest deviation, `data.footprintSize` the segments or vertices, and `data.exact` is false when the deviation is above 0 (a rectangle on a plane stays exact). The layer is the exact offset of the face: `emboss = source + (prism x (offset(source, +d) - source))`,
`deboss = source - (prism x (source - offset(source, -d)))` where `offset` is the kernel's `moveFaces offset` (plane along its outward normal; cylinder, cone, sphere away from the axis / centre, sign by the face orientation). The walls are parallel to the pull and the relief follows the offset surface (VC-25: shell of r to r + d, not a prism of constant height).
The window is [lowest surface height over the parameter box of the region - margin, highest + d / cos(min)] along the feature axis (the side of the face opposite to the feature is never reached, so the far side of a cylinder is not embossed).

**Draft.** A draft tilts the walls of each footprint prism with the native `BRepOffsetAPI_DraftAngle` (`faceOp draft`, one node per prism, all planar walls parallel to the pull) about the HINGE: the plane through the placement anchor PERPENDICULAR TO THE PULL (it is the tangent plane of the face only when the pull is the face normal).
The relief narrows by tan(draft) per unit of height away from the hinge (an emboss toward its top, a deboss toward its floor); hole prisms widen, so wall thickness follows. Drafting the prism, not the finished relief, was the fix for a native refusal of drafted deboss walls on a cylinder (the hinge touched the cavity edge); the window is padded by the widening.
Consequences that are reported, not hidden: the footprint on the hinge plane is the nominal one, but the drafted prism is wider by reach x tan(draft) at the layer farthest from the hinge, so on a cylinder side or round a sphere pole the base of the relief grows past the sketch region (about 0.47 per side in VC-26);
`data.draftBaseGrowth` is that growth. An oblique pull (angle phi to the face normal) shifts the relief sideways by up to d tan(phi) against the sketch footprint (`data.obliqueShift`). On a plane perpendicular to the pull the closed form is
V = w l d - (w + l) t d^2 + 4/3 t^2 d^3 for a rectangle (t = d tan(draft)); on a curved face the volume is the measured one. The widened or sheared base is not re-checked against the trimmed face (a relief close to the face edge can leave it: the kernel's validity check is the guard).

**Refusals.** `WRP_PULL_PARALLEL`: the pull is within 0.57 degrees of the face at a sample (`|n . pull| < 0.01`), or crosses the face one way on part of the region and the other way on another (the face folds over the region); path `pullDirection`. `WRP_DRAFT_CLOSES`: the draft moves the walls on the two sides of the thinnest place of the region
(2 x reach x tan(draft), the reach being the height from the hinge to the far end of the prism) together; the THINNEST PLACE is the smallest distance between a boundary point and a boundary edge that is not local to it (`thinnestPlace`: the position along the loop is farther than 1.5 times that distance, so the neighbours of a sampled curve do not count,
another loop always does, and a point near a tip sharper than 67 degrees is not counted: a draft eats a tip, it closes a stroke). A 20 x 1 bar turned 45 degrees closes at a few degrees at depth 5, not at the 14.8 of its bounding box; a drafted "O" closes by the thickness of its stroke. Path `draftDeg`, `data.maxDraftDeg` and `data.thinnestPlace`.
`WRP_PARAM_INVALID`: walls pull without a pull, draft or pull without walls pull, draft outside [0, 45), a torus face, scribe, engrave, a grid or a chain, more than 4000 footprint segments or vertices (path `profileIds`). `data.expectedVolumeDelta` is A d on a plane without draft, null elsewhere (the numbers below are the references).
`check_wrap` counts pull reliefs (they have no `emboss` node, the step `emboss_on_face walls pull` identifies them): `checked.reliefsWithoutClosedForm`, `volumesSkipped`, a `WRP_CHECK_VOLUME_SKIPPED` warning, and the direction of the volume change (emboss adds, deboss removes) is checked (`WRP_CHECK_VOLUME_MISMATCH` otherwise).

**Measured (native kernel, `server/tests/nativeWrapWalls.test.ts`).** VC-25 pull +x on r 20, rectangle 30 x 10: 149.562188 / 298.308583 / 593.663229 at depth 0.5 / 1 / 2 (1e-6), against 151.875 / 307.5 / 630 for normal walls. VC-26 plane 20 x 10, d 2, 10 degrees, emboss and deboss: 379.1724 (1e-6); cylinder, 5 degrees, d 1:
318.0674 emboss (kernel 1e-4), 277.2150 deboss (1e-6); an oblique pull on a plane keeps A d; a sphere with the pull along its axis and a geodesic disc follows the cap integral (1e-3); text with a hole adds A d (1e-3); every refusal by code; replay equal. Fake-kernel unit tests: `tests/unit/wrap/walls.test.ts`.

### 14.9 Modeled diagonal and diamond knurl (DES-3c, FR-WRP-32)

`add_knurl model: "geometry"` now cuts the helical patterns (files `knurlHelix.ts`, `knurlHelixCut.ts`; new param `hand`). No native code changed.

**Construction.** One groove is one exact screw sweep: the helix is the native spine (`helixCurve`, radius r, lead 2 pi r / tan(beta), beta the helix angle from the axis), the section is a V in the plane through the axis (`orientation axis_plane`, as the rectangular wire of `add_coil`).
The V is defined NORMAL to the groove (`toothAngleDeg` is the included angle of a knurling wheel, default 90): in the plane through the axis its half-width slope is k = tan(gamma) / sin(beta) per unit of depth (gamma half the tooth angle). The grooves of a hand start at N equally spaced angles
(`HelixDefinition.startAngle`, N = round(pi d / pitch) so the teeth close), a diamond adds the grooves of the other hand; all are united (balanced) and subtracted in one boolean. The sweeps run from the face start minus the flank reach to the face end plus it, past free end caps.
Default depth leaves a land of 10 % of the pitch: h = 0.9 p cos(beta) / (2 tan gamma) (circumferential land = p - 2 h tan(gamma) / cos(beta), at least 2 % of p: `WRP_KNURL_DEPTH_INVALID`).

**Volume.** A screw motion keeps the transverse section, so one groove removes exactly A_t x (axial length), A_t = 2 tan(gamma) / (r cos beta) x [(r^3 - (r - h)^3) / 3 - (r - h)(r^2 - (r - h)^2) / 2] (-> h^2 tan(gamma) / cos(beta) for a shallow groove), independent of the lead:
a diagonal removes N x length x A_t (closed form, data.expectedVolumeDelta). A diamond removes the union of the two hand families, integrated numerically over 1200 transverse sections of 360 polar samples (`expectedMethod`); the command checks the measured volume against it
(1e-4 diagonal, 1e-3 diamond; measured 1e-5) and refuses otherwise.

**Bounds and refusals (performance is the binding one).** An exact groove is a B-spline sweep intersected with the cylinder: measured on the native kernel (this machine, loaded) on a face 40 long of radius 20: 12.6 s for 6 grooves at 30 degrees, 30 s for 12, 45 s for 8 at 45 degrees, and more than 120 s for 8 grooves at 60 degrees with a 60 degree V,
against the 60 s limit of one kernel call. The cost per groove grows with the helix angle, i.e. with the turns of a groove along the face (face length / lead): seconds = grooves x 2.3 x (turns / 0.184)^1.8 (13.8 / 27.6 / 49.6 / 133 for those four runs, about 10 % apart; the flank slope was not varied on its own: V angles between 60 and 90 degrees were measured).
A cut whose estimate exceeds 50 s is refused with `WRP_KNURL_TOO_MANY_GROOVES` and the estimate in the message (`data.estimatedKernelSeconds` and `data.turns` report it on success); a kernel that times out nevertheless refuses with `WRP_KERNEL_BUILD_FAILED` ("could not cut N helical grooves"). Helical grooves run past both ends of the face, so each
end must be a free cap: a shoulder or ring-shaped neighbour is `WRP_KNURL_GEOMETRY_UNSUPPORTED` (use the straight pattern or the cosmetic model). Real knurls (60 and more teeth at 30 degrees: 140 s and more) therefore stay cosmetic or straight until the kernel intersects such sweeps faster; a native tool that builds the knurled surface directly is the way forward.
`depth` is measured from the OUTER radius of the face: the apex of the V lies `depth` below the surface, the tool rises half the depth above it. `hand` is refused (`WRP_PARAM_INVALID`) with any pattern but diagonal or with the cosmetic model.
`check_wrap` counts a geometry knurl like a pull relief (skipped volume warning, removal direction checked).

**Measured (native kernel, `server/tests/nativeKnurlHelix.test.ts`).** d 40, h 40, 8 teeth, helix 30 degrees, 90 degree V: removed volume = 8 x 40 x A_t (1e-5), lead 2 pi r / tan(beta), land 10 % of the pitch; the left hand removes the same as the right; a diamond of 4 teeth x 2 hands at 45 degrees lies between
one and two single families and within 1e-3 of the numeric union (1.4e-5 measured: 4 teeth x 2 hands, depth 2, 15 s); refusals by code; replay equal. Fake-kernel unit tests: `tests/unit/wrap/knurlHelix.test.ts`.

### 14.10 Freeform (B-spline) face charts and emboss (DES-3c, VC-WRP-27)

`wrap_to_face` and `emboss_on_face` accept a face whose surface the kernel reports as `other` (a fitted B-spline: the result of a warp, a loft, an imported sheet). Files: `geometry/freeformChart.ts` (the chart), `commands/wrap/freeformSession.ts` (chart of the picked face), `embossFreeform.ts` (the relief recipe).

**Chart.** `faceQuery.bspline` gives the exact B-spline of the face; it must be in the face's own (u, v) (the anchor's `projectOnFace` point must lie on it within 1e-6 x the solid diagonal, else `WRP_METHOD_UNAVAILABLE`; a kernel with no B-spline, or a periodic surface, is the same refusal). _Geodesic:_ the exponential map about the anchor. A chart point at distance rho and direction psi (from the +Su tangent, turning towards Su x Sv) lands at the end of the geodesic of length rho in that direction. The geodesic equations (Christoffel symbols of the exact first and second derivatives, `lib/nurbs/surface`) are integrated in arc length by RK4 with 100 steps per diagonal of the pole box (at least 8 per shot); the Jacobi field J'' + K J = 0 (K the Gaussian curvature of the surface) rides along. J / rho is the ratio of the circumference of a geodesic circle to that of the chart circle: where it falls under 0.05 the map is folding (a conjugate point) and the point has no image. _Parametric:_ (u, v) = anchor + (x / |Su|, y / |Sv|), affine, exact pcurves. `develop` is `WRP_FACE_NOT_DEVELOPABLE` (the face is not known to be developable).

**Reversed faces and the side of the sketch.** The sketch is seen from OUTSIDE the solid: x follows +Su, y = outward x east with the outward normal of the solid at the anchor (`projectOnFace`), not the raw Su x Sv, because `faceQuery.bspline` reports `reversed` when the solid lies on the Su x Sv side of the face (a bore, a face of a reversed shell). The fake-kernel test checks the side with an asymmetric stroke.

**Integration step.** RK4 steps are at most 1/100 of the pole-box diagonal and at most 0.05 / |kappa|max of the anchor (the larger principal curvature of the first and second forms), at least 8 per shot; the area element is integrated span by span between the interior knots in v.

**Refusals by name.** `WRP_CHART_FOLD` (a sketch point at or beyond a conjugate point of the geodesic chart: use a smaller sketch, a flatter anchor or method parametric), `WRP_OUTSIDE_FACE` (the geodesic or the parametric rate leaves the parameter box, or a probe is off the trimmed face), `WRP_DISTORTION_EXCEEDED` (measured stretch above `maxLengthStrain`, default 0.02 named; `chartDistortion` with the exact area element `|Su x Sv|` integrated by Gauss-Legendre), `WRP_FACE_TOO_STEEP` (tested at the loop samples and at an 11 x 11 grid over the (u, v) box of the regions), `WRP_DEPTH_EXCEEDS_SOLID` (a deboss: the point `depth` below the face along the inward normal must stay inside the solid, probed at the anchor and the footprint samples with `faceQuery.distance`, `data.maxDepth` is the depth where the thinnest probe leaves it), `WRP_METHOD_UNAVAILABLE` (above, and scribe), `WRP_PARAM_INVALID` for `walls: "pull"` / `draftDeg` (checked right after the chart, with scribe, before any recipe is built). `data.walls` is `"pull"`: the walls run along the outward normal at the anchor. `wrap_to_face` stores each curve's pcurve in the face's own (u, v) (`onFace.frame: 'native'`), so `split_face_by_curves` takes it as is.

**Emboss / deboss / engrave.** The native `emboss` face-slab op reads plane, cylinder, cone, sphere and torus only, so the relief is composed from exact recipe nodes, the construction of the pull walls (§14.8): the walls are the lateral surface of the prism of each region along the pull (the outward normal of the solid at the anchor), and the top is the exact offset of the face (`faceOp moveFaces offset` by +-depth), so the depth is measured along the face normal everywhere: emboss = source + prism x (offset(+d) - source), deboss = source - prism x (source - offset(-d)); holes are prisms subtracted from the outer prism. The footprint prism is the region's image projected along the pull as an `extrusion` with exact `curves`: lines and cubic Beziers (Hermite ends from the exact tangent) split until the quarter points are within `fitTolerance` of the image (default 1e-6 x the diagonal), reported as `data.freeform.footprintDeviation`, with `footprintSegments` (at most 2000, else `WRP_PARAM_INVALID`). A 480-sided polygon prism of the same circle took 28 s in one boolean (the facet count scales the cost), the Bezier outline about 1 s. `WRP_FACE_TOO_STEEP` when the face is seen edge-on (|cos| < 0.01 at a sample) or from both sides by the pull over the region. `data.exact` is false (the walls are along the pull, not normal to the face), `data.freeform = { walls: 'pull', pullDirection, footprintDeviation, footprintSegments }`, `expectedVolumeDelta` is null (no closed form in general), `regionArea` is the area on the face (`areaRatio` x the sketch area).

**Measured (native kernel, `server/tests/nativeWrapFreeform.test.ts`; kernel with `faceQuery.bspline`).** A 78.54 x 30 x 6 plate bent 90 deg on R 50 (`bend_body`): its two big faces are B-splines that are secretly the cylinders R 50 (convex) and R 44 (concave). Geodesic chart circle a 6 on R 50 / a 5 on R 44: length 2 pi a within 1.5e-8, strain 1.0e-7 / 9.3e-8, area ratio 1 - 3e-8 (the development, from RK4 on the exact B-spline). Parametric chart on the same face: strain 5.3e-7. Relief of a circle with the pull walls, depth 1.5, against the closed form (layer between two radii along a parallel pull, footprint x = R sin(s / R)): emboss R 50 169.63628 (closed 169.63707, 4.7e-6), deboss R 50 -169.65481 (-169.65550, 4.0e-6), emboss R 44 117.81517 (117.81647, 1.1e-5), deboss R 44 -117.80211 (-117.80343, 1.1e-5), footprint deviation 7e-5 over 48 / 32 segments. A genuinely freeform plate (`deform_lattice`, four middle lattice points moved by +-10): geodesic chart of a circle a 14 on the top face has strain 2.24e-4 (mean 2.22e-4), area ratio 1.00012; emboss d 0.4 adds 246.330 mm3 = 0.9999994 x (area 615.826 x d) (pull +z, 64 segments). The five native tests of the file run in 59 s in all. Chart math without a kernel (`tests/unit/geometry/freeformChart.test.ts`): cylinder patch geodesic chart equals the analytic cylinder chart within 1e-7 R; sphere patch equals the analytic sphere chart (great circles) within 1e-6 R, circumference ratio sin(rho/R)/(rho/R) to 5 digits; saddle z = k (x^2 - y^2): radial length exact, circumference ratio sinh(2 k rho) / (2 k rho) within 2 %, area element against a midpoint rule within 1e-6; the sphere patch of 178 degrees folds at the antipode (`diagnose` fold). Stand-in kernel tests (`tests/unit/wrap/freeform.test.ts`) cover every refusal.

**Periodic and closed B-splines.** The native `bspline` of a periodic face arrives non-periodic (the surface is unwrapped over the face's parameter box), so a closed tube is charted as a strip: a sketch that would go round the seam stops there as `WRP_OUTSIDE_FACE`. A surface the kernel returns as periodic is refused (`WRP_METHOD_UNAVAILABLE`).

**Deviations (never silent).** (1) The conjugate-point test catches the first fold of the exponential map; a cut-locus overlap before it (two geodesics reaching one point) is not detected. (2) Walls are along the pull only (no `walls: 'normal'` on a freeform face: the native slab op would need a B-spline surface kind in its recipe parser); on a steep face the walls are not normal to it and the region is the vertical projection of the mapped loop. (3) `scribe` of a freeform face and `create_curve_on_face` geodesics are not built (use `mode: 'uv'` / `iso` there). (4) A freeform face the kernel parametrises differently from its B-spline is refused, not guessed.

### 14.11 Knurl and notes as AP242 PMI: researched, not built (DES-3c, 2026-10-30)

Question: can the cosmetic knurl (`KnurlPmi`) and `NotePmi` items go out in the STEP PMI export (`xcafMapping.ts` skips them: "no semantic AP242 transport form")?

- **OCCT 7.9.2 does not write XDE notes to STEP.** `XCAFDoc_NotesTool` / `XCAFDoc_NoteComment` exist (headers present, `TKXCAF.dll` carries them) but no `STEPCAFControl_Writer` or `_Reader` header mentions a note, and `TKDESTEP.dll` (the STEP reader / writer) contains no reference to any `XCAFDoc_Note*` class, where it does reference the dimension and tolerance classes the PMI channel uses. A note put in the XDE document would not reach the file, so a `notes` channel on the `ExchangePmi` transport (TS mapping plus C++ XDE writer) would be written and silently dropped. This was established from the headers and the binary, not by an export run.
- **No offline reference for the entities to write by hand.** The repository holds no copy of the CAx-IF recommended practice for PMI (or ISO 10303-242 text); `docs/aerospace/03-gdt-mbd-pmi/TECHNICAL_SPEC.md` 6.1 lists `DRAUGHTING_CALLOUT` / `TESSELLATED_ANNOTATION_OCCURRENCE` only as graphic PMI, V2, via `SetPresentation`, with no attribute-level detail. Post-processing the STEP text with hand-written `DRAUGHTING_CALLOUT` / `DESCRIPTIVE_REPRESENTATION_ITEM` instances, without the practice to check against, could not be validated by the importers that matter (NIST / CAx-IF checkers), so it is not done.
- **Unchanged behaviour:** the knurl and note items stay skipped and listed in the export report (`skipped[].reason`); the geometry knurl exports as faces; the knurl text stays in the document (`doc.pmi`) and on drawings.
- **To unblock:** supply the CAx-IF "Recommended Practices for Representation and Presentation of PMI (AP242)" (the note / annotation text and semantic-link sections) or a reference STEP file written by a CAD system with a knurl callout; then the writer step is a post-pass over the OCCT output (or a newer OCCT with note support), with the reader mapping `DRAUGHTING_CALLOUT` text back to review-required `NotePmi` items and an `import_step_exact` round-trip test.

### 14.12 Torus silhouette (DES-3c)

`split_at_silhouette` now divides a torus. With axis a, major radius R, minor radius r and the direction d = d_a a + d_p x̂ (x̂ the unit direction of the component of d perpendicular to the axis, ŷ = a x x̂), the surface point at azimuth u (from x̂) and tube angle v is
P = C + (R + r cos v)(cos u x̂ + sin u ŷ) + r sin v a, with the outward normal n = cos v (cos u x̂ + sin u ŷ) + sin v a. The contour generator n . d = 0 is cos v d_p cos u + sin v d_a = 0, solved per meridian angle in closed form:
**v_k(u) = atan(-d_p cos u / d_a) + k pi, k = 0, 1** (atan, not atan2: for d_a < 0 atan2 jumps by 2 pi at u = pi / 2 and 3 pi / 2 and the pcurve would be discontinuous; both signs of d_a give the same two curves) (n . d = (d_a d_p cos u - d_p cos u d_a) / h = 0 exactly). The result is two closed curves that each wind once round the axis (for d_a > 0: one on the side of the torus facing the view, one on the far side); along the axis (d_p = 0) they are the outer and the inner equator.
Files: `silhouette.ts` (`torusContours`), `splitAtSilhouette.ts`.

The curves are cubic B-splines fitted by `fitBySampling` to the closed form (uniform parameter, doubling from 8 nodes until the deviation at three points between nodes is within the tolerance; the nodes are exact contour points) and reported with their deviation: `data.silhouette.curves[].deviation` and the `onFace.fitTolerance` of each curve (tolerance = one tenth of the `tolerance` of the split, default
1e-5 x the diagonal / 10). Their pcurves are fitted in the face's own (u, v): the kernel's azimuth origin, the sense of u and the direction of its axis are read from three `evaluateFace` calls, and 48 points of each contour are checked against `evaluateFace` (position within 1e-7 x the diagonal and |n . d| <= 1e-6), `projectOnFace` and `faceContains`. A mismatch is "the parameter convention of the torus face
differs from its surface frame", a contour that leaves a trimmed torus is "leaves this torus patch", and a direction in the equatorial plane (d_a = 0: four crossing circles, two parallels and two meridians) is refused with its reason, all in `data.silhouette.unsupported` / `WRP_SILHOUETTE_UNSUPPORTED`. Along the axis the outer equator is the seam of the face: it is an edge already and is reported in `onEdge`.
Cone silhouettes (the two rulings of §14.7) were already built.

**Measured (native kernel, `server/tests/nativeSilhouetteTorus.test.ts`; R 10, r 3).** Along (0.3, 0.2, 1) with tolerance 1e-5: two fitted curves, deviation below 1e-6, n . d = 0 at the fit nodes to 1e-9, the torus is divided (more faces), total area 4 pi^2 R r and volume 2 pi^2 R r^2 kept (1e-4). Along the axis, from above or below: the inner equator of length 2 pi (R - r) (1e-6), the outer equator reported on the seam; along (0.3, 0.2, -1) the same two curves as along (0.3, 0.2, 1). The tests assert n . d at the fit nodes (exact by construction, 1e-9) and between them (within the reported deviation). In the equatorial plane: `WRP_SILHOUETTE_UNSUPPORTED`.
Stub-port tests (`tests/unit/wrap/silhouette.test.ts`) cover the same closed forms and every refusal.

### 14.13 Chains across cone, sphere and torus faces (DES-3c)

`wrap_to_face` and `emboss_on_face` accept `chain` over plane, cylinder, **cone, sphere and torus** faces (`chainCharts.ts`; `WRP_CHAIN_FACE_UNSUPPORTED` stays for freeform faces).

**Cone (developable, exact).** The cone's unrolled sector is its develop chart; an edge joins two faces when it develops to the same straight line, which for a cone is a ruling (the seams and the silhouette splits of §14.7). The chart of a cone is not affine, so the chart coordinates of an edge point are the natural coordinates of the inverse chart (`chartPointOf`) turned back by the placement
(rotation and mirror found from two probes of the chart). Lengths and angles are kept across the edge (mismatch 0).

**Sphere and torus (not developable, bounded).** The chart of each face is its geodesic chart anchored on the first point of the shared edge, rotated so that the edge points of the two faces agree in the chain's coordinates (least-squares rotation, the parallel transport of the frame to first order). The charts of a sphere and a torus agree on the edge only to second order, so the join is measured:
the **mismatch** is the larger of (a) the largest 3D distance between an edge point and the same point placed through the child's chart over the joined window and (b) the 3D distance between the parent's and the child's image of every point where the sketch actually crosses the edge line (`data.edges[].cutGap`), divided by the window length (`data.edges[].windowLength`; `length` is the whole edge), and the chain refuses above `maxLengthStrain` (default 0.02, named) with `WRP_DISTORTION_EXCEEDED` naming the two faces and the mismatch. The edge must also be straight in the parent's chart within half the limit (a geodesic that does not pass through
the anchor is a curve in a geodesic chart: the window of the edge kept is the stretch round the sample nearest the sketch - where it crosses - that is straight to half the limit, inside the reach of the chart: 0.8 x a quarter great circle on a sphere, 0.8 x half a tube turn on a torus), else `WRP_DISTORTION_EXCEEDED`; a sketch that crosses the edge line outside the window is refused (`WRP_DISTORTION_EXCEEDED`, "outside the ... of it the geodesic charts are joined over"), and the child chart is anchored on the window sample nearest the crossing. The points of a face within the join mismatch of an edge are accepted as on the face (`checkOnFace` slack). Every curve of the wrap and every region of the emboss is measured the same way (`data.distortion { maxLengthStrain, joinMismatch, curveStrain, limit }`).
A chain with a sphere or torus face needs `placement.method geodesic` (develop faces: `develop`), else `WRP_PARAM_INVALID`.

**Choice of edge and side.** Two faces can share several edges (the two rulings of a split cone): the edge the sketch crosses (sketch points on both sides of its chart line), else the nearest to it, is unfolded. A straight edge fixes the child chart only up to a reflection across it, so the chart that puts the child on the other side of the edge from the parent by the kernel's `faceContains` (probed more than the join mismatch away from the edge) is taken, and when no chart passes the side test the chain is refused with `WRP_CHAIN_CLIP_FAILED` (it does not fall back to the best-residual chart) (the handedness rule of
plane and cylinder faces does not hold for the cone's chart, whose axes are (tangent, radial)).

**Measured (native kernel, `server/tests/nativeWrapChain2.test.ts`).** Cone r 20 h 40 split along its two rulings (`split_at_silhouette` along x): a line of 30 from (10, 0, 20) across the ruling is 18.92919 + 11.07081 = 30 (1e-6, strain 1e-13, mismatch 0) and ends at hypot(rho0, 30) = 37.4166 from the apex at the azimuth atan2(30, rho0) / sin(alpha) of the flat sector (1e-6); the same with the placement turned 30 degrees; an emboss of an 8 x 6 rectangle over the ruling adds the
volume of the same emboss on the whole cone (1e-4). Torus R 10 r 3 split along two meridians (`create_curve_on_face` iso + `split_face_by_curves`): a band of 3 along the outer equator across a meridian, 1.3 + 1.7 with join mismatch 0.0085, ends 0.055 (1.8 % of the band) from the exact equator point; from an anchor 3.9 away (mismatch 6.3 %, the circumferential stretch K rho^2 / 6 of the geodesic chart)
the chain is refused with `WRP_DISTORTION_EXCEEDED`, and so is any limit below the measured mismatch.

**Deviations (never silent).** The chain of non-developable faces is a first-order unfolding: the join mismatch (over the window and at every crossing of the sketch) and the stretch are measured and refused above the limit, not zero. A sketch that leaves the joined window is refused rather than cut on the extended chord. A closed edge (a meridian) is joined only over the window the chart reaches, so a sketch farther from the edge than that is refused. The sphere / torus chains and the emboss closed form per face (`expectedVolumeDelta`) are checked on the native kernel only for the cone and torus cases above.

### 14.14 Variable TrueType: `gvar`, `avar` version 2, `MVAR` (DES-3c)

`variation` now instances TrueType fonts with a `gvar` table as well as CFF2 ones. Files: `lib/font/gvar.ts` (tuple variation store), `lib/font/variation.ts` (`avar` 2), `lib/font/mvar.ts`, `lib/font/glyf.ts` (the hooks), `lib/font/font.ts` (wiring).

**`gvar`.** Per glyph, a list of tuples: a peak (embedded, or an index into the shared tuples), an optional intermediate region (start / end per axis; without one the region runs from 0 to the peak), point numbers (private, or the glyph's shared ones when the header flag 0x8000 is set; count 0 = every point; runs
of byte or word steps), and packed deltas (runs of zeros, bytes, words) for x then y. A tuple's scalar at the instance is the product over axes of the usual tent (the region scalar of the `ItemVariationStore`, `regionScalar`); the tuple's deltas times its scalar are summed. The points are those of the glyph followed by four phantom points; a composite glyph's
points are its component offsets (then the phantoms). **IUP:** a tuple that names only some points leaves the others of a contour to be inferred, per axis, from the touched points before and after them in the contour (cyclic): one touched point moves the whole contour; between two touched points an untouched one takes the delta of the nearer
(in coordinate) end when it lies outside their range, the linear interpolation inside it, and 0 when the two touched points have the same coordinate but different deltas (the same delta when equal). The advance of a glyph without `HVAR` is the base advance plus (delta of phantom point 2) - (delta of phantom point 1); with `HVAR` that wins. The default instance reads
no `gvar` at all (the outline is the static one).

**`avar` version 2.** After the segment maps of version 1 (applied first, as before), a delta store: for every axis i (also one left at its default), through the optional axis index map (otherwise row i of subtable 0), `delta_i` is evaluated at the segment-mapped coordinates of all axes and the coordinate becomes
clamp(c_i + delta_i / 16384, -1, 1) (2.14 fixed point). A table that stops before the two offsets is damaged (`WRP_FONT_PARSE`); a store with more axes than `fvar` too.

**`MVAR`.** Value records (tag, outer, inner) over an `ItemVariationStore`; the deltas at the instance, rounded, are added to `hasc` (ascender), `hdsc` (descender), `hlgp` (line gap) and `cpht` (cap height, when it comes from OS/2). `xhgt` and the other tags are read and ignored (the layout does not use them).

**Bounds (like the CFF work).** At most 64 axes and 4096 shared tuples, the glyph count at most the font's, every offset and run checked by `ByteView`, point numbers inside the glyph (+ 4), runs inside their counts, at most 4095 tuples per glyph, tuples x points of a glyph at most 2e6, and the tuple work of all the glyphs of a font is charged to the same
operator budget as the CFF charstrings (20e6) when the font is scanned at import. `MVAR` has at most 256 records. Damage is `WRP_FONT_PARSE`; a font without variation data asked for an instance is `WRP_FONT_VARIATION`.

**Measured (`tests/unit/wrap/gvar.test.ts`).** Generated fonts with closed-form outlines: wght 900 moves the right corners by 40 and IUP gives 20 / 40 / 20 / 0 to the points between (x = 0, 70, 140 ...), the advance +40 through the phantom point (HVAR +100 wins when present); wght 650 scales by 0.5 and the intermediate tuple (0.25 / 0.5 / 1) is at its peak (+8);
wght 550 gives its 0.2 scalar; the wght- tuple's single touched point moves the whole contour by -10 s; composite offsets move by their deltas; a 150-point list (two-byte count), a step of 300 (word point numbers) and a delta of 300 (word delta) are read; `avar` 2 moves wdth to 0.5 at wght 900 (so the wdth tuple scales by 0.5) and to 0.125 through a bent wght map; `MVAR` moves the metrics (+50 / -20 / +10 / +30 at wght 900,
half at 650). On Bahnschrift (system font, test skipped without it): the I stem grows with wght (144 / 204 / 284 wide at wght 300 / 400 / 700), the H narrows with wdth 75 (advance 1390 -> 870), the point structure is the same at every instance, and all glyphs of three instances read within the budgets. No reference outlines of a third-party renderer were available offline, so the real-font checks are properties, not values.

### 14.15 Mitred walls across a sharp plane-plane edge (DES-3c)

An emboss or deboss chain whose outline crosses a straight edge between two plane faces is built face by face (slabs with walls normal to their face, §14.6) and the corner is closed by a mitre (`embossMitre.ts`).
With the two outward normals nA, nB at the edge, the depth d and s = +1 (emboss) or -1 (deboss), the offset planes meet at M = s d (nA + nB) / (1 + nA . nB) from the edge. A convex edge with an emboss, or a concave edge with a
deboss, leaves the column (edge, s d nA, M, s d nB) between the slabs: a prism along the edge over the stretches the outline covers (one per pair of crossings) is united (emboss) or subtracted (deboss). In the other two
cases (emboss on a concave edge, deboss on a convex edge) the slabs overlap by the same column and the union already is the mitred corner, so no filler is built and the closed form loses the overlap.
`data.expectedVolumeDelta` includes both: 48 d + d^2 L = 54 for an 8 x 6 rectangle centred on the edge of a box (d 1, L 6), 42 where the slabs overlap. `data.mitre` lists per edge `kind` (filler / overlap), the number of intervals, the covered length and the
cross-section area, with `fillerVolume`, `overlapVolume` and `exact`.

**Exactness.** The overlap of the two slabs is only as wide as the outline: the closed form is exact (`exact` true) when, over every covered stretch, the outline contains the strip of the clip polygon's reach on both faces, and when no outline comes within that reach of the edge without crossing it; otherwise `exact` is false, `expectedVolumeDelta` null and `data.mitre.reasons` says why. The filler is a column outside both slabs and does not depend on the width of the outline. Only the stretch of the line that is the edge counts (pieces meeting the line beyond its ends belong to another edge of the chain).

**Refused by name (`WRP_CHAIN_EDGE_SHARP`, the message says which):** a convexity the kernel left unknown; an edge between faces that are not both planes; an edge sharper than the mitre can follow (|M| > 20 d); where a filler is needed, an outline that crosses the edge at an angle
(only segments at right angles to the edge have a column the prism fills), through a vertex, with a curved piece, an odd number of times, or beyond the end of the edge. Where only an overlap is concerned the same crossings are built and `exact` is false (`expectedVolumeDelta` null: the closed form
does not know the overlap). Scribe crosses sharp edges as before.

**Measured (native kernel, `server/tests/nativeWrapMitre.test.ts`).** Box 60 x 40 x 10, rectangle 8 x 6 centred on the top-side edge, d 1: emboss on the convex edge +54 (the filler 6), deboss -42 (overlap 6); on the concave edge of an L-shaped solid emboss +42, deboss -54; each within 1e-5 of the
closed form on the exact solid.

### 14.16 Silhouette of freeform (B-spline) faces (DES-3c)

`split_at_silhouette` traces the contour n . d = 0 of a B-spline face on the exact surface of `faceQuery.bspline` (the face's own (u, v)). G = n . d / |n| is sampled on a 48 x 48 grid of the face's parameter box; the sign changes
are linked by marching squares into polylines (open ones end on the box, closed ones are loops); every crossing is refined to the contour by bisection on its grid edge. A trimmed face is handled with `faceContains`: the
polyline is cut at the trimming boundary by bisection (each probe re-projected onto F = (S_u x S_v) . d = 0 by Newton on the exact first and second derivatives). Each piece is an interpolating cubic through the refined vertices (decimated to
a third of a cell), projected back onto the contour at every evaluation, and then fitted as a cubic B-spline within the tolerance (the pcurve in the face's own (u, v) likewise); `deviation` is the larger of the two fits, and the
fitted curve is checked against `projectOnFace` / `faceContains` at 48 points. A contour along a boundary of the face already is an edge (`onEdge`), a face with |n . d| < 1e-9 at every node is edge-on (`edgeOn`).

**Refused by name** (`WRP_SILHOUETTE_UNSUPPORTED` with the reason, the face left unsplit): no B-spline from the kernel; a periodic B-spline; a pole or collapsed edge (|S_u x S_v| = 0 at a node); a face seen almost tangentially
(|n . d| < 1e-3 everywhere without a sign change: a double root cannot be traced); a cusp or branch point (the gradient of n . d along the contour falls under 5 % of its largest value, Newton does not converge, or a grid cell
has four crossings); a fit that misses the tolerance.

**Measured.** Closed forms on the fake freeform kernel (`tests/unit/wrap/freeformSilhouette.test.ts`): a cylinder patch R 20 h 40 seen along (0.2, 1, 0) gives the ruling at azimuth -atan 0.2, length 40 to 1e-6, deviation under the
tolerance 1e-6; a saddle z = 0.05 (x^2 - y^2) seen along x gives the parabola x = 0, length 2 [(5/2) sqrt(1 + a^2 25) + asinh(5a) / 2a] (a = 0.1) to 1e-6, and the skew view (1, 0.3, 0) the line x = 0.3 y; cut at y = 3 the arc is the
closed-form partial integral; a bump seen along (1, 0, 0.5) has one closed loop with |n . d| < 1e-7 on the exact surface. Native OCCT (`server/tests/nativeSilhouetteFreeform.test.ts`): a plate bent 90 degrees on R 50 (two B-spline faces,
R 50 and R 44) seen along (cos 30, 0, sin 30) gives two rulings of length 30 (error under 1e-5) at 30 degrees from the vertical (points within 1e-3 of the cylinder, the bent B-spline's own fit), fit deviation 4e-11; each curve alone
divides its face into arcs of 30 and 60 degrees times the width (1e-3).

**Deviations (never silent).** Features smaller than a cell of the grid (an island or a fold inside one cell) are not seen; a branch point inside a cell is refused when the contour's gradient falls under 5 % of its maximum or the
cell has four crossings, a crossing that passes both tests is traced as two smooth branches. Contour features smaller than 1/48 of the parameter box of the face are not seen (`data.silhouette.grid` = 48); the closed loops are fitted with the same direction at both ends (the seam is C1); the guards on Newton failing
(the sampler answers null, the fit refuses "Newton cannot follow"; after the fit every probe's distance to n . d = 0 is checked) are exercised through the test hooks of `freeformContours` (a field or projection no real surface gives) and by a C0 crease. A kernel defect found on the way (two sequential
face splits merged the first back, `UnifySameDomain` keep set) is fixed in `split_shape` (fix/split-shape-keep): the bent plate gives 8 faces.

### 14.17 Review overlays: curves on faces and face joins (DES-3c)

The read-only query `wrap_overlay` (`id`, optional `samples`) returns what the viewport draws, in world coordinates: `curves` (every `nurbs_curve` with `onFace` that lies on the solid, or on an earlier solid that no longer exists, as
`source: "earlier"`, because a silhouette split keeps the curves of the solid it consumed) and `edges` (the B-rep edges of the solid with the faces each joins and their convexity from `faceGraph`; null without the exact kernel, with
`edgesNote`). It is capped at 64 curves and 400 edges (`truncated` names what was cut). The UI toggle "Wrap" (viewport toolbar, `src/ui/viewport/3d/overlays/WrapOverlay*.tsx`, state in `wrapOverlayStore`, nothing persisted, no command) draws the
first four selected solids: curves orange (earlier solid: yellow) and the edges by what a chain across them does: smooth green (the sketch develops across), convex orange and concave blue (mitred between two planes, §14.15), unknown grey, with a legend and a layer
switch for each. Verified on the native kernel through the server and a headless Chromium (a bent plate with its silhouette curves and a stepped block with a convex and a concave edge); the geometry mapping and the toggles are in `tests/component/WrapOverlay.test.tsx`.
**Left:** the footprint of an emboss on its face and the join mismatch per edge need data the document does not keep (they are results of the command, in `data.edges` of `emboss_on_face`); the join mismatch stays a result of the command. The footprint and the knurl pattern before the command runs are done in 14.19.

### 14.18 Vertical metrics variations and named instances (DES-3c)

**Advance heights.** `ParsedFont.verticalAdvance(glyph)` is the advance height in font units: the `vmtx` entry (the last long metric repeats for the glyphs after `vhea.numOfLongVerMetrics`), else ascender - descender when the font has no
vertical metrics, moved at an instance by `VVAR` (the delta of the row the advance-height map gives, else row = glyph index of subtable 0; rounded to a font unit) or, for a gvar font without `VVAR`, by the phantom points of the glyph (the
third minus the fourth phantom point, the vertical counterpart of the width from the first and second). A `VVAR` is read at the instance only when the instance moved an axis; its version must be 1, its store and every offset of its four
mappings must lie inside the table (the side-bearing and origin mappings are validated and not used). Damage is `WRP_FONT_PARSE`; a `vhea` with more long metrics than glyphs or a `vmtx` shorter than its glyphs need refuses when a height is asked.

**Named instances.** The `fvar` instance records (subfamily name id, flags, one Fixed per axis, optional PostScript name id; the record size must be 4 + 4 axes or 6 + 4 axes, at most 4096 records, every value inside its axis) are listed in
`ParsedFont.namedInstances` with the strings of the `name` table (an instance whose subfamily name id has no string is left out). `parseFont(bytes, {}, name)` and `import_font instance="Bold"` pick one by its subfamily or PostScript
name, any case, and mean the axis values of that record (the record stored in the document carries them as `variation`, so `add_text font=<id>` follows). A name the font does not have lists the names it has; a name together with
`variation`, or on a font without axes, is `WRP_FONT_VARIATION`. `data.namedInstances` of `import_font` lists name, PostScript name and axis values.

**Names in every language.** The `name` table keeps every language of a name id (at most 16 per id, every record read): the preferred string is Windows English (0x0409), then Unicode, then Macintosh English, then the others in table order,
and a requested name is matched against every language of the instance's subfamily and PostScript name ids, so a localised record that comes later never hides the English one and `instance="Gras"` works as well as `Bold`.
**A bad instance record is not a bad font.** A record whose values lie outside their axes is left out, a record table that cannot be read (a size that fits neither form, more than 4096, cut short) lists no instance; both are lines of
`ParsedFont.namedInstanceProblems` and of `data.namedInstanceProblems` of `import_font`. An ItemVariationStore that starts inside the 20-byte header of an HVAR or the 24-byte header of a VVAR is `WRP_FONT_PARSE`.
**`font_metrics`** (read-only, `font`, optional `text`, `variation` or `instance`) is where the heights are read: the vertical metrics at the instance and the glyph, advance width and advance height of each character, with the sums.

**Measured (closed forms by construction, `tests/unit/wrap/vvar.test.ts`).** Heights 1000..1400 with a VVAR of 0, 10, 20, 30, 40 on wght+: at wght 900 the glyphs read 1000, 1110, 1220, 1330, 1440, at wght 650 (coordinate 0.5)
1000, 1105, 1210, 1315, 1420; through a map to rows 3 - k: 1030, 1120, 1210, 1300, 1400; without vmtx 1150 + 10 k; the phantom fallback 30 - 10 = 20 on glyph 2. Four instances give four names, and `Bold`, `bold`, `Test-Bold` equal
the explicit {wght: 700} (instance, advances, outline). **Left:** none: vertical layout of text and `VORG` are §14.20.

### 14.19 Footprint and knurl previews (DES-3c)

**Queries.** `preview_emboss_on_face` and `preview_add_knurl` take exactly the params of `emboss_on_face` / `add_knurl`, run the same placement and refusals (the shared `runEmboss` stops before the kernel build; `planKnurl` is the knurl's own plan), and change nothing (`document` returned as is, `affected: []`). Emboss: `data.footprint` = the loops of the sketch on the face as world polylines (`hole`, `points`, at most 600 points per loop), the chart's distortion, `expectedVolumeDelta` and the method. A chained emboss (`chain`) is refused (`WRP_PARAM_INVALID`). Knurl: `data.lines` = the groove lines (straight, diagonal, diamond; at most 400 lines, every n-th one drawn when thinned, at most 200 points each), `teeth`, `pitch`.

**UI.** The palette form of the two commands (`preview` on) sends the typed params, debounced 250 ms, to the query (backend when online, local otherwise: `useHostQuery`) and draws the answer as a ghost on the face (`FootprintPreviewLayer`: loops cyan, holes magenta, knurl lines amber) with the query's own summary, or its refusal, in a `role="status"` line. Invalid or incomplete params, leaving the form or turning `preview` off clear the ghost. Nothing in the UI derives geometry. Tests: `tests/unit/wrap/preview.test.ts`, `tests/component/FootprintPreview.test.tsx`.

**Review fixes (2026-10-31).** The knurl ghost draws the grooves the recipes sweep: one phase function (\`knurlGeometry.toothAzimuth\`, \`knurlHelix.helicalAzimuth\`, in the frame of \`axisFrame(axis, origin)\`, the helical sweep starting at \`grooveSpan.z0\`) is read by both recipes and the preview, which only clips to the face and thins; a cylinder whose surface frame is turned gets the same lines. With \`model: "geometry"\` the preview and the command share \`planKnurlGeometry\` (tooth angle, depth, land, reach, bore, kernel-time envelope, free end caps), so the refusals before the build are the same code and path. A preview hands no build to the kernel: with \`walls: "pull"\` and a draft the drafted walls are not built (\`data.draftChecked\` says the command builds and checks them; the draft-closing check still runs). The form finds the query in \`annotations.previewQuery\` of the command and the answer says what it is in \`data.kind\` (\`footprint\` or \`lines\`); the query is asked again when the entities of the document change, and a request is aborted when its params change or the form closes.

### 14.20 Vertical text layout (DES-3c)

**Parameter.** `direction: "horizontal" | "vertical"` on `add_text` (stored on the text entity, so `edit_step_params`, replay and every consumer of the entity follow it: `text_outline`, `extrude_profile`, the sketch outlines of `emboss_on_face` / `wrap_to_face`, all through `outlineOfText`) and as an override on `text_outline`
(like `kerning`). Default horizontal: nothing changes for existing documents (the layout of a horizontal text is the same code path).

**Layout** (`lib/font/layoutVertical.ts`, CJK style, glyphs upright; no `vert` / `vrt2` substitution, no rotated Latin). Per column (a line; a newline starts the next): the glyph k is hung from its VERTICAL ORIGIN, the point of the glyph that sits at the pen,
and the pen moves DOWN by the vertical advance of the glyph plus `letterSpacing`:
- vertical advance = `ParsedFont.verticalAdvance` (`vmtx` at the instance, `VVAR` / phantom points, ascender - descender without vertical metrics, §14.18), scaled by cap height / font cap height like the widths;
- vertical origin = `ParsedFont.verticalOrigin(glyph)`, y above the baseline and its source: (1) `VORG` for a CFF font that has the table: the record of the glyph, else `defaultVertOriginY` (version must be 1.0, at least 8 bytes and 4 per record, else `WRP_FONT_PARSE`; a `VORG` on a TrueType font is not read);
  (2) `vmtx`: the OpenType default, yMax of the glyph + its top side bearing (the highest CONTROL point: the glyf header yMax of a TrueType glyph at the instance, the charstring points of a CFF / CFF2 glyph; the entry of the glyph's long metric, or the bearing array after them), source `vmtx`;
  at an instance the bearing is moved by the `VVAR` top-side-bearing mapping when the table has one, and for a gvar font WITHOUT `VVAR` the origin is the default yMax + bearing + the delta of the top phantom point (the one the glyph variations move), as the vertical counterpart of the advance; (3) otherwise (no `vmtx`, a blank glyph) the ascender at the instance (`MVAR` hasc), source `ascender`. The origin in x is the middle of the advance width;
- glyph point (x, y) in font units goes to (s x + cx - s advance / 2, s y + top - s origin_y), s = document units per font unit, cx the column's x, top the pen's y;
- `position` of the text is the VERTICAL ORIGIN of the first glyph of the first column (the top of its advance box); the first column sits at position.x, column k at x = -k pitch from it. The pitch is `ParsedFont.verticalLine`: `vhea` vertTypoAscender - vertTypoDescender + vertTypoLineGap moved by `MVAR` `vasc` / `vdsc` / `vlgp` at the instance (source `vhea`), else the horizontal ascender - descender + line gap (source `hhea`), times `lineSpacing`;
- `anchor`, PER COLUMN (its width is the widest advance in that column, so two columns of different width are aligned by their own width): center puts the middle of the advance widths on the column's x, left the column's left edge, right its right edge;
- `verticalAnchor`: baseline and cap_top put the top of the first advance box on y = 0 (the text hangs from the position), cap_middle centres the column on y = 0;
- kerning is not applied (the pairs are horizontal; `vkrn` is not read), `letterSpacing` goes between glyphs vertically.
`data` of `text_outline`: `direction`, `advanceWidth` (the widest column), `advanceHeight` (the tallest column: vertical advances plus spacing; absent for horizontal text), `lines` (the column count); `font_metrics` lists `verticalOrigin { y, source: "VORG" | "ascender" }` per character.
Areas, loop counts and outline lengths do not depend on the direction (same glyphs, other places).

**Refusals** (by name, with remediation): `WRP_TEXT_NO_FONT` (vertical without a font), `WRP_TEXT_VERTICAL_CURVE` (vertical together with `onCurve`, in `add_text` and in `text_outline` / the shared outline path: vertical text does not follow a curve); a bad `direction` is an invalid parameter.

**Measured (closed forms by construction, `tests/unit/wrap/verticalText.test.ts`).** Fixture font: heights 1000..1400 (A 1100, B 1200), top side bearings 700 / 650 / 600 / 500 (origins 800 / 750 / 700 / 549), widths 600 / 700, ascender 900, descender -250, line gap 100, cap height 700; height 7 (0.01 per font unit), centre anchor:
A (square 100) at x -3..-2, y -8..-7; B (triangle) at x -3.5..-2.5, y -18.5..-17.5; advanceWidth 7, advanceHeight 23 (11 + 12), letter spacing 2 moves B to y -20.5..-19.5 (advanceHeight 25); cap_middle: A at y 3.5..4.5; anchor left: B at x 0..1; right: x -7..-6;
the origin: VVAR top-side-bearing map at wght 900: A 820, B 760; a gvar font without VVAR (top phantom +25 at wght 900): A 825; a vmtx with 2 long metrics: bearings after them; MVAR vasc +100 and vlgp -20 at wght 900: pitch 1230;
two columns "A
B": B at x -15..-14 (vhea pitch 1150 = 11.5; 12.5 from hhea on a font without vhea, B at x -16..-15), lineSpacing 2: x -26.5..-25.5; "AB
A" with anchor left: first column A x 0.5..1.5 / B x 0..1, second column (width 6) x -11.5..-10.5; right: -6.5..-5.5 and -17.5..-16.5; center: -14.5..-13.5. Without vmtx every height is 1150 and the origin the ascender: B at y -20.5..-19.5. CFF with `VORG` (default 950, glyph 2 -> 700): A at y -9.5..-8.5, B at y -18.5..-17.5; negative origins and a 60-record binary search read.
Real fonts: Fira Sans has no vertical metrics (height = ascender - descender, origin = ascender); Bahnschrift, when installed, takes the same fallback (the test is skipped where the file is absent). Areas stay 1.5 (square + triangle) in both directions.
**Wrap paths.** `extrude_profile` of the vertical AB (Manifold kernel): volume 3 = 1.5 x depth 2, bbox x [-3.5, -2], y [-18.5, -7], z [0, 2]; `preview_emboss_on_face` on a cylinder R 20 (develop chart, fake exact kernel) with the vertical text as the profile: the same two loops and the relief volume 1.5 x 1.025, 11.5 tall along the axis (1 for the horizontal text).
**Red-proofs** (each mutation fails these tests of `verticalText.test.ts`): top side bearing ignored (14), `VORG` read on a TrueType font (1), the horizontal pitch in place of the vhea one (2), the top-phantom delta ignored (1), the VVAR bearing map ignored (1); in the first version (origin = ascender): vertical origin 0 (7), horizontal advance in place of the vertical one (10), `VORG` ignored (3).
**Left:** `vert` / `vrt2` glyph substitution, rotated Latin runs (tate-chu-yoko), `vkrn` vertical kerning, vertical layout on a curve, the VVAR vertical-origin mapping (`vOrgMapping`, read for validation only).
