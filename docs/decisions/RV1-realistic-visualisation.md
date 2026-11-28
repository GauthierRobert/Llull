# RV1 — Realistic visualisation and large scenes: the gap to Blender (2026-11-27)

**Status:** RV-M1 and RV-M2 built (2026-11-28, §5a as built); RV-M3 to RV-M8 planned (owner decision of §6, 2026-11-27). Written at the owner's request ("why does Blender succeed with big, very realistic 3D models and digital
twins, what are we missing; evaluate the gap, verify it against what we have, write the specs and the validation layers").

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

### 5a. As built: RV-M1 and RV-M2 (2026-11-28)

- Model: `model/appearance.ts` (`TextureRecord`, `Appearance` channels value / texture, `SceneEnvironment`, `CadDocument.appearance`),
  `model/sceneKinds.ts` (`light`, `camera` kinds; no geometry, `is3D` false), `MeshData.uvs` / `normals`, `Material.appearance`,
  `BaseEntity.appearance` (visual-only override; mass keeps `materialId`).
- Commands (`commands/appearance/`, toolset materials): `import_texture` (PNG / JPEG / Radiance .hdr; `file=` → image asset store key,
  or inline base64 up to 1 MiB), `set_material_appearance`, `apply_appearance` (offline library: steel, stainless, galvanised, painted,
  concrete, insulation_cladding, glass, rubber, copper, brass), `clear_entity_appearance`, `remove_texture`, `list_appearances`,
  `set_environment` (sky / hdr / color / default). Limits: side 8192 px, 1 GiB decoded per document; refusals `TEXTURE_TOO_LARGE`,
  `TEXTURE_BUDGET_EXCEEDED`, `TEXTURE_FORMAT_UNSUPPORTED`, `TEXTURE_ASSET_UNAVAILABLE`, `TEXTURE_COLOR_SPACE` (srgb for colour
  channels, linear for data maps, hdr only for the environment), `TEXTURE_IN_USE`.
- Commands (`commands/scene/`): `add_light` (sun / point / spot / area; without an intensity a light gives the default sun's
  3 W/m2 at its target), `add_camera`, `edit_light`, `edit_camera` (`set_camera` stays the viewport orbit), `render_view camera=<id>`
  (perspective through a camera entity). Lights do not change `render_view` shading: they feed the viewport and RV-M3.
- Host: `server/src/imageAssets/store.ts` (`LLULL_IMAGE_CACHE`), `GET /assets/image/<key>` for the renderer; the renderer runs without
  the store, so a `fileKey` import resyncs from the snapshot (sync rule).
- Viewport: physical materials with textures (stored or box-projected UVs), light glyphs + three.js lights (no light entity = the scene
  as before), camera frusta with "Look through camera", colour / sky / HDR environment.
- Left for later milestones: HDR backdrop through the post-processing chain and the real-GPU gate (RV-M4); glTF `KHR_lights_punctual`
  and camera export (RV-M6); OBJ `vt` / `vn` import (the importer welds vertices).

### RV-M3 — Path-traced render (closes G1 to G5, G12 to G14)

- New crate `solver/crates/llull-pathtrace` (Rust, wgpu compute with a CPU reference path), reached through its own host port (as
  built: CPU only, own SAH BVH; §5c). Instances traced without expansion.
- Command `render_realistic` (a new command; `render_view` stays the deterministic technical raster, so spec 09 keeps its promise
  for that command).
- Params: camera or viewpoint, size up to 8192 px (tiled), samples or target noise, bounces, denoise on / off, seed.
- Unidirectional path tracing with next-event estimation and multiple importance sampling; a GGX metal-roughness BSDF with coat and
  transmission; environment importance sampling.
- Output in scene-linear: OpenEXR and tone-mapped PNG (AgX-like view transform, documented curve).
- The result records sample count, seed, device and `deterministic: true | false` (PERF1 rule 4: no silent trade).
- Denoiser: a bundled open model run locally; off by default for reference renders. (As built: the à-trous filter; a learned model
  is optional later work, §5c.)

