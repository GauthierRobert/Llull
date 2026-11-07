# X3 — `export_dxf` and `export_svg` for the 2D entities of a document

Status: built. Backlog item X3 (2D drafting): the document's own 2D drafting leaves llull as DXF and SVG, and `import_dxf` reads it back.

## Decisions

### DXF version: R2000 (AC1015), in core

The existing writer (`lib/dxfWriter.ts`, R12) stays for the domain exports (plans, flat patterns, ISO drawings): it is fine for LINE / ARC /
TEXT. R12 has no LWPOLYLINE, ELLIPSE, SPLINE, MTEXT, HATCH or true colour, and the 2D model has all of them, so a faithful general export
needs R2000. R2000 is the oldest version with every entity this model needs and is read by AutoCAD, BricsCAD, DraftSight, LibreCAD, QCAD
and ezdxf. Newer versions add nothing for 2D drafting. The R2000 writer is `lib/dxf2000.ts` (core: aec / aero may reuse it, core imports no
plugin); nothing was duplicated, the R12 writer keeps its callers and its `fmt` / `dxfText` helpers, which the new writer imports.

Verified with ezdxf (`server/tests/exportDxfAudit.test.ts`: `doc.audit()` reports no error and no fix). AutoCAD itself was not available:
the file has handles, subclass markers, the symbol tables (VPORT, LTYPE, LAYER, STYLE, VIEW, UCS, APPID, DIMSTYLE, BLOCK_RECORD), the
model / paper space blocks and a root dictionary, but no LAYOUT objects (ezdxf and LibreCAD do not need them; an AutoCAD open check is
still outstanding).

### Dimension: exploded to geometry + text

A `dimension` is written as its extension / dimension lines and arrowheads (the same `dimensionDrawing` strokes `export_building_dxf` uses)
as LINEs plus the value as centred TEXT (height 0.6, the viewport default) on the dimension's layer. A DXF `DIMENSION` needs an anonymous
`*D` block (BLOCKS section, per-dimension style variables) and every reader re-draws it with its own style, so the value / arrowheads
the user saw in llull would change. The explode keeps the drawing identical and is what `export_building_dxf` already does. Cost: not
associative; it imports back as lines + text. The summary says so (`N dimension(s) written as lines + text`).

### Placement, layers, colours, units

- Each entity is written in world xy by its `position` and Z rotation; the plane elevation (`position[2]`) is the DXF z. A plane tilted about
  X or Y is not expressible without OCS maths per entity: it is skipped with a named warning (`data.skipped`, reason `TILTED_PLANE`) when
  `ids` is omitted and refused (`EXPORT2D_TILTED_PLANE`) when named. Image underlays are skipped / refused the same way (`IMAGE_UNDERLAY`).
- Layers: name (forbidden characters `< > / \ " : ; ? * | = \`` become `\_`, non-ASCII is `\U+XXXX`), colour (ACI nearest + true colour 420),
  hidden (negative ACI) and locked (flag 4). An entity whose colour equals its layer's is by-layer; otherwise it carries ACI + 420.
- `$INSUNITS` = the document units (`in ft mm cm m`); import converts when the target document uses another unit.
- Numbers are written at full precision (`1e-7` as `0.0000001`): the round trip is exact to 1e-9, the R12 writer's 6 decimals are not enough.
- `LLULL` extended data (registered in APPID) tags what plain DXF cannot say: `rectangle` (closed LWPOLYLINE), `spline` (the model points) and
  `region` (loops of an unhatched region). Other CAD ignores it; `import_dxf` uses it to restore the kind.

### SVG

Millimetres (user unit = 1 mm, document units converted), y flipped, `viewBox` = extents + margin (default 5 mm). One `<g data-layer>` per
layer with the layer colour as stroke (an entity with another colour overrides it), hidden layers `display="none"`, one stroke width
(`lineWeightMm`, default 0.25: the model has no per-layer lineweight). Arcs / circles are `A` commands (exact), ellipses two half-ellipse `A`
commands, splines cubic Béziers (exact: the Catmull-Rom curve converted segment by segment), regions even-odd paths filled with `<pattern>`
(parallel / crossed lines at the hatch angle and spacing) or the solid colour, text `<text>` (font-size = cap height / 0.72).
`render/svg.ts` / `drawingSvg.ts` are sheet painters at paper scale with 2-decimal rounding; they were not reused.

