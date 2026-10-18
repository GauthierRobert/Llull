# Gap 09 VIS — Sources

Accessed 2026-10-18.

What the authoring sandbox could reach:

- **Downloaded:** registry.npmjs.org and raw.githubusercontent.com.
- **Search-engine extracts only:** every other site in the table. These include Autodesk help, AVEVA docs, ISO,
  Wikipedia, vendor PDFs and law.resource.org. Direct fetch was refused with CONNECT 403, or WebFetch failed DNS
  resolution.
- **Search budget:** the session's web-search budget ran out before the Navisworks Clash Detective status list could
  be checked (see "Not verified").

Grades:

- **A**: primary source read, reference code read or run, or ≥ 2 independent extracts agree.
- **B**: one extract, or extracts that conflict.
- **C**: located, numbers not confirmed.

Only grade A values and closed forms derived from them gate pass / fail.

## Standards and colour schemes

| Id | Source | What was taken | How it was checked | Grade |
| -- | ------ | -------------- | ------------------ | ----- |
| S1 | J.J. Keller Compliance Network, "Pipe marking elements: format, color schemes and location" — https://jjkellercompliancenetwork.com/institute/pipe-marking-elements-format-color-schemes-and-location ; also "do compressed air pipes need to be marked or color coded" (same site) | ASME A13.1 categories and colour pairs: fire quenching white / red, toxic & corrosive black / orange, flammable black / yellow, combustible white / brown, water white / green, compressed air white / blue, user-defined white on purple / gray / black | search extract; agrees with S3 on every category | A (with S3) |
| S2 | Project Materials, "ASME A13.1 Pipe Color Code Chart" and "Pipe Color Codes: ASME A13.1, ISO 14726 & BS 1710" — https://blog.projectmaterials.com/quick-answers/pipes/asme-a13-1-pipe-color-code-chart/ | the same chart; **conflicts**: flammable on brown, white letters on orange and yellow | search extract; the conflict is recorded per row in `data/service_colour_schemes.json` | B |
| S3 | Brimar / pipemarker.com, "ANSI/ASME A13.1-2015" summary — https://www.pipemarker.com/help-asme.php ; Brady, "Pipe Labeling — ANSI Pipe Marking Standards" — https://www.bradyid.com/applications/pipemarking | 2015 categories with oxidizing added to yellow / black; user-defined pairs (Brady: purple / white, white / black, brown / white, black / white); GHS pictograms added in 2015 | two vendor extracts that agree with each other and with S1 | A |
| S4 | Mouser-hosted vendor datasheet citing ASME A13.1-2007 — https://www.mouser.com/datasheet/2/319/100944611-1671635.pdf | legend size table: OD 0.75–1.25 in → 8 in field, 0.5 in letters (and the following rows) | search extract | A (with S5) |
| S5 | Project Materials, "How to Label Pipes: Best Practices" — https://blog.projectmaterials.com/quick-answers/pipes/how-to-label-pipes/ ; pipemarker.com / safetysign.com marker charts | rows 1.5–2 → 8 in / 0.75 in; 2.5–6 → 12 in / 1.25 in; 8–10 → 24 in / 2.5 in; > 10 → 32 in / 3.5 in; OD includes covering | several vendor charts agree on letter heights; one chart (2.25–6 in, 1.3 in) reflects another edition | A (letters); B (lengths) |
| S6 | Brady Safety & Facility ID catalogue p. 342 — https://catalogs.bradyid.com/Safety-and-Facility-ID-Catalog/342/ | placement at valves, flanges, direction changes, both sides of penetrations; 25–50 ft intervals (2007); 5 in field for the smallest row (conflicts with S4 / S5) | search extract | B |
| S7 | Brimar, ASME guide (2023 edition text quoted) — https://www.pipemarker.com/asme-guide ; Safety Media installation instructions — https://safetymedia.com/content/pdf/Pipe%20Marker%20Installation%20Instructions_Safety%20Media.pdf | "Arrows shall be used to indicate direction of flow…both directions"; 25 ft (Brimar) vs 20–25 ft (Safety Media) | search extracts; spacing conflicts, so llull uses a named default | A (arrows); B (spacing) |
| S8 | ISO 14726:2008 text — https://law.resource.org/pub/us/cfr/ibr/inc/iso/iso.14726.2008.pdf and the iTeh sample https://cdn.standards.iteh.ai/samples/44744/ed36a8bbb25d40e1a011ea894b94b130/ISO-14726-2008.pdf ; catalogue https://www.iso.org/standard/44744.html | Table 2 main colours ↔ media (12 rows); Table B.1 RAL references: BK 9005, BU 5015, BN 8001, GN 6018, GY 7001, OG 2003, SR 9006, RD 3000, VT 4001, WH 9010, YE 1021; MN (maroon) RAL not visible in the extract; scope excludes medical and industrial gases and cargo; confirmed 2024 | search extracts of the standard's own text (PDF not reachable directly) | A (media, RAL listed); C (maroon RAL) |
| S9 | Creative Safety Supply glossary "ISO 14726" — https://www.creativesafetysupply.com/glossary/iso-14726/ ; A-SPE pipe-marking guide — https://a-spe.com/knowledge-base/pipe-marking-guide/ ; DIN ISO 14726 abstract (dinmedia.de) | the same media list; blue = RAL 5015, black = RAL 9005; main vs additional colour example (potable water blue-green-blue, condensate blue-yellow-blue) | independent extracts agree with S8 | A |
| S10 | Duralabel, "BS 1710 British Standard Pipe Marking" — https://resources.duralabel.com/articles/bs-1710-british-standard-pipe-marking | 8 basic colours with BS 4800 refs; safety colours red 04 E 53, yellow 08 E 51, auxiliary blue 18 E 53 | search extract; agrees with S11 | A |
| S11 | Wikipedia, "Pipe marking" — https://en.wikipedia.org/wiki/Pipe_marking ; Water Regulations UK leaflet "Pipe identification BS 1710" — https://www.waterregsuk.co.uk/downloads/publications/info_leaflets/pipe_identification_bs_1710.pdf | same BS 1710 table | search extract | A (with S10) |
| S12 | TRGS 201 Anhang 3, "Kennzeichnung von Rohrleitungen nach den Durchflussstoffen" — https://vorschriften.bgn-branchenwissen.de/daten/tr/trgs201/anh3.htm ; DIN 2403 catalogue — https://www.dinmedia.de/en/standard/din-2403/101722847 | group colours: water green, steam red, air grey, flammable gases yellow (+ red), acids orange, alkalis violet, oxygen blue; RAL 1012 replaced by RAL 1021 for yellow; edition status unclear (2014-06 referenced, 2018-10 withdrawn, 2024 draft withdrawn) | one extract | B |
| S13 | npm `ral-colors@1.0.1` (MIT, (c) 2022 Ibon Eskudero) — https://registry.npmjs.org/ral-colors/-/ral-colors-1.0.1.tgz | RAL classic name + HEX + rgb for 15 codes (`data/llull_display_palette.json`) | downloaded, sha256 6178d08092be36e910ec6f3cc8ff77a0a7fdb17feccac63f2afa08c26ad05a5b, 44 572 B; read with python `-I`; **HEX and rgb fields disagree for 14 of 15 codes** | C (display only) |
| S14 | ANSI blog, "ANSI Z535.1-2022 Safety Colors Standard" — https://blog.ansi.org/ansi-z535-1-2022-safety-colors-standard/ ; In Compliance Magazine July 2023 ; Adobe community thread on Z535.1 colours | Z535.1 defines safety red, orange, yellow, green, blue, purple, black, white with colorimetric tolerances; Annex C cross-references (Munsell, Pantone, CMYK, RGB formula); "most ANSI colours are out of gamut for sRGB" (forum, C) | search extracts | B (scope); C (gamut remark) |