### 5b. RV-M3 wire contract (2026-11-28, fixed before the build)

`render_realistic` (core, `commands/render/realistic/`) builds a `PathTraceScene` and hands it to `ctx.pathTrace` (a `PathTracePort`,
synchronous like `ctx.raster`). The host port (`server/src/native/pathTracePort.ts`) writes one job folder and runs
`llull-compute pathtrace <folder>` (crate `solver/crates/llull-pathtrace`). Without the port the command refuses `NATIVE_TOOL_MISSING`.

Conventions: world = document frame, +Z up, lengths in document units; `unitMetres` converts them for light falloff. Colours are
scene-linear Rec.709 (TS converts `#rrggbb` sRGB to linear). Radiance unit: W / (m² sr); the default site sun is 3 W/m², so a white
Lambert plane facing it shows radiance 3/π ≈ 0.95 and exposure 0 EV maps radiance 1 near white.

Job folder:

- `job.json`: `{ kind: "pathtrace", version: 1, width, height (1..8192), samples (1..65536), targetNoise (null or relative error;
sampling stops early per tile once reached), maxBounces (0..64), seed (u32), denoise, engine ("cpu" | "gpu"), exr, png,
exposure (EV), maxSeconds, unitMetres, camera, meshes, materials, instanceCount, textures, lights, environment }`.
- `camera`: `{ position, forward, up (unit vec3), projection: "perspective" | "orthographic", fovY (radians, vertical),
orthoHeight (document units), apertureRadius (document units, 0 = pinhole), focusDistance (document units) }`.
- `meshes[i]`: `{ vertexOffset, vertexCount, indexOffset, indexCount }` into `positions.f32` (xyz), `normals.f32` (xyz, unit),
  `uvs.f32` (uv; always present, box-projected by TS where none are stored), `indices.u32` (mesh-local vertex indices).
- `instances.f64`: `instanceCount` rows of 14 little-endian f64: meshIndex, materialIndex, then the 3x4 local-to-world affine row-major
  (r00 r01 r02 tx r10 … tz; scale included). Instances are traced without expanding the mesh (two-level BVH).
