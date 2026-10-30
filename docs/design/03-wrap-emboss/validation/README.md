# WRP — Validation pack

Proves a future implementation of [FUNCTIONAL_SPEC.md](../FUNCTIONAL_SPEC.md) / [TECHNICAL_SPEC.md](../TECHNICAL_SPEC.md).
"Validated" = every grade-A `VC-WRP-*` below passes in an automated gate on the **desktop native kernel** (the core-only cases also
without a kernel), with reference data generated here by Node scripts (no npm dependencies) or pinned by URL + sha256.

## 1. Contents

| File                                         | What                                                                                                                                                                                                                                                                 | How produced                                                                                |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `generate_wrap_refs.mjs`                     | Cylinder wrap isometry, projection vs wrap, cone development, sphere geodesic-map distortion, emboss / deboss volumes (plane, cylinder, cone; Steiner formula, Pappus and quadrature checks), pull-direction walls, cylinder geodesics, knurl closure                | `node generate_wrap_refs.mjs`                                                               |
| `generate_font_refs.mjs`                     | Minimal TrueType reader (head, maxp, hhea, hmtx, OS/2, cmap 4 / 12, loca, glyf incl. composites): exact glyph areas (Green, quadratic closed form), contour / hole counts, outline lengths, advances; independent nonzero scanline fill as overlap check; text cases | `node generate_font_refs.mjs <path>/FiraSans-Regular.ttf` (font from [R24], sha256 checked) |
| `make_plans.mjs`                             | `build_project` plans (one baseline on today's commands, six targets)                                                                                                                                                                                                | `node make_plans.mjs`                                                                       |
| `generate_expected.mjs`                      | `expected_results.json` built from the datasets (one origin per number)                                                                                                                                                                                              | `node generate_expected.mjs`                                                                |
| `data/cylinder_wrap.json`                    | Chart lines at 0–90° and chart circles on r 20: 3D lengths, helix pitch, numeric residuals                                                                                                                                                                           | generator                                                                                   |
| `data/projection_vs_wrap.json`               | Projected arc 2r·asin(w/2r) vs wrapped length w; miss beyond 2r                                                                                                                                                                                                      | generator                                                                                   |
| `data/cone_development.json`                 | Cone r 20 h 40, frustum 30 → 15 h 40, 45° cone: sector angle, radii, area; isometry check                                                                                                                                                                            | generator                                                                                   |
| `data/sphere_geodesic_wrap.json`             | Exponential map on R 25: boundary lengths, strain, area ratio for chart disks 2–30                                                                                                                                                                                   | generator                                                                                   |
| `data/emboss_volumes.json`                   | Planar, cylinder (emboss / deboss / full band), cone (sector, full band) volumes                                                                                                                                                                                     | generator                                                                                   |
| `data/pull_and_geodesic.json`                | Pull-direction emboss volumes; cylinder geodesic lengths                                                                                                                                                                                                             | generator                                                                                   |
| `data/knurl_cases.json`                      | Teeth closure N = πd/p, adjusted pitch / diameter                                                                                                                                                                                                                    | generator                                                                                   |
| `data/font_firasans_glyphs.json`             | 70 glyphs of the pinned Fira Sans Regular: areas, contours, holes, bbox, advance, fill check; font metrics, fsType                                                                                                                                                   | font generator                                                                              |
| `data/text_cases.json`                       | "LLULL", "WRAP", "O", "B8%", "Ag", "LLULL CAD 2026": area, loops, outline length, width, emboss volumes                                                                                                                                                              | font generator                                                                              |
| `plans/baseline_band_and_planar_emboss.json` | **Runs on today's llull**: full-band emboss as a union of cylinders r 20 / r 21, planar emboss by extrude + union, a painted decal                                                                                                                                   | `make_plans.mjs`                                                                            |
| `plans/target_*.json`                        | Same intents with the proposed commands (unbuilt commands below)                                                                                                                                                                                                     | `make_plans.mjs`                                                                            |
| `expected_results.json`                      | Every VC: value, tolerance, unit, source, grade, `proves`, `cli`, `unbuiltCommands`                                                                                                                                                                                  | `generate_expected.mjs`                                                                     |
| `sources.md`                                 | Every external source, how it was accessed, what was taken, grade                                                                                                                                                                                                    | —                                                                                           |

Regenerate everything:

```bash
cd docs/design/03-wrap-emboss/validation
# font (not committed: 457 KB; OFL allows redistribution but the pack stays small) — URL + sha256 in sources.md R24
mkdir -p data/reference/firasans && curl -sL -o data/reference/firasans/FiraSans-Regular.ttf \
  https://raw.githubusercontent.com/google/fonts/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/firasans/FiraSans-Regular.ttf
node generate_wrap_refs.mjs && node generate_font_refs.mjs && node make_plans.mjs && node generate_expected.mjs
```

Commands named in the plans that **do not exist yet**: `import_font`, `text_outline`, `emboss_on_face`, `wrap_to_face`,
`project_to_face`, `unwrap_face`, `check_wrap` (plans); also specified but not used by a plan: `split_face_by_curves`,
`create_curve_on_face`, `list_fonts`, `explode_text`, `add_knurl`, `pattern_on_face`. New params on existing commands:
`add_text.font` (+ layout fields), `add_decal.font` / `add_decal.mapping`. Everything else in the plans exists today
(`set_units`, `add_cylinder`, `add_cone`, `add_sphere`, `add_box`, `boolean`, `mass_properties`, `draw_rectangle`, `draw_polyline`,
`draw_arc`, `extrude_profile`, `add_decal`, `add_text`, `create_sketch_plane`, `place_on_sketch_plane`, `inspect_faces`,
`render_view`).

## 2. Real use cases

| #   | Use case                                                           | Benchmark                                                                      | Benefit                                                                                                         | VCs                |
| --- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | ------------------ |
| UC1 | **Brand / label raised on a bottle or a cylindrical housing**      | SOLIDWORKS Wrap emboss [R1], Fusion Emboss of text [R4], Onshape Wrap Add [R5] | Real geometry for printing / moulding instead of a decal; exact text area → volume known before the kernel runs | 10, 13, 14, 18, 35 |
| UC2 | **Engraved serial / part number on a shaft**                       | SOLIDWORKS Deboss, Onshape Remove [R1] [R5]                                    | Depth guard against cutting through; minimum stroke width check                                                 | 10, 14, 28, 30     |
| UC3 | **Scale or label band on a cone; flat label outline for printing** | Creo Wrap datum curve [R13]; Rhino UnrollSrf [R9]                              | Lengths kept on the cone; developed outline with sector angle for the printer                                   | 06, 07, 16         |
| UC4 | **Logo on a doubly curved grip or dome**                           | SOLIDWORKS Spline Surface wrap [R2]; Rhino FlowAlongSrf [R6]                   | The stretch is a number with a limit, not a surprise                                                            | 08, 09, 27, 28     |
| UC5 | **Split line for a paint mask or a parting line**                  | SOLIDWORKS Scribe, Onshape Split [R1] [R5]; Rhino Project [R8]                 | Faces that later commands (colour, draft, PMI) can address                                                      | 05, 11, 16, 17     |
| UC6 | **Knurled knob / thumb screw**                                     | (cosmetic thread practice)                                                     | Tooth count that closes; drawing note                                                                           | 24, 39             |

## 3. Validation cases

Values and tolerances: `expected_results.json` (authoritative). Every case runs as a CLI script (AF-23): `cli.run` is the call
sequence (`--doc t.llull.json --json`, native kernel), `cli.assert` the JSON path compared with the value; exit codes are checked.
Grades: **A** closed form derived and numerically cross-checked here, or quoted from a primary source; **B** one secondary / partly
measured; **C** TBD. Only grade A gates.

| VC        | Proves        | Setup                                                        | Expected                                                                                                        | Tol          | Source / derivation            | Grade |
| --------- | ------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------ | ----- |
| VC-WRP-01 | FR-01, 41     | chart line L 30 at 0/30/45/60/90° on cylinder r 20           | 3D length 30; angular span 1.5 / 1.29904 / 1.06066 / 0.75 / 0 rad; helix pitch 2πr·tanβ                         | 1e-6 rel     | isometry, `cylinder_wrap.json` | A     |
| VC-WRP-02 | FR-01         | chart circles a 4 / 8 / 15                                   | 25.1327412 / 50.2654825 / 94.2477796; areas πa²                                                                 | 1e-6 rel     | isometry                       | A     |
| VC-WRP-03 | FR-06, 42     | chart width 130 > 125.6637061                                | `WRP_WRAP_OVERLAP`                                                                                              | exact        | 2πr                            | A     |
| VC-WRP-04 | FR-06, 10     | full band 2πr × 10, depth 1 (crosses the seam)               | Δ = 410π = 1288.05299 mm³; baseline union 16410π = 51553.5354 mm³                                               | 1e-6 rel     | annulus = A d (1 + d/2r)       | A     |
| VC-WRP-05 | FR-02, 41     | 30 mm chord projected along −x vs wrapped                    | 33.9224832 vs 30; 45 mm → `WRP_PROJECTION_MISSES_FACE`                                                          | 1e-6 rel     | 2r·asin(w/2r)                  | A     |
| VC-WRP-06 | FR-05         | `unwrap_face` on add_cone r 20 h 40                          | sector 2.80992589 rad, outer radius 44.7213595, area 2809.92589 mm²                                             | 1e-9 rel     | 2π sin α, r/sin α, πrL         | A     |
| VC-WRP-07 | FR-01         | segment 20 along the generator, ring r 4 on the cone         | 20 and 25.1327412                                                                                               | 1e-6 rel     | development isometry           | A     |
| VC-WRP-08 | FR-03, 41     | geodesic disk a 10 on sphere R 25                            | boundary 61.1696902; strain −0.0264541; area ratio 0.9867376                                                    | 1e-6         | exponential map                | A     |
| VC-WRP-09 | FR-03, 05, 42 | method develop on a sphere                                   | `WRP_FACE_NOT_DEVELOPABLE`                                                                                      | exact        | K = 1/R²                       | A     |
| VC-WRP-10 | FR-10         | rectangle 30 × 10, depth 1 on r 20                           | Δ +307.5 / −292.5 mm³                                                                                           | 1e-6 rel     | A d (1 ± d/2r)                 | A     |
| VC-WRP-11 | FR-10         | planar rectangle 30 × 10 × 1 on a 60 × 40 × 10 plate (today) | 24300 mm³                                                                                                       | 1e-9 rel     | A d                            | A     |
| VC-WRP-12 | FR-10         | cone sector 0.5 rad, slant 15..35, depth 1; full band        | 260; 1461.16146 mm³                                                                                             | 1e-6 rel     | Steiner + Pappus + quadrature  | A     |
| VC-WRP-13 | FR-20, 22     | `text_outline` "LLULL", Fira Sans, cap 10 mm                 | area 104.8862209 mm², 5 loops, outline 171.25892 mm                                                             | 1e-9 rel     | exact Green area               | A     |
| VC-WRP-14 | FR-10, 22     | "LLULL" embossed 1 mm on r 20                                | Δ 107.5083764 mm³ (deboss −102.2640654)                                                                         | 1e-5 rel     | A d (1 ± d/2r)                 | A     |
| VC-WRP-15 | FR-20         | glyph topology / areas                                       | O 2/1, B 3/2, 8 3/2, % 5/2, A 2/1, g 2/1, L 1/0 (contours / holes) + areas                                      | 1e-9 rel     | `font_firasans_glyphs.json`    | A     |
| VC-WRP-16 | FR-11         | scribe ring on the cone                                      | faces +1, volume unchanged                                                                                      | exact / 1e-9 | split, no material             | A     |
| VC-WRP-17 | FR-12         | `split_face_by_curves` with a projected closed curve         | faces +1, Σ areas = original                                                                                    | 1e-6 rel     | additivity                     | A     |
| VC-WRP-18 | FR-16, 45     | edit "LLULL" → "WRAP"                                        | Δ 140.8783659 mm³; replay identical                                                                             | 1e-5 rel     | `text_cases.json`              | A     |
| VC-WRP-19 | FR-21, 45     | reopen a document without the font file                      | identical area / geometry                                                                                       | exact        | embedded blob                  | A     |
| VC-WRP-20 | FR-21, 42     | font with fsType 2 (patched fixture)                         | `WRP_FONT_EMBEDDING_RESTRICTED`                                                                                 | exact        | OpenType OS/2 [R20]            | A     |
| VC-WRP-21 | FR-25         | unmapped character                                           | warning `WRP_GLYPH_MISSING`                                                                                     | exact        | cmap check on first run        | B     |
| VC-WRP-22 | FR-24         | single-line font engrave                                     | stroke count / length TBD                                                                                       | —            | Relief SingleLine [R25]        | C     |
| VC-WRP-23 | FR-30         | decal width 30 on r 20, mapping wrap                         | 1.5 rad (projection 1.6961242 rad)                                                                              | 1e-3         | isometry vs projection         | A     |
| VC-WRP-24 | FR-31         | knurl d 20, p 1.0                                            | 63 teeth, pitch 0.997331001, warning                                                                            | 1e-9 rel     | N p = πd                       | A     |
| VC-WRP-25 | FR-13         | rectangle 30 × 10 on r 20, pull +x, d 0.5 / 1 / 2            | 149.562188 / 298.308583 / 593.663229 mm³                                                                        | 1e-6 rel     | circular-segment integral      | A     |
| VC-WRP-26 | FR-13         | emboss / deboss with draft: 20 x 10 plane, d 2, 10 degrees   | 379.1724 mm3 (w l d - (w + l) t d2 + 4/3 t2 d3); cylinder 318.07 / 277.22 | 1e-6 rel (cyl 1e-4) | A(h) integral | A     |
| VC-WRP-27 | FR-03, 14     | B-spline face wraps                                          | golden on first run                                                                                             | —            | —                              | C     |
| VC-WRP-28 | FR-40, 43     | disk a 20 / a 10 on R 25 vs limit 0.05                       | fail `WRP_CHECK_DISTORTION` (−0.1033) / pass (−0.0265)                                                          | 1e-6         | `sphere_geodesic_wrap.json`    | A     |
| VC-WRP-29 | FR-43, 44, 51 | `check_wrap` with no limits; unverified font                 | `defaulted: true` + source; `unverified` propagates; provenance                                                 | exact        | AF-31/32/35                    | A     |
| VC-WRP-30 | FR-42, 46     | `plans/target_bad_inputs.json`                               | `WRP_WRAP_OVERLAP`, `WRP_PROFILE_OPEN`, `WRP_FACE_NOT_DEVELOPABLE`, `WRP_DEPTH_EXCEEDS_SOLID`, `WRP_FONT_PARSE` | exact        | TECHNICAL_SPEC §7.1            | A     |
| VC-WRP-31 | FR-41, 47     | `llull describe` / result audit of WRP commands              | 0 unit-less numbers                                                                                             | exact        | AF-04, AF-10                   | A     |
| VC-WRP-32 | FR-48         | STEP round trip of the embossed cylinder                     | exact faces, volume change 0                                                                                    | 1e-6 rel     | —                              | A     |
| VC-WRP-33 | FR-49         | no exact kernel                                              | face commands `CMD_KERNEL_UNAVAILABLE`; `text_outline` 104.886 mm²                                              | exact        | L9                             | A     |
| VC-WRP-34 | FR-50         | 100-character emboss                                         | ≤ 3 s, TBD measured                                                                                             | —            | —                              | C     |
| VC-WRP-35 | FR-22         | `extrude_profile` of font text, depth 2                      | 209.7724418 mm³                                                                                                 | 1e-6 rel     | A d                            | A     |
| VC-WRP-36 | FR-15         | multi-face wrap: stadium, 6 x 30 band, plane + tangent cylinder end | 186 / 369.4248 mm3 (3 faces); wrap lengths 10 + 30 | 1e-6 rel | A d (1 + d / 2r) per face | A     |
| VC-WRP-37 | FR-04         | geodesics on r 20: (1 rad, 10), (0.5, 0), (2, 5)             | 22.3606798 / 10 / 40.3112887                                                                                    | 1e-6 rel     | chart lines                    | A     |
| VC-WRP-38 | FR-33         | `pattern_on_face` 12 × 3                                     | 36 instances; spacing TBD                                                                                       | —            | —                              | C     |
| VC-WRP-39 | FR-32         | modeled knurl                                                | TBD (groove profile from 02 SWG)                                                                                | —            | —                              | C     |
| VC-WRP-40 | FR-23         | "LLULL CAD 2026" width                                       | 51.1030479 mm without kerning; with kerning TBD (HarfBuzz)                                                      | 1e-6 rel     | hmtx advances                  | B     |

FR ↔ VC coverage: FR-01 (01, 02, 07) · FR-02 (05) · FR-03 (08, 09, 27) · FR-04 (37) · FR-05 (06, 09) · FR-06 (03, 04) ·
FR-10 (04, 10, 11, 12, 14) · FR-11 (16) · FR-12 (17) · FR-13 (25, 26) · FR-14 (27) · FR-15 (36) · FR-16 (18) · FR-20 (13, 15) ·
FR-21 (19, 20) · FR-22 (13, 14, 35) · FR-23 (40) · FR-24 (22) · FR-25 (21) · FR-30 (23) · FR-31 (24) · FR-32 (39) · FR-33 (38) ·
FR-40 (28) · FR-41 (01, 05, 08, 31) · FR-42 (03, 09, 20, 30) · FR-43 (28, 29) · FR-44 (29) · FR-45 (18, 19) · FR-46 (30) · FR-47 (31) ·
FR-48 (32) · FR-49 (33) · FR-50 (34) · FR-51 (29).

TR ↔ VC: TECHNICAL_SPEC §9.1; `expected_results.json` lists the TR ids per case in `proves`.

## 4. Findings from the reference scripts (measured 2026-10-22)

1. **Projection is the wrong default for text on a cylinder.** A 30 mm chord projected onto r 20 lands on a 33.92 mm arc (+13.1 %),
   a 38 mm chord on 50.13 mm (+31.9 %), and anything wider than 40 mm misses the face (`projection_vs_wrap.json`). Wrap keeps 30 mm.
   That is why `emboss_on_face` defaults to `method: "develop"` on K = 0 faces and `add_decal` gains `mapping: "wrap"`.
2. **Emboss volume on a cylinder is not A·d.** The Steiner factor (1 ± d/2r) is +2.5 % for d 1 on r 20; on the cone the correction is
   (d²/2)·cot α per chart radian per slant length (`emboss_volumes.json`). The datasets give the agent the exact expectation.
3. **Pull-direction walls remove ~3 % of the emboss** for a 30 mm wide region on r 20 (298.31 vs 307.5 mm³ at d 1), because the side
   walls are parallel planes instead of radial ones (`pull_and_geodesic.json`).
4. **On a sphere, distortion is unavoidable and grows fast**: chart disk a 10 on R 25 has −2.6 % circumferential strain, a 20 has
   −10.3 %, a 30 has −22.3 % (`sphere_geodesic_wrap.json`). A 2 % default limit admits a disk of ≈ 0.35 R on a sphere.
5. **The pinned Fira Sans Regular has no overlapping contours** in the 70 measured glyphs: exact Green area and an independent nonzero
   scanline fill agree within 1.8e-4 relative (the scanline's own discretisation error), so "sum of signed contour areas" is valid for
   this font. Variable-font instances are not guaranteed to behave like this (OpenType: "Variable fonts often make use of overlapping
   contours" [R19]) — the union step of TR-WRP-07 stays mandatory.
6. Fira Sans Regular: unitsPerEm 1000, cap height 689, x-height 527, fsType 0 (installable embedding), 2708 glyphs. At cap 10 mm,
   "LLULL" covers 104.886 mm² and advances 38.52 mm (1.926 rad on r 20: it fits around).
7. **Baseline** (`plans/baseline_band_and_planar_emboss.json`) runs on today's commands and must give 16410π = 51553.5354 mm³ and
   24300 mm³ — **measured 2026-10-22** on the native kernel (`llull run … --continue`, 12/12 steps ok): 51 553.535 and 24 300.000 mm³ (exact B-rep), both equal to the closed forms.

## 5. How a future implementation runs this pack

- `tests/unit/wrap/surfaceChart.test.ts` iterates `data/cylinder_wrap.json`, `cone_development.json`, `sphere_geodesic_wrap.json`,
  `pull_and_geodesic.json` (core math, no kernel).
- `tests/unit/wrap/font.test.ts` loads the pinned Fira Sans Regular bundled in `server/fonts/` (sha256 `c29556a2…`) and compares with
  `font_firasans_glyphs.json` / `text_cases.json`; the restricted-licence fixture is the same file with OS/2 `fsType` patched to 2.
- `tests/golden/` imports `plans/target_*.json` once the commands exist (id-normalised snapshots + replay equality).
- `server/tests/nativeWrap.test.ts` checks volumes and lengths with the native kernel against the same JSON.
- The production-gate agent driver runs every `cli.run` in `expected_results.json`.
