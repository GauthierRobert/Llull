# freecad-oracle (not run yet)

Regenerates oracle expectations from FreeCAD's Python API (`source: "freecad <version>"` in `tests/oracle/<nn>/expected.json`) when
FreeCAD is installed. FreeCAD is an external program, never a dependency of llull, and it is **not installed on the machine that
produced the current suite**, so every committed case has `source: "analytic"` and no FreeCAD number exists in the repository.

Intended use (a developer with FreeCAD):

```bash
FreeCADCmd tools/freecad-oracle/regenerate.py -- tests/oracle/<nn-name>
```

`regenerate.py` is a stub: it builds nothing and refuses to write until each case family has a FreeCAD recipe. When implemented it must
build the same part from `plan.json` parameters with `Part` (box, cylinder, cone, sphere, torus, extrude, revolve, fuse/cut/common,
fillet, chamfer, thicken), read `Shape.Volume`, `Shape.Area`, `Shape.CenterOfMass`, `Shape.BoundBox`, and write them with
`"source": "freecad <FreeCAD.Version()>"`. Never edit these numbers by hand.