- `materials[i]`: `{ baseColor [r,g,b], baseColorTexture, metalness, metalnessTexture, roughness, roughnessTexture, normalTexture,
normalScale, emission [r,g,b] (radiance, strength multiplied in), emissionTexture, transmission, transmissionTexture, ior, coat,
coatTexture, coatRoughness }`; each `*Texture` is a `textures` index or null (texture value × factor, glTF style; metalness and
  roughness read their own map's first channel).
- `textures[i]`: `{ file: "tex-<i>.<png|jpg|hdr>", format: "png" | "jpeg" | "hdr", colorSpace: "srgb" | "linear" }`; sampled bilinear,
  repeat wrap, image row 0 at v = 1.
- `lights[]`: `{ type: "sun", direction (unit, toward the sun), irradiance [rgb] W/m², angularRadius }` ·
  `{ type: "point", position, power [rgb] W, radius }` · `{ type: "spot", position, direction (aim), power, radius, coneAngle (full),
blend }` · `{ type: "area", position (centre), uAxis, vAxis (full edge vectors), normal (emitting side), power }`; each with
  `castShadows`. Point power P gives intensity P/(4π) W/sr; an area light radiance P/(π A), A in m².
- `environment`: `{ type: "sky", turbidity, intensity, sunDirection }` (Preetham, scaled so its mean upper-hemisphere radiance is
  0.3 × intensity) · `{ type: "hdr", texture, rotation, intensity }` · `{ type: "color", color, intensity }` (uniform radiance
  color × intensity) · `{ type: "default" }` (uniform radiance 0.3, the reference raster's ambient). HDR lookup: world direction d
  turned by -rotation about +Z to (x, y, z); u = 0.5 + atan2(-y, x) / 2π, v = 0.5 + asin(z) / π (the viewport's orientation).

Outputs: `image.png` (8-bit sRGB after exposure and the AgX-like view transform, opaque), `beauty.exr` (scene-linear RGBA half, the
denoised beauty when `denoise`), `stats.json` `{ samples (mean per pixel), seed, device, deterministic, elapsedMs, noise, denoised,
triangles, instances, stoppedBy: "samples" | "noise" | "time" }`. `deterministic` is true only on the CPU path with no time stop.

### 5c. As built: RV-M3 and RV-M4 (2026-11-28)

RV-M3, command (`commands/render/realistic/`, toolset render): `render_realistic` builds the §5b scene. It includes every visible solid,
NURBS sheet and instance-array member. Identical solids, component children and array members share one mesh placed by instance rows;
nested instances pass their material / appearance on, and an array member without a material takes the array colour, as the viewport
draws it. Appearance is the entity override over the material, with textures read from `ctx.imageAssets`. Lights are the light entities,
else one 3 W/m² sun (site sun or the reference key light). The environment comes from `set_environment`; absent, a site context gives
the Preetham site sky, else uniform 0.3. The camera is a camera entity (with depth of field from `fStop`), a viewpoint, or a named /
custom view framed on the drawn geometry (perspective by default). An optional ground plane (albedo 0.18) is added.
Guards: 8,000,000 placed parts, 50,000,000 unique triangles (`RENDER_SCENE_TOO_LARGE`, checked before a buffer grows). Refusals:
`NATIVE_TOOL_MISSING`, `RENDER_SCENE_EMPTY`, `RENDER_NO_LIGHT`, `TEXTURE_ASSET_UNAVAILABLE`, the camera codes of render_view,
`RENDER_CAMERA_INVALID`, and the native job's own codes. Output: `data.files` render.png and render.exr; an EXR over 160 MiB goes to
the host export sink (`data.file`) or is left out with `RENDER_EXR_NOT_RETURNED`. Every result is marked `illustration: true`.
CLI `--save out.png | out.exr | dir/`.

RV-M3, native (`solver/crates/llull-pathtrace`, job `llull-compute pathtrace`, host port `server/src/native/pathTracePort.ts`). It
departs from §5 / §5b in these places:

- **BVH:** its own binned-SAH two-level BVH (a BLAS per mesh, a TLAS over instances). `llull-bvh` is a closest-point tree, unsuited to
  rays.
- **Diffuse weight:** (1 − F(cos i))(1 − F(cos o)), reciprocal and energy-conserving; the glTF (1 − F(wo·h)) gained ~1 % at
  grazing angles. Schlick f90 = min(1, 50 f0); transmission uses exact dielectric Fresnel, including total internal reflection.
- **Conventions fixed by the crate:**
  - **Bounces:** `maxBounces` counts scattering events (1 = direct light only).
  - **Pixel filter:** tent, radius 1 px.
  - **Sky:** baked to a 512 x 256 map without a sun disk (the sun light gives it); below the horizon it is 0.3 x the mirrored sky.
  - **Sun cone:** radiance E / (π sin² α).
  - **Spot light:** point-light normalisation with a smoothstep blend.
  - **Lights:** not seen by camera rays.
  - **Surfaces:** emission and the opaque lobes are two-sided.
  - **Unknown job fields:** ignored.
  - **`deterministic`:** means bit-identical on the same binary and platform.
- **Denoiser (decision 2026-11-28, amends §5):** the shipped denoiser is the edge-aware à-trous filter, guided by albedo / normal /
  depth and the per-pixel variance. It is deterministic, has no third-party binary, and is off by default; above 4096² pixels it is
  skipped with `PATHTRACE_DENOISE_SKIPPED`. The learned model of §5 is an optional later item, needing the owner's explicit go-ahead.
  The only offline source is Intel Open Image Denoise 1.4.3 (Apache-2.0): a prebuilt Linux library in PyPI's `oidn` wheel, which
  would be loaded through unsafe FFI.
- **Emissive triangles:** every (instance, triangle) whose material has non-zero `emission` is a light.
  - **Choice:** by power (luminance of factor x emission-texture mean x world area), from an alias table.
  - **Sampling:** uniform on the triangle's area, converted to solid angle with |cos| (emission is two-sided); shadow-tested like the
    other lights.
  - **MIS:** combined with BSDF hits by the power heuristic, through an O(1) instance -> first-emitter lookup.
  - **Cap:** 1,000,000 emissive triangles (`MAX_EMITTERS`); above it, emission is hit-only with warning `PATHTRACE_EMITTER_LIMIT`.
  - **Determinism:** unchanged on the CPU; scenes without emitters keep their random streams.
  - **Measured:** a 0.1 x 0.1 emitter at 16 spp gives RMSE 0.0018 with NEE against 0.6832 hit-only (GPU 0.0020 on lavapipe).
- **GPU** (crate feature `gpu`, in `llull-compute --features gpu`; `src/gpu/`): `engine: "gpu"` renders on wgpu compute. It uses the
  CPU's own BLAS / TLAS flattened into storage buffers, textures in a storage-buffer atlas (no binding limits), and a line-by-line WGSL
  port of the BSDF, lights, emissive triangles (rows appended to `objects`), environments, NEE + MIS and camera; denoise / AgX / EXR stay on the CPU path. Rendering is progressive in
  256² tiles, with submissions sized to ~100 ms so no dispatch trips a driver timeout. `maxSeconds` and `targetNoise` behave as on the
  CPU. `device` is the adapter name and `deterministic` is false (32-bit sampler hash, GPU rounding). It falls back to the CPU with
  `fallbackReason` "<cause>; rendered on the CPU" and `PATHTRACE_GPU_FALLBACK` when: there is no adapter or `LLULL_GPU=off`; there are
  fewer than 7 storage buffers per stage; a buffer is over the device limits; the BVH is deeper than 62; or there is a device / shader
  error. Verified on lavapipe (software Vulkan): furnace within 1 %, per-channel means within 0.3 % of the CPU, RMSE ratio GPU/CPU
  0.95-1.10 at equal spp. 256² at 64 spp: llvmpipe 7.5-9.5 s vs CPU 2.7-3.6 s. A real-GPU measurement is part of the human gate.

Validation as built:

- **V0:** crate `tests/gpu.rs` (feature gpu, run on lavapipe); unit + contract suites (`tests/unit/render/renderRealistic*.test.ts`, server `pathTraceNative.test.ts` with native runs).
- **V1:** crate tests `physics.rs` and `bsdf.rs`:
  - Lambert / metal / coat furnaces within 0.5 %;
  - an emitting closed box;
  - Lambert plane under sky, sun, point and area lights against closed forms within 1 %;
  - an HDR furnace;
  - reciprocity, pdf consistency, and albedo ≤ 1 + 1 % over 200 parameter sets.
- **V2:** `convergence.rs` (slopes −0.48 to −0.51 against a 16,384-spp reference split into two independent halves, not 65,536) and
  `determinism.rs` (same seed, 1 / 3 / 4 threads give identical EXR hashes).
- **V3** (`npm run render:reference`, docs/QUALITY_GATES.md "Render reference gate"): 10 scenes rendered by Blender 4.0 Cycles from the
  same job folder (`quality/render/cycles_from_job.py`), pinned by sha256 in `quality/render-reference.json`, compared by a
  luminance-weighted relative error, bias and HDR-FLIP. Radiometry factors are all 1 (sun, point, spot, area within 0.02 %).
  - **Bugs found and fixed:**
    - the diffuse and coat weights lost ~9 % per bounce;
    - rough dielectrics were 9–16 % dark;
    - refraction ignored the base colour.
  - **Fixes:** diffuse / coat weighted by the GGX directional albedo E (`albedo.rs`, tabulated) as (1 − E(μi))(1 − E(μo)) / (1 − Ē);
    refraction tinted by √ρ per interface.
  - **Bias against Cycles:** Cornell −24 % → +4.3 %; material balls −14 % → +0.1 %; plant −15 % → +1.8 %; HDR balls −17.7 % → −2.2 %.
  - **Residual:** llull's reciprocal diffuse is ~5 % brighter than Cycles' (1 − E(μo)) under near-normal direct light
    (textured-lights +7.4 %).
  - **Thresholds:** re-baselined after the fix and only lowered from here.
- **V4** (`npm run perf`, `server/tests/perf/renderRealistic.gate.ts`):
  - first image at 256², 16 spp: 0.6 s (budget 1 s);
  - 1,000,000 array members at 256², 4 spp: 4.8 s, native peak 268 MiB, host growth 280 MiB;
  - 8,000,001 parts refused in 7 ms (array members counted before any is placed);
  - 4 GiB of textures: `TEXTURE_BUDGET_EXCEEDED`.
- **V6** (`tests/production`, scenario `plant-rendered-views`): six rendered views plus a 12-frame turntable (frames at 30° steps;
  `render_realistic` has no animation), graded on the files: 5 of 6 criteria. Known issue: `appearance-coverage` — building-plugin
  solids refuse `apply_appearance` / `assign_material` (derivation guard), so the appearance library does not reach the plant elements.
- **V7** (human, real GPU): deferred to the VIS-HUMAN queue (decision 2026-11-28), like the earlier viewport milestones. RV-M3 and
  RV-M4 are done pending that sign-off; the checklist is below.

Measured (4-core container, release):

- 256² at 64 spp, 10,242 triangles: 5.7 s.
- 8192² at 1 spp: 414 MB peak, 38 s.
- 4096² with the denoiser: 1.16 GB peak.

Host caveat (owner decision): the port is synchronous (§5b). In the desktop backend a long render blocks the backend event loop, and
with it live sync and `--app` commands, for up to `maxSeconds` plus five minutes. Prefer the CLI on a document file for long renders.
A worker-based backend execute is the fix if this matters.

RV-M4 (`src/ui/viewport/3d/instanceArray/`, effects chain):

- **HDR backdrop:** the HDR environment is the backdrop with the post-processing chain on. `HighQualityEffects` keeps a texture
  background, so it is tone-mapped with the scene; GTAO's normal / depth pass hides it.
- **Instance arrays:** members are drawn as InstancedMeshes per (child solid x LOD tier), straight from the packed table, with
  typed-array frustum / pixel culling and the `componentLod` thresholds.
  - Cap: at most 1,500,000 members drawn per array; the surplus is warned on the console.
  - Picking: reports `instanceMemberId(arrayId, index)`. A member cannot be selected yet (`set_selection` accepts entity ids
    only).
  - Not done: nested instances in an array component, and per-member hover or selection tint.
- **Real-GPU human gate (VIS-HUMAN, G24):** not run; no GPU or Electron in the build container. Record GPU, driver, resolution and
  quality tier. Checks:
  1. Plant-scale document (≥ 1,500 solids, site sun), quality High.
  2. Cascaded shadows: no seams, popping or acne while orbiting / dollying or moving the sun; ≥ 30 fps.
  3. Impostor / LOD transitions: no flicker at the hysteresis points; billboards right from every azimuth; nothing blinks out at the
     screen edge.
  4. HDR environment with edges + GTAO on: the backdrop shows the HDR and matches the lighting; rotation and intensity move both
     together. No grey look against a standard-tier render, and no halo at silhouettes. Switching back restores the palette.
  5. A ~4,000,000-member instance array: interactive orbit; right positions and colours; far members turn into boxes and then drop
     out; hiding the layer hides them; a click does not crash.
  6. `render_realistic` of the same view next to the viewport: same light direction, backdrop, colours and shadow placement.

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
