# RV1 — Realistic visualisation and large scenes: the gap to Blender (2026-11-27)

**Status:** planned (owner decision of §6, 2026-11-27); nothing built. Written at the owner's request ("why does Blender succeed with big, very realistic 3D models and digital
twins, what are we missing; evaluate the gap, verify it against what we have, write the specs and the validation layers").
Nothing here is built.

## 1. The short answer

Blender's pictures look real for five reasons, none of which is modelling accuracy:

1. **Light transport.** Cycles is a path tracer: it follows light through many bounces, so soft shadows, colour bleeding, reflections,
   refraction and ambient light come out of the physics instead of being faked. A denoiser and adaptive sampling make it affordable.
2. **Appearance data.** Every surface carries a layered physically based material driven by image textures (base colour, roughness,
   normal, displacement) laid out with UV coordinates, lit by a measured HDR environment.
3. **A colour pipeline.** Rendering is done in scene-linear light and shown through a film-like view transform (AgX), with HDR
   files (OpenEXR) as output.
4. **Scale by sharing, not copying.** Instances share one geometry, linked libraries keep a big scene in many files, and the
   renderer builds a bounding-volume hierarchy over it.
5. **Assets and people.** Most of the realism in a published "digital twin" image is authored: scanned textures, HDRIs, asset
   libraries, and an artist's lighting.

Blender is not an engineering tool: meshes instead of exact B-rep, no parametric history, no units discipline, no checks, no
semantic plant data. Its "digital twins" are visual twins; the live-data kind is built on USD platforms, not in Blender itself.
llull is the reverse: the engineering content is there and the picture is a deterministic technical raster.

So the gap is **rendering and appearance, not geometry or scale of repeated parts**.

## 2. What the research found (Blender)

| Area               | What Blender does                                                                                                                          | Source                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| Integrator         | Path tracing with direct light sampling; a light tree picks lights by distance and intensity; path guiding for hard light paths (CPU only) | Cycles manual, Sampling                                |
| Noise control      | Adaptive sampling to a target noise level; OpenImageDenoise (default) and OptiX denoisers                                                  | Cycles manual, Sampling                                |
| Real-time engine   | EEVEE (4.2 on): virtual shadow maps, screen-space ray tracing for every BSDF, light-probe volumes; no hardware ray tracing yet             | EEVEE 4.2 release notes                                |
| Colour             | OpenColorIO; render in scene-linear; AgX view transform (16.5 stops) replaces Filmic                                                       | Manual, Color Management                               |
| Instancing         | Instances duplicate an object without duplicating its data; 8 nesting levels drawn; the viewport becomes CPU-bound near 100k instances     | Manual, Geometry Nodes Instances; Blender issue 113771 |
| Scene assembly     | Linked libraries with library overrides keep linked data editable and in sync; reloading overrides is expensive                            | Manual, Library Overrides                              |
| Exchange           | USD import / export (scene-graph instances as collection instances, UsdPreviewSurface materials), Alembic, glTF                            | Manual, USD                                            |
| Engineering limits | Mesh representation, single precision, no parametric history; exports are "dumb" meshes                                                    | community comparisons (anecdotal)                      |

Sources are listed in §9. Version caveat: the manual pages span Blender 3.5 to 5.x; details differ between releases.

## 3. What llull has today (verified in the code, 2026-11-27)