## Mapping

| Model kind        | DXF R2000                                                                     | SVG                                         |
| ----------------- | ----------------------------------------------------------------------------- | ------------------------------------------- |
| line              | LINE                                                                          | `<line>`                                    |
| polyline          | LWPOLYLINE (closed flag)                                                      | `<polyline>` / `<polygon>`                  |
| rectangle         | closed LWPOLYLINE + `LLULL rectangle`                                         | `<polygon>`                                 |
| circle            | CIRCLE                                                                        | `<circle>`                                  |
| arc               | ARC (degrees)                                                                 | `<path>` `M … A r r 0 large 0 …`            |
| ellipse           | ELLIPSE (major axis vector, ratio, 0..2π)                                     | `<path>` two `A`                            |
| spline            | SPLINE degree 3, piecewise-Bézier knots (exact curve) + `LLULL spline` points | `<path>` `C`                                |
| point             | POINT                                                                         | filled `<circle>`                           |
| text              | TEXT (alignment 72 / 11) or MTEXT when multi-line                             | `<text>`                                    |
| dimension         | LINEs + centred TEXT                                                          | `<line>` + `<text>`                         |
| region, hatched   | HATCH (even-odd polyline paths; `_USER` lines / crossed lines, or SOLID)      | `<path evenodd>` + `<pattern>` / solid fill |
| region, unhatched | one closed LWPOLYLINE per loop + `LLULL region n`                             | `<path evenodd>` no fill                    |
| image             | not exported (skipped / refused)                                              | not exported                                |

## Round trip (`export_dxf` -> `import_dxf`)

`tests/unit/exchange/exportDraft.test.ts` exports a golden drawing with every kind, placed (position, Z rotation, elevation) on three
layers, imports it into an empty document of the same unit (mm, m, in) and compares world-space signatures: same kinds, layer names,
colours, geometry within 1e-9, layer visible / locked. Equivalences: an ellipse comes back with its major axis as `radiusX` (a `radiusY >
radiusX` ellipse is the same figure rotated 90°); a rectangle / ellipse / text keeps its place as `position` + `rotation` instead of an
origin at 0,0; ids are new.

Gaps, all asserted or visible in the summary, none silent:

1. Dimension: comes back as lines + text, not an associative dimension.
2. Multi-line text: exported as MTEXT; `import_dxf` joins the lines with a space and anchors at the insertion point.
3. Layer names: forbidden characters become `_` (`A:B` is `A_B`).
4. Solid hatch: the model's `angle` / `spacing` of a solid region are not in the DXF; import defaults them (45°, 1/40 of the diagonal).
5. Region with exact `curves`: exported through its `loops` tessellation; the import has `loops` only.
6. A hatched region has no stroked outline in DXF (a hatch is a fill); the shapes it was made from carry the outline.
7. Text fonts / outline text (`font`, `verticalAnchor`, `onCurve`, letter spacing): annotation text only.
8. Image underlays and entities on tilted planes: skipped with a named warning, or refused when named.
9. Foreign DXF: a SPLINE without `LLULL` data is sampled (or uses its fit points); an elliptical arc becomes a polyline; HATCH with spline /
   ellipse edges is skipped and named; loops that cross become polylines.

## Refusals (`EXPORT2D_*`, remediation in the error)

`EMPTY_SELECTION` (`ids: []`), `NO_ENTITIES` (none exportable), `UNKNOWN_ID`, `NOT_2D` (a solid id: never skipped silently),
`TILTED_PLANE`, `IMAGE_UNDERLAY`, `DIMENSION_DANGLING`, `BAD_GEOMETRY` (non-finite coordinate).

## Import additions

`import_dxf` now reads ELLIPSE, SPLINE, HATCH (regions), TEXT alignment, `\U+XXXX` escapes (text and layer names), true colours (420) and
layer visibility / lock, and restores rectangles, splines and unhatched regions from `LLULL` data. `flattenDxf` primitives gained
`ellipse`, `spline`, `hatch`; `import_survey_dxf` ignores them.