## Rendering, review tools, formats

| Id | Source | What was taken | How it was checked | Grade |
| -- | ------ | -------------- | ------------------ | ----- |
| S15 | npm `three@0.186.1` (MIT) — https://registry.npmjs.org/three/-/three-0.186.1.tgz | facts T1–T7 in `data/threejs_r186_facts.json`: InstancedMesh per-instance bytes and culling, BatchedMesh textures / multi-draw / per-object culling, `WebGLInfo` call counting and the no-multi-draw fallback loop, `LOD.update` distance / zoom / hysteresis, `SceneOptimizer` batch key, `EdgesGeometry` threshold, available addons (GTAO, SSAO, CSM, Fly / FirstPerson / PointerLock controls, Line2) | tarball downloaded (sha256 8cd068708ea44f2c73c944b1cead2ba2f0d5c15c8fc194e5700f4e4f4a033fe7, 4 648 523 B); source files read, per-file sha256 recorded; version = the repo's `package-lock.json` | A |
| S16 | Autodesk Navisworks Help, "Display Page" (2016–2024) — https://help.autodesk.com/cloudhelp/2024/ENU/Navisworks/files/GUID-B470F105-8626-44FF-B531-8864FBD79CDA.htm ; "Adjust Scene Rendering During Navigation" — https://help.autodesk.com/cloudhelp/2020/ENU/Navisworks/files/GUID-1A87025C-F276-4978-847D-52CD63AF3F29.htm | Guarantee Frame Rate (on by default), Fill In Detail, drop-out by bbox size / distance / screen size, area culling < 1 × 1 px by default, near / far clipping, backface culling, CPU occlusion culling on, GPU off by default | several help versions agree (search extract) | A |
| S17 | Autodesk Navisworks Help, "Appearance Profiler" / "To Color-code Models by Property Values" / "…by Search and Selection Sets" — https://help.autodesk.com/cloudhelp/2020/ENU/Navisworks/files/GUID-37A831D3-AE33-45AE-9679-6A8610023E10.htm ; Arkance article "Navisworks: Using Appearance Profiler" | colour by property or set; selector order matters; saved to .dat; reset appearances | help + independent reseller article | A |
| S18 | Autodesk Navisworks Help, "Overview of Viewpoints" — https://help.autodesk.com/cloudhelp/2019/ENU/Navisworks/files/GUID-7FDFB8F2-B361-4234-B67B-263B8DC2D361.htm ; Navigate / realism page GUID-31D95B7F (2015–2021); Navisworks 2014 Quick Reference Guide (AU) | viewpoints, redlines and comments saved in NWF, independent of geometry; realism: collision, gravity, crouch, third person, saved with viewpoint; sectioning by planes or box; Redline, Tags, Comments tools | help pages + AU guide (search extracts) | A |
| S19 | Autodesk AutoCAD Plant 3D 2017 User Guide, layer / colour settings — https://help.autodesk.com/cloudhelp/2017/ENU/Plant3D-UserGuide/files/GUID-9E580DD7-22DC-488A-A081-00F0A74F595C.htm ; Arkance "New Service Layer Scheme in AutoCAD Plant 3D" ; Autodesk forum "Colour Coding Pipes" | layer by line number or service, colour by size; end-of-line equipment not following the scheme; custom services need a scheme update; custom fittings ByBlock issue (forum, C) | help + reseller article | A (schemes); C (forum) |
| S20 | AVEVA E3D Design documentation, auto colour rules — https://docs.aveva.com/bundle/e3d-design/page/945887.html (and pages 926196, 959675) | rule = selection criteria + colour; tested in order, first true rule wins; default when none; significant elements only; Dynamic Auto Colour re-evaluates on attribute change; colour numbers exported to Review | search extract of the official docs (JS-only site) | B |
| S21 | Hexagon docs (Smart Review / SmartPlant Markup Plus) — https://docs.hexagonppm.com/r/en-US/SmartPlant-Markup-Plus-Help/110466 ; Intergraph Smart Review product sheet | SmartPlant Review renamed Intergraph Smart Review; markup layers; clash as an optional module (secondary) | search extracts | C (context only) |
| S22 | buildingSMART BCF-XML, branch `release_3_0` — https://github.com/buildingSMART/BCF-XML/tree/release_3_0 (raw files downloaded) | `Schemas/visinfo.xsd`, `Schemas/markup.xsd`, `Documentation/README.md` (camera fields, metres / degrees, clipping-plane direction = invisible side, colouring ARGB and the 1000-component rule, one viewpoint per comment), the orthogonal-camera example viewpoint | downloaded and read; licence CC BY-ND 4.0, files kept **verbatim** in `data/bcf_3_0/` with the licence text | A |
| S23 | Khronos glTF-Sample-Assets, `Models/SimpleInstancing` and `Models/model-index.json` — https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/SimpleInstancing | 1 cube mesh, `EXT_mesh_gpu_instancing` TRANSLATION / ROTATION / SCALE accessors, 125 instances (5 × 5 × 5), translation 0..10, rotation 0..90°, scale 1..2 | downloaded; accessors read with python `-I` (counts 125, min / max match the README); model files CC0-1.0, metadata CC-BY-4.0. The index (150 models) has **no industrial-plant model** (only "DiffuseTransmissionPlant", a houseplant, and Sponza) | A |
| S24 | npm `three-mesh-bvh@0.9.16` (MIT, G. Johnson) — https://registry.npmjs.org/three-mesh-bvh/-/three-mesh-bvh-0.9.16.tgz | BatchedMesh BVH helpers, `ObjectBVH` (scene BVH, frustum-culling example, API "may change") | downloaded (sha256 114cd1686832f6dbfd10fc7f9789c3a68c6c6059ad7a14e2ead5c88c473c5e1c, 431 570 B); README read | A |
| S25 | npm `@react-three/drei@10.7.9` (MIT) — https://registry.npmjs.org/@react-three/drei/-/drei-10.7.9.tgz | `Detailed` (LOD distances + hysteresis), `PerformanceMonitor` API, `AdaptiveDpr`, `Instances`, `Bvh`, `Edges`, `Outlines`, `Environment`, `Sky` | downloaded (sha256 02316520c703a4f5513b6c1478602604ed2af905342af7ce1e8f3109a0ab2b0b, 473 422 B); `.d.ts` read | A |
| S26 | llull repository (this branch) | current state: `src/ui/viewport/3d/*`, `packages/core/src/commands/render/*`, `packages/core/src/model/{types,viewport}.ts`, `packages/domain-aec/src/industrial/{clash,evaluate,piping/pipeSizes}.ts`, `docs/QUALITY_GATES.md` | read | A |