| Area             | Has                                                                                                                                                            | Evidence                                                                                             |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Reference render | CPU z-buffer raster: flat Lambert + Blinn-Phong highlight, 2x supersampling, sun shadow map (1024), Preetham sky; size clamped to 64..2000 px                  | `packages/core/src/commands/render/renderView.ts`, `rasterScene.ts`, `sunShadows.ts`, `skyRaster.ts` |
| Native raster    | Bit-identical CPU twin and an optional wgpu path; Hi-Z occlusion culling                                                                                       | `solver/crates/llull-raster`                                                                         |
| Viewport         | three.js: ACES tone mapping, procedural environment (no HDRI file), key light with cascaded shadows, half-res GTAO, outline pass, FXAA                         | `src/ui/viewport/3d/`                                                                                |
| Materials        | colour, metalness, roughness, five procedural finishes (256 px maps, box-projected UVs), text decals                                                           | `packages/core/src/model/types.ts`, `model/materialFinish.ts`                                        |
| Scale            | GPU instancing, frustum / 1-px culling, 3-level LOD, octahedral impostors, instance BVH, packed instance arrays up to 4,000,000 members, streamed point clouds | `geometry/renderPlan.ts`, `model/instanceArray.ts`, `solver/crates/llull-bvh`, `llull-cloud`         |
| Exchange         | glTF export with PBR, finish textures and GPU instancing; STEP AP242; IFC export; E57 / LAS / LAZ / PLY clouds                                                 | `commands/exchange/exportGltf.ts`, `domain-aec`                                                      |
| Site             | latitude / longitude / date, NOAA sun, terrain, scan-to-model deviation                                                                                        | `commands/document/siteContext.ts`, `domain-aec/src/scan`                                            |
| Animation        | spin / oscillate clips, walkthroughs between viewpoints, simulation playback, MP4 / GIF / APNG                                                                 | `commands/motion/animation.ts`, `solver/crates/llull-media`                                          |

Stated position today: "Physically-based offline path tracing. `render_view` stays a deterministic rasteriser." is listed as out of
scope in `docs/plant/09-plant-visualization-review/FUNCTIONAL_SPEC.md`.

## 4. The gap, one line each

