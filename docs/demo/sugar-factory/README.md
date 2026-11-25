# Demo: cane sugar factory (diffuser extraction, evaporation, boiling house)

A plant-scale example built only with registered commands. It is a demonstration, not a design: sizes, pressures, loads and
layout are assumptions of the author, and every result llull reports stays "review required".

## Files

| File                           | What it builds                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `plant.plan.json`              | The plant: 313 plan steps, about 4,700 entities                                                               |
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

- Cane diffuser 62 m x 11.5 m on a braced steel support, 14 stage hoppers, 14 recirculation pumps with their lines, operating
  platform and stair, lifting drum, two dewatering mills, feed and bagasse conveyors.
- Five-effect evaporation station: parametric vessels with nozzles, ring platforms, vapour ducts, three juice heaters, barometric
  condenser, clear juice and syrup tanks.
- Spec-driven piping on the demo spec `SUG150` (NPS 2 to 12): duty / standby clear juice pumps with gate and check valves, a flow
  element and a control valve, juice transfer lines, syrup lines, an LP steam header with an expansion loop on the pipe rack and
  branches to effect 1 and two juice heaters.
- Pipe stress model of the steam header and its branches (ASME B31.3), fabrication rules, numbered welds.
- Boiling house: steel portal hall sized with `design_portal_frames` and `design_footings`, 10 t crane runway, four vacuum pans.
- P&IDs `PID-301` and `PID-302` whose tags and line numbers match the 3D model (`check_pid_3d`).

## Known limits

- The piping catalogue `sugar-demo-cs150` inside the plan was typed in by the author from published ASME tables and is flagged
  unverified by every check: replace it with the project catalogue before using any quantity or dimension.
- The diffuser, mills, conveyors, boiler, silo and stack are plain solids. The diffuser recirculation lines and the vapour ducts
  are simple pipe runs (`add_pipe_run`) without fittings or supports, so `check_pipe_supports` and `check_isometric` report them.
- Only the evaporation station has P&IDs; `check_pid_3d` lists the rest of the plant as "not on the P&ID".
