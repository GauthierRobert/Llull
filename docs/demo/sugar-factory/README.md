# Demo: cane sugar factory (diffuser extraction, evaporation, boiling house)

A plant-scale example built only with registered commands. It is a demonstration, not a design: sizes, pressures, loads and
layout are assumptions of the author, and every result llull reports stays "review required".

## Files

| File                                | What it builds                                                                                            |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `plant-1-equipment-steel.plan.json` | Stage 1: catalogue and specs, equipment, structures, platforms, machinery detail (828 plan steps)         |
| `plant-2-piping-pid.plan.json`      | Stage 2, applied on the stage 1 document: routed piping, supports, stress model, P&IDs (470 plan steps)   |
| `bracket-fea.plan.json`             | A welded platform bracket with a static analysis set-up (mesh and solve are separate commands, see below) |
| `bracket-topology.plan.json`        | A design space with a topology study for the same kind of bracket                                         |

## Run it

```bash
node server/bin/llull.cjs run docs/demo/sugar-factory/plant-1-equipment-steel.plan.json --doc sugar.llull.json   # or --app with the desktop app open
node server/bin/llull.cjs run docs/demo/sugar-factory/plant-2-piping-pid.plan.json --doc sugar.llull.json       # a plan holds at most 1000 steps, hence two files
node server/bin/llull.cjs check_clashes --doc sugar.llull.json
node server/bin/llull.cjs check_steel_members --doc sugar.llull.json
node server/bin/llull.cjs check_pid --doc sugar.llull.json
node server/bin/llull.cjs export_pid_svg sheet=PID-301 --save PID-301.svg --doc sugar.llull.json
```

The bracket analysis needs the native mesher (`llull-mesh`, `LLULL_NATIVE_DIR`) and CalculiX (`LLULL_CCX`):

```bash
node server/bin/llull.cjs run docs/demo/sugar-factory/bracket-fea.plan.json --doc bracket.llull.json
node server/bin/llull.cjs fea_mesh analysisId=an-15.1 --doc bracket.llull.json
node server/bin/llull.cjs fea_solve analysisId=an-15.1 --doc bracket.llull.json
node server/bin/llull.cjs render_fea_results analysisId=an-15.1 field=von_mises --save von_mises.png --doc bracket.llull.json
```

## What is in the plant

- Cane diffuser `DF-101` (62 m x 11.5 m, 1,500 t operating weight assumed) on a braced steel support with five column lines,
  14 stage hoppers, operating platform and stair, lifting drum; two dewatering mills (housings, rolls, drives, chutes) and belt
  conveyors with stringers, trestles, idlers and head drives, a cane shredder.
- 14 stage recirculation loops routed on the spec: suction from the hopper nozzle with a gate valve, pump, discharge riser with a
  gate and a check valve up to the distribution pipe over the bed; posts, shoes, riser anchors and guides.
- Five-effect evaporation station: parametric vessels with nozzles, ring platforms, vapour ducts, three juice heaters, barometric
  condenser, clear juice and syrup tanks.
- Spec-driven piping on the demo spec `SUG150` (NPS 2 to 12): duty / standby clear juice pumps with gate and check valves, a flow
  element and a control valve, juice transfer lines, syrup lines, an LP steam header with an expansion loop on the pipe rack and
  branches to effect 1 and two juice heaters.
- Pipe stress model of the steam header and its branches (ASME B31.3), fabrication rules, numbered welds.
- Boiling house: steel portal hall sized with `design_portal_frames` and `design_footings`, 10 t crane runway, four vacuum pans
  fed from the syrup tank by a pan feed pump and a supported DN100 header with a gate valve at each pan; molasses header from
  the six centrifugals to a pump and on to the molasses tank.
- Steam cycle: LP steam header from the turbo-alternator exhaust to the pipe rack on T-posts; HP steam line `HS-8001-250` from the
  boiler to the turbine on the butt-weld spec `SUGHP` (schedule 80, Class 600 flange at the turbine nozzle) with offset legs at both
  ends of the riser for thermal expansion, a riser anchor and guides; its own pipe stress model at 420 degC.
- P&IDs `PID-201` (diffuser recirculation, the diffuser drawn with `symbolSize`), `PID-301` and `PID-302` (evaporation),
  `PID-401` (pan feed), `PID-501` (molasses), `PID-801` (steam cycle) whose tags and line numbers match the 3D model.

- Machinery detail from plain solids (no mechanical design, sizes assumed): bagasse boiler with buckstays, steam drum, boiler
  bank / economiser pass with ash hoppers, air heater, FD and ID fans, bagasse cross conveyor and rotary feeders, three-section
  stack; turbo-alternator train (turbine casing and valve chest, reduction gearbox, alternator, exciter, lube oil console); cane
  feed tables, leveller and heavy-duty knives, shredder with its turbine drive; diffuser side stiffeners; juice clarifier with
  flash tank and two rotary vacuum mud filters; centrifugal drives, wet sugar belt, rotary sugar dryer (tyres, trunnion rollers,
  girth gear and pinion drive), bucket elevator and silo feed gallery.

## State of the checks (as built by the plan)

| Check                 | Result                                                                                |
| --------------------- | ------------------------------------------------------------------------------------- |
| `check_clashes`       | no clashes                                                                            |
| `check_steel_members` | all analysed members pass (max 0.95); platform brackets and posts are not analysed    |
| `check_pipe_supports` | 75 of 75 pipes pass the span table                                                    |
| `check_pipe_stress`   | LP header: pass (worst ratio 0.76); HP steam line at 420 degC: pass (0.77)            |
| `check_pid`           | 0 errors, 4 warnings (continuation lines after an off-page connector carry no number) |
| `check_pid_3d`        | pass: 107 items matched, nothing unmatched on either side                             |

## Known limits

- The piping catalogue `sugar-demo-cs150` inside the plan was typed in by the author from published ASME tables. 69 of its
  values were compared with the sourced tables of `docs/plant/*/validation/data` and are equal; the others have no
  sourced reference in the repository and stay unverified. The Class 600 NPS 10 flange of `SUGHP` equals the sourced ASME B16.5
  table (outside diameter, thickness, bolt circle, bolting, raised face); its hub length and gasket have no sourced reference. Replace it with the project catalogue before using any quantity or dimension.
- Boiler, turbo-alternator, mills, conveyors, dryer, clarifier and filters are assemblies of plain solids for layout and
  presentation: no mechanical design, and they are not tagged equipment (only the furnace `B-801` and the turbine base frame
  `TG-801` are). The vapour ducts are simple DN600 pipe runs without fittings.
- The support posts and brackets are placed to satisfy the span table; they are not designed members.
- The crystalliser and the silo are equipment only (massecuite and sugar handling are not piping). Boiler feed water, condensate and bagasse handling are not modelled.