| Id  | Gap                                    | Blender                                               | llull today                                                        | Weight                 |
| --- | -------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------ | ---------------------- |
| G1  | Global illumination                    | path tracing, many bounces                            | none: direct sun + constant ambient 0.35                           | critical               |
| G2  | Reflection and refraction              | traced, glass and metal are correct                   | none in renders; environment reflection in the viewport only       | critical               |
| G3  | Soft and multiple shadows              | any light, area lights                                | one sun shadow map, hard                                           | high                   |
| G4  | Ambient occlusion in renders           | implicit in the integrator                            | viewport only; `render_view` draws none                            | high                   |
| G5  | Denoising and adaptive sampling        | OpenImageDenoise, target noise                        | not applicable (no sampling)                                       | critical (with G1)     |
| G6  | Image textures and stored UVs          | full texture pipeline                                 | `MeshData` is positions + indices; procedural 256 px finishes only | critical               |
| G7  | Layered physical materials             | Principled BSDF (coat, sheen, transmission, emission) | colour, metalness, roughness, clearcoat on finishes                | high                   |
| G8  | Material library with appearance       | asset browser, shared libraries                       | ten display classes; engineering material data only                | high                   |
| G9  | HDR environment lighting               | HDRI files, sky models                                | procedural light formers; Preetham sky backdrop                    | high                   |
| G10 | Light objects                          | point, spot, area, sun, emissive meshes               | sun from the site context only                                     | high                   |
| G11 | Camera objects                         | focal length, depth of field, motion blur             | viewpoints with field of view only                                 | medium                 |
| G12 | Colour pipeline and HDR output         | scene-linear, AgX, OpenEXR                            | sRGB PNG; no tone mapping in offline renders                       | high                   |
| G13 | Render resolution                      | arbitrary, tiled                                      | 2000 px maximum                                                    | medium                 |
| G14 | Transparency in renders                | traced                                                | none in the raster                                                 | high                   |
| G15 | Scene assembly from many files         | linked libraries, overrides                           | one JSON document; no external references                          | high                   |
| G16 | Instance-array members in the viewport | drawn                                                 | stored and rendered offline, not drawn in the viewport             | medium                 |
| G17 | Tiled streaming of mesh geometry       | (not Blender's strength either)                       | point clouds stream; meshes do not                                 | medium                 |
| G18 | USD / USDZ                             | import and export                                     | none                                                               | high for digital twins |
| G19 | glTF import fidelity                   | materials, textures, hierarchy, animation             | base colour only, hierarchy flattened, no Draco / meshopt          | medium                 |
| G20 | Keyframe animation                     | full curve editor                                     | spin / oscillate clips and walkthroughs                            | medium                 |
| G21 | Scatter and procedural dressing        | geometry nodes                                        | patterns and arrays; no scatter                                    | low                    |
| G22 | Live data on the model                 | (not in Blender; USD platforms)                       | rule colouring on properties; no time series or live source        | high for digital twins |
| G23 | Full coordinate reference systems      | add-ons                                               | 2D Helmert calibration only                                        | medium                 |
| G24 | Real-GPU verification                  | large user base                                       | cascaded shadows and impostors not yet checked on a real GPU       | medium                 |

Where llull is already level or ahead, and should not spend effort: exact geometry and checks, repeated-part scale (instancing,
LOD, impostors, 4,000,000-member arrays), point-cloud streaming, STEP / IFC, deterministic reference renders.

## 5. Specification

One new native renderer, the appearance data it needs, and the scene assembly around it. Everything obeys the architecture laws:
each capability is a registered command (L1), native code lives in `solver/` behind a host transport (L6, L9, C7), nothing needs a
network (AF-41).

### RV-M1 — Appearance data (closes G6, G7, G8)

- `MeshData` gains optional `uvs` and `normals`; kernels fill box-projected UVs where none are stored.
- An image asset store beside the mesh asset store (content-addressed, outside the document).
- Commands: `import_texture`, `set_material_appearance` (base colour, metalness, roughness, normal, emission, transmission, index of
  refraction, coat, each a value or a texture reference), `apply_appearance`, `list_appearances`.
- A local appearance library (steel, galvanised, painted, concrete, insulation cladding, glass, rubber) shipped offline.
- Limits declared up front: texture size cap, total texture memory budget, refusal codes when exceeded.

### RV-M2 — Lights, cameras, environment (closes G9, G10, G11)

- Entity kinds `light` (sun, point, spot, area) and `camera` (focal length, sensor, focus distance, aperture) through the
  `add-entity-kind` checklist.
- Commands: `add_light`, `add_camera`, `set_environment` (HDR file from the asset store, or the existing sky model with turbidity).
- The site context sun stays the default; a document without lights renders as today.

### RV-M3 — Path-traced render (closes G1 to G5, G12 to G14)

- New crate `solver/crates/llull-pathtrace` (Rust, wgpu compute with a CPU reference path), reached through the existing native
  raster host port. BVH from `llull-bvh`; instances traced without expansion.
- Command `render_realistic` (a new command; `render_view` stays the deterministic technical raster, so spec 09 keeps its promise
  for that command).
- Params: camera or viewpoint, size up to 8192 px (tiled), samples or target noise, bounces, denoise on / off, seed.
- Unidirectional path tracing with next-event estimation and multiple importance sampling; a GGX metal-roughness BSDF with coat and
  transmission; environment importance sampling.
- Output in scene-linear: OpenEXR and tone-mapped PNG (AgX-like view transform, documented curve).
- The result records sample count, seed, device and `deterministic: true | false` (PERF1 rule 4: no silent trade).
- Denoiser: a bundled open model run locally; off by default for reference renders.

### RV-M4 — Viewport realism (closes G16, G24, part of G9)

- HDR environment files in the viewport; instance-array members drawn through the existing batch renderer.
- Human gate on a real GPU for cascaded shadows, impostors and the new environment (VIS-HUMAN).

### RV-M5 — Scene assembly and scale (closes G15, G17)

- External references: `link_document` places another `.llull` file as a read-only component with overrides for placement,
  visibility and appearance; guarded like plugin-derived geometry (L8).
- Tiled mesh streaming for a linked document, reusing the octree and store design of `llull-cloud`.

### RV-M6 — Exchange (closes G18, G19)

- `export_usd` / `import_usd`: hierarchy, instances as scene-graph instances, UsdPreviewSurface materials with textures.
- glTF import: full metal-roughness materials with textures, hierarchy kept, Draco and meshopt decoded.

### RV-M7 — Digital-twin data (closes G22, G23)

- `bind_data_source` (a local file or a local broker; no cloud), `set_tag_binding`, `colour_by_live_value`, a small local
  time-series store with `replay_time_range`.
- EPSG coordinate reference systems for the site context.

### RV-M8 — Motion (closes G20, G21)

- Keyframes on placement, camera and light properties: `add_keyframe`, `render_animation source=keyframes`.
- `scatter_on_surface` for dressing a site (deterministic from a seed).

Order: M1 → M2 → M3 give the first realistic image; M4 and M6 follow; M5, M7, M8 are independent.

## 6. Owner decision (2026-11-27)

Asked whether a second, photo-realistic renderer is wanted beside the deterministic `render_view`, the owner answered **"Yes, plan
it"**. RV-M3 is therefore in scope as planned work: a new command `render_realistic`, `render_view` unchanged. Spec 09 is amended
to say so. Order stays M1 (appearance data) → M2 (lights, cameras, environment) → M3; nothing is built yet.

## 7. Validation layers

Every milestone ships with its layer-0 to layer-2 tests in the same change; layers 3 to 6 are gates like `npm run quality`.

| Layer                          | What it proves                                                  | How                                                                                                                                                                                     | Pass criterion                                                                                                            |
| ------------------------------ | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| V0 Contract                    | commands are pure, schemas derive, refusals named               | unit + contract suites, coverage gate                                                                                                                                                   | as `npm run check:coverage`                                                                                               |
| V1 Physics                     | the integrator and materials conserve energy and are reciprocal | white furnace test (a closed white box must return radiance 1); BSDF reciprocity and energy checks over sampled directions; a Lambert plane under a uniform sky against the closed form | furnace within 0.5 %; no BSDF sample above 1 in albedo; closed form within 1 %                                            |
| V2 Convergence and determinism | noise falls as it should and results are repeatable             | error against a 65 536-sample reference at 16, 64, 256, 1024 samples; same seed twice on the CPU path                                                                                   | slope of log error against log samples within -0.5 ± 0.05; identical image hash for a fixed seed on CPU                   |
| V3 Reference scenes            | the picture agrees with an independent renderer                 | a pinned corpus (Cornell box with published values, Khronos glTF sample models, one plant scene) rendered by Cycles once, images stored by sha256 like the quality corpus               | per-scene mean relative error and a perceptual metric (FLIP) under thresholds set at first measurement, then only lowered |
| V4 Scale and time              | big scenes stay usable                                          | PERF1 scenarios: 1,000,000 instances, 4 GB of textures refused cleanly, time to first image, memory ceiling                                                                             | budgets in `server/tests/perf/budgets.ts`, lowered only                                                                   |
| V5 Exchange                    | files other tools accept                                        | `usdchecker` on exported USD; glTF validator on exports; import the Khronos sample models and compare material values; round trip keeps instances, hierarchy and appearance             | zero validator errors; round-trip equality on the listed properties                                                       |
| V6 Job                         | an office can issue the deliverable                             | a production scenario: "issue six rendered views and a turntable of the plant model with its appearance library", graded on the files                                                   | new scenario in `tests/production`, ratchet as the others                                                                 |
| V7 Human                       | it looks right on real hardware                                 | checklist on a real GPU: shadows, impostor transitions, environment, a rendered image next to the Cycles reference                                                                      | signed off by a person, recorded in the spec                                                                              |

Negative tests are part of every layer: over-budget textures, a scene with no light, a non-manifold mesh, a missing texture file and
a non-finite camera must each refuse with a named code and leave the document unchanged.

## 8. What this does not buy

- Realism also needs authored content. A path tracer without textures and a good environment gives clean but plain images.
- A rendered picture is never a reference for a measurement; every `render_realistic` output is marked "illustration".
- A live digital twin (M7) is a product line of its own; it is scoped here to local sources only.

## 9. Sources

- Blender manual, Cycles sampling: https://docs.blender.org/manual/en/4.3/render/cycles/render_settings/sampling.html
- Blender 4.2 release notes, EEVEE: https://developer.blender.org/docs/release_notes/4.2/eevee
- Blender manual, Color Management: https://docs.blender.org/manual/en/4.5/render/color_management.html
- Blender manual, Geometry Nodes instances: https://docs.blender.org/manual/en/4.5/modeling/geometry_nodes/instances.html
- Blender issue 113771, per-object overhead in the draw module: https://projects.blender.org/blender/blender/issues/113771
- Blender issue 111459, nested instances and render memory: https://projects.blender.org/blender/blender/issues/111459
- Blender manual, Library Overrides: https://docs.blender.org/manual/en/4.5/files/linked_libraries/library_overrides.html
- Blender manual, Universal Scene Description: https://docs.blender.org/manual/en/5.1/files/import_export/usd.html
- IFC and OpenUSD maturity: https://venturebeat.com/virtual/how-nvidias-omniverse-could-unlock-construction-innovation-with-ifc
- Mesh against B-rep (community, anecdotal): https://www.tripo3d.ai/blog/explore/is-blender-a-cad-program
