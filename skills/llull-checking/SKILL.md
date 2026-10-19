---
name: llull-checking
description: Check and prove an llull (local CAD) model through the `llull` CLI — measure size, volume, mass and distances, compare them with independently computed values, and run llull's model, solid-validity, assembly, machining and mechanism checks with their stable finding codes. Use when asked to verify, check, validate, measure, weigh, inspect or sign off a model in llull, or before handing a model over or exporting it.
---

# llull-checking: measure, compare, report

Every check here is read-only: it never changes the document (safe on `--app`). A number is only checked when you compare it
with a value you derived independently (drawing, hand calculation, requirement). Report each as MEASURED / EXPECTED / DIFF.

## 1. Know what you are measuring

```bash
llull kernel_info --doc part.llull.json       # "occt" = exact B-rep volumes; "manifold" = faceted mesh (curved faces ~1 % low)
llull describe_scene --doc part.llull.json    # ids, kinds, bounds; one line per entity
```

## 2. Measure

| Quantity | Command | Result |
| -------- | ------- | ------ |
| Overall size | `measure_bounding_box` (whole document, or `entityId=`) | `data.min`, `data.max`, `data.size` |
| Volume, area, centroid, inertia | `mass_properties entityId=<id>` | `data.volume`, `data.area`, `data.centroid`, `data.method` |
| Mass | `mass_properties entityId=<id> density=0.00785` (g/mm³, steel) or an assigned material | `data.massG`, `data.massKg` |
| Distance / angle | `measure_distance point1=[…] point2=[…]` (or `entityId1` / `entityId2`, bbox centres), `measure_angle` | `data.distance` |
| 2D area / length | `measure_area`, `measure_perimeter` | |
| Exact faces and edges | `inspect_topology id=<id>`, `inspect_faces id=<id>` (exact kernel) | face types, areas, edge midpoints |
| Holes and pockets | `hole_table id=<id>`, `recognize_features id=<id>` (exact kernel) | positions, diameters, depths |

Use `--json` and read the `data` fields; text output rounds.

Independent values to compute yourself: box `w·d·h`; cylinder `π r² h`; sphere `4/3 π r³`; cone `π r² h / 3`; through hole removes
`π (d/2)² t`; mass = volume × density (steel 7.85 g/cm³ = 0.00785 g/mm³, aluminium 2.70 g/cm³ = 0.0027 g/mm³). Tolerances: exact kernel
~1e-6 relative; mesh kernel up to ~1 % on curved geometry; a drawing's stated mass to its rounding.

## 3. Run the checks

```bash
llull check_model --doc part.llull.json
#   data.ok, data.issues[]: degenerate_size, open_profile, dangling_reference, parameter_error, far_from_origin, ...
llull check_assembly thickness=off --doc part.llull.json
#   every 3D part: FPR_PART_INVALID / FPR_PART_EMPTY / FPR_PART_SHEET (not a closed solid), FPR_PART_DISCONNECTED (several lumps),
#   FPR_PAIR_HARD (parts overlap, with overlapVolumeMm3), FPR_PART_FLOATING (not attached to a grounded part)
llull check_assembly minWallMm=1.5 --doc part.llull.json      # adds FPR_WALL_THIN from ray-cast wall thickness
llull check_machining id=<id> 'rules=[{"rule":"maxDepthRatio","value":10,"source":"shop"}]' --doc part.llull.json
llull check_mechanism --doc part.llull.json                   # mobility (see the llull-mechanisms skill)
```

`status` is the worst item (fail > not_run > warn > pass). `not_run` is never a pass: the kernel or engine needed for that check is
missing — say so instead of reporting success. `check_machining` skips (and reports) every rule whose threshold you did not give;
rules are `minLand`, `maxDepthRatio` and `toolDiameter` (`llull describe check_machining`).

Intended contact (press fit, weld, thread) is declared with `allow_interference`, a world-fixed part with `set_part_grounded`; never
hide a finding any other way.

## 4. Look at it

```bash
llull render_view view=iso --save iso.png --doc part.llull.json
llull render_view view=front 'section={"axis":"y","offset":0}' --save section.png --doc part.llull.json
```

Open the PNGs and compare with the intent or the drawing views.

## Report

A table of every measured quantity with MEASURED / EXPECTED / DIFF, the status and codes of each check, the kernel used, and the
open items. llull marks engineering figures as computed, not approved (`reviewRequired`): pass that on.

## Known traps

- `measure_distance` with entity ids measures between bounding-box centres, not closest surfaces.
- `mass_properties` with no material and no `density` returns volume only (no mass).
- A primitive's volume is closed-form; after a boolean it is the kernel's (exact or faceted): compare like with like.
- Checks report on the current document only; re-run them after every edit.
