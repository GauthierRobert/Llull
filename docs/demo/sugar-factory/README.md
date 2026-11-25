# Demo: cane sugar factory (diffuser extraction, evaporation, boiling house)

A plant-scale example built only with registered commands. It is a demonstration, not a design: sizes, pressures, loads and
layout are assumptions of the author, and every result llull reports stays "review required".

## Files

| File                           | What it builds                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `plant.plan.json`              | The plant: 710 plan steps, about 5,900 entities                                                               |
| `bracket-fea.plan.json`        | A welded platform bracket with a static analysis set-up (mesh and solve are separate commands, see below)     |
| `bracket-topology.plan.json`   | A design space with a topology study for the same kind of bracket                                             |

## Run it

```bash
node server/bin/llull.cjs run docs/demo/sugar-factory/plant.plan.json --doc sugar.llull.json   # or --app with the desktop app open
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
  14 stage hoppers, operating platform and stair, lifting drum, two dewatering mills, feed and bagasse conveyors.
- 14 stage recirculation loops routed on the spec: suction from the hopper nozzle with a gate valve, pump, discharge riser with a
  gate and a check valve up to the distribution pipe over the bed; posts, shoes, riser anchors and guides.
- Five-effect evaporation station: parametric vessels with nozzles, ring platforms, vapour ducts, three juice heaters, barometric
  condenser, clear juice and syrup tanks.
- Spec-driven piping on the demo spec `SUG150` (NPS 2 to 12): duty / standby clear juice pumps with gate and check valves, a flow
  element and a control valve, juice transfer lines, syrup lines, an LP steam header with an expansion loop on the pipe rack and
  branches to effect 1 and two juice heaters.
- Pipe stress model of the steam header and its branches (ASME B31.3), fabrication rules, numbered welds.
- Boiling house: steel portal hall sized with `design_portal_frames` and `design_footings`, 10 t crane runway, four vacuum pans.
- P&IDs `PID-201` (diffuser recirculation), `PID-301` and `PID-302` (evaporation) whose tags and line numbers match the 3D model.

## State of the checks (as built by the plan)

| Check                  | Result                                                                                   |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| `check_clashes`        | no clashes                                                                               |
| `check_steel_members`  | all analysed members pass (max 0.95); platform brackets and posts are not analysed       |
| `check_pipe_supports`  | 62 of 62 pipes pass the span table                                                       |
| `check_pipe_stress`    | pass (worst ratio 0.77)                                                                  |
| `check_pid`            | 0 errors, 2 warnings (continuation lines on PID-302 carry no line number)                |
| `check_pid_3d`         | 76 items matched; 16 objects of the boiling house and utilities have no P&ID             |

## Known limits

- The piping catalogue `sugar-demo-cs150` inside the plan was typed in by the author from published ASME tables. 69 of its 202
  values were compared with the sourced tables of `docs/plant/*/validation/data` and are equal; the other 133 have no sourced
  reference in the repository and stay unverified. Replace it with the project catalogue before using any quantity or dimension.
- The mills, conveyors, boiler, silo and stack are plain solids, and the vapour ducts are simple DN600 pipe runs without fittings.
- The support posts and brackets are placed to satisfy the span table; they are not designed members.
- The boiling house and the utilities have equipment only: no piping and no P&ID.
