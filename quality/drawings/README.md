# Drawing corpus — 21 parts rebuilt from 2D technical drawings

Each part was modelled in llull **from its published 2D drawing only** (plan:
`plans/<id>.json`, a `build_project` action list) and then checked against the real 3D part:
the drawing's official mass when the sheet asks for it (Too Tall Toby), and an independent
reference solid (build123d code by the drawing's publisher, or a third-party model) through an
exact 3D comparison (`.claude/skills/drawing-to-model/scripts/compare_meshes.py`). The method is
the `drawing-to-model` skill.

`npm run quality:drawings` replays every plan on the live OCC kernel and checks the exact B-rep
volume (`manifest.json` `volume` ± `volumeTolerance`) and the overall extents: any kernel or
command change that alters real geometry fails it. Drawings and reference solids are linked
(pinned commits), never committed: Too Tall Toby drawings "MAY be used, printed and distributed
for ANY educational purpose"; build123d (Apache-2.0).

## Results (exact B-rep volume; IoU = exact 3D intersection / union with the reference solid)

| Part | Mass (llull → official) | Volume vs ref | 3D IoU | Notes |
| ---- | ----------------------- | ------------- | ------ | ----- |
| PPP0101 bearing bracket | 797.15 → 797.15 g | 1.0000 | 0.998 | R6 corners via rounded-prism intersect |
| PPP0102 post cap | 43.09 → 43.09 g | 0.986 | 0.929 | **reference defect**: handle swept in the wrong plane |
| PPP0103 C clamp base | 96.13 → 96.13 g | 1.0000 | 0.998 | |
| PPP0104 angle bracket | 310.00 → 310.0 g | 1.0000 | 0.996 | concave R4 built as (disc − torus) ∩ box |
| PPP0105 paste sleeve | 56.73 → 57.08 g (±1) | 0.9999 | 0.996 | stadium lofts as two oblique cone-lofts ∪ prism ∩ prism |
| PPP0106 bearing jig | 328.02 → 328.02 g | 1.0000 | 0.997 | R6 boss fillet revolved by hand |
| PPP0107 flanged hub | 372.99 → 372.99 g | 1.013 | 0.983 | **reference defect**: its ribs are missing (its own mass assert fails) |
| PPP0108 tie plate | 3387.00 → 3387.06 g | 1.0000 | 0.999 | gusset start (44) read by pixels, settled by the mass |
| PPP0109 corner tie | 307.23 → 307.23 g | 1.0000 | 0.998 | 45° leg trimmed by a tilted prism |
| PPP0110 light cap | 211.30 → 211.30 g | 1.0000 | 0.996 | |
| 23-02-02 SM hanger | 1028.75 → 1028 g (±10) | 1.001 | 0.934 | **reference defects**: 16-wide lugs (drawing 26), 32° taper (drawing 26°) |
| 23-T-24 curved support | 1294.13 → 1294 g | 1.0000 | 0.997 | |
| 24-SPO-06 buffer stand | 3.923 → 3.923 lb | 1.0000 | 0.998 | inch drawing |
| 24-01-01 L bracket | — | 1.0000 | 0.9995 | |
| 24-01-02 bearing bracket | — | 0.992 | 0.968 | **reference defects**: one counterbore, sharp R6 corners, no x=55 flat |
| 24-01-03 mug cap | — | 1.0000 | 0.991 | handle arc radius solved from section A-A |
| 24-01-04 clamp base | — | 0.988 | 0.986 | reference has ~480 mm³ more, hidden in every view/section: unexplained |
| 24-04-02 plumb bob | — | 1.0000 | 0.996 | inch drawing |
| 24-04-04 cab handle | — | 1.0000 | 0.996 | rounded edges settled from the view diffs |
| build123d tutorial bracket | — | 1.0000 | 0.998 | undimensioned hand sketch: scale from the reference extents |
| NEMA 23 stepper | — | 0.9995 | 0.999 | 1:1 sheet: undimensioned features pixel-scanned |

A "reference defect" is proved, not assumed: a variant built the reference's way reaches IoU ≥
0.998 against it, while the drawing-faithful plan (kept) matches the drawing and the official mass.

## What the corpus fixed in llull

- OCC booleans did not merge coplanar faces → a fillet on one visible edge rounded half of it
  (`ShapeUpgrade_UnifySameDomain` after every boolean).
- `edgesNear` picked the edge with the nearest *mid point*, not the nearest edge.
- `measure_volume` / `mass_properties` used the coarse display mesh (up to ~1 % off): exact B-rep
  volume under OCC.
- `fillet_edge` committed invalid solids (later booleans hung) and solids whose mesh had a hole
  (non-watertight STL): now refused with a reason.
- `draw_arc` accepted sweeps over 2π; `render_view` gained `hide2D` and a fixed scale label on side
  views; a read-only query step no longer aborts a `build_project` plan; `llull run` prints the plan's aliases → ids; build123d/CadQuery code export works on
  current OCP.

Open (not fixed here): `loft_sections` resamples by arc length (stadium → stadium lofts twist,
−8 % volume); no elliptical-arc sketch piece; no sheet-metal commands; `move_entity` `delta` vs `duplicate_entity` `offset`; `rotate_entity`
pivots about `position` (a sweep's path start).