## Downloaded files kept in `data/`

| File | Source | Size (B) | sha256 | Licence |
| ---- | ------ | -------- | ------ | ------- |
| `bcf_3_0/visinfo.xsd` | S22 | 9 785 | 0855bc002310b4a9decd67b1b21631bd2e0368f0878183da8448e34d807e7418 | CC BY-ND 4.0 (verbatim) |
| `bcf_3_0/markup.xsd` | S22 | 8 921 | 6c80f1c566ace8b405ae0ab530438aec2014bf35dd14cfc3c4cf0c5aa0b9d169 | CC BY-ND 4.0 (verbatim) |
| `bcf_3_0/BCF-XML-3.0-Documentation-README.md` | S22 | 32 500 | ed83f5311c68bb7f0d231abd86dc4c898ad24d5e48fe0db50aeaf4194e90c56f | CC BY-ND 4.0 (verbatim) |
| `bcf_3_0/example_viewpoint_orthogonal.bcfv` | S22 (the documentation's example block, extracted unchanged) | 1 141 | 7bfb0990e0a32633f1b879f52ebde775ecd657f64caffdce7ee459cfbde8294f | CC BY-ND 4.0 (verbatim excerpt) |
| `bcf_3_0/LICENSE-CC-BY-ND-4.0.txt` | S22 `LICENSE` | 229 | 692a4aeb135d527412ac7a395eae7fe093daa10a029abcd893a6b8facb3ee136 | — |
| `gltf_simple_instancing/SimpleInstancing.glb` | S23 | 7 356 | 1c9425627481346a8c226118f7000db7cd7f80198e9f54331f8b664d16726f3f | CC0-1.0 |
| `gltf_simple_instancing/SimpleInstancing.gltf` | S23 | 3 013 | a01695630e6459c945826c7ff8dde74784de8279f60b9b62604980dc7486340e | CC0-1.0 |
| `gltf_simple_instancing/SimpleInstancing.bin` | S23 | 5 720 | 29d38705c2a619f30374e80413be61f2e855dd9ec59c499201000aa53715a73c | CC0-1.0 |
| `gltf_simple_instancing/LICENSE.md` | S23 | 779 | bcf3b5efc3cffc3471dc2aafbd6ce3c2d91375976ef8c785d9b36e910615bb02 | CC-BY-4.0 (metadata) |

Not redistributed, kept only as hash and extracted facts:

- three 0.186.1, three-mesh-bvh 0.9.16 and drei 10.7.9 tarballs. They are MIT and could be redistributed, but are too
  large and not needed.
- ral-colors 1.0.1 (the 15 rows used are transcribed).
- `model-index.json` (sha256 91c2e5fb4e500e45011065bc7ff0b5ee357dbfc2c9a10e9bd85e944fe3c90ff4, 44 480 B).

## Transcribed / derived files

| File | Content | Basis |
| ---- | ------- | ----- |
| `service_colour_schemes.json` | ASME A13.1 colours + legend sizes + placement, ISO 14726, BS 1710, DIN 2403, with source ids, grades, conflicts | S1–S12 |
| `llull_display_palette.json` | display hex per named colour (RAL approximations), flagged approximate | S8 (RAL codes), S13 (hex) |
| `threejs_r186_facts.json` | T1–T9 with file / line references and file hashes | S15, S24, S25 |
| `synthetic_pipe_rack_benchmark.json` | SYN-RACK-v1 definition, counts, batching bound, LOD distances, GPU bytes, frame-time procedure | llull fixture; closed forms from S15 facts |
| `derive_vis_expected.py` | reproduces every derived number (python3 -I) | — |

## Not verified (never used as gates)

- **Navisworks Clash Detective statuses** (New / Active / Reviewed / Approved / Resolved). Known from memory only:
  the search budget was exhausted before a source could be read.
- **ASME A13.1 steam / hot-water category** (gray / black vs white / black) and the exact straight-run spacing.
- **ISO 14726 maroon (MN) RAL code.**
- **ANSI Z535.1 Munsell values.** None were confirmed. llull does not use them.
- **Any absolute frame time, BVH build time or render time.** All are "TBD — measure" with the procedure in
  `synthetic_pipe_rack_benchmark.json`.
- **Public industrial-plant glTF or IFC sample.** None was found in the Khronos index. Plant-scale tests use the
  synthetic SYN-RACK-v1 instead.
