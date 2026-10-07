# Industrial (factory builder) guide

For companies that design and build **factories, warehouses and process halls**: steel portal
frames, crane runways, foundations, cladding, machines and utilities — delivered as steel
tonnage, cut lists, clash reports, elevations / sections, plans, DXF and IFC. It extends the
building workspace ([`CONSTRUCTION.md`](CONSTRUCTION.md)): same constructive building model, same
"one command = Building panel tool + MCP tool" rule. Plan and status:
[`INDUSTRIAL_PLAN.md`](INDUSTRIAL_PLAN.md).

## Elements

| Element                 | Command(s)                                               | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Steel profile catalogue | `list_steel_profiles`                                    | IPE, HEA, HEB, UPN, cold-formed C, SHS, RHS, CHS and L sections with depth, width, thicknesses, area, kg/m and paint perimeter. Names are case- and space-insensitive (`hea 400`).                                                                                                                                                                                                                                                                                                                                                                   |
| Steel member            | `add_steel_member`, `update_steel_member`                | Role (column, beam, rafter, brace, purlin, side rail, crane beam), profile, axis start / end in 3D (z above the level), roll about the axis, grade (default S355). Exact section swept along the axis. Marks SC / SB / RF / BR / PU / SR / CB. Layers `S-COLS` (columns), `S-BEAM` (beams, rafters), `S-BRAC`, `S-JOIS` (purlins, rails), `S-CRAN`.                                                                                                                                                                                                  |
| Grid framing            | `add_grid_columns`, `add_grid_beams`, `add_grid_bracing` | Frame steel by grid: a column at every grid intersection (optionally continuous to a top level, `axes` / `exclude` filters), beams per bay along grid lines (top of steel = level FFL + `topOffset`), X / diagonal bracing in one bay of one grid line. Skips what already exists.                                                                                                                                                                                                                                                                   |
| Floor openings          | `add_equipment_openings`                                 | Cut every floor / grating an equipment passes through (footprint + margin, default 300 mm); `check_clashes` reports equipment crossing a floor with no opening.                                                                                                                                                                                                                                                                                                                                                                                      |
| Portal-frame hall       | `add_portal_frame_building`                              | One undoable step: grid (letters along the hall, numbers per frame), columns and pitched rafters every bay, gable wind posts, purlins on both slopes, side rails, X-bracing in the end bays, pad footings, ground slab, roof / wall / gable cladding, optional crane runway on brackets. `spans: [...]` builds a multi-span hall (internal columns, valleys, one roof per span, a crane per span). Summary reports the steel tonnage.                                                                                                                |
| Crane runway            | `add_crane_runway`                                       | Runway beams split at supports, a bracket from each support to the nearest steel column (≤ 2 m). Capacity and rail height are noted on the members.                                                                                                                                                                                                                                                                                                                                                                                                  |
| Base plate              | `add_base_plates`                                        | Steel plate (profile + 100 mm overhang, 20/25 mm) with anchor bolts (default 4 × M24) under each steel column; follows its column when moved, deleted and copied with it. Generated by the hall generator (`basePlates: false` to skip). `IfcPlate` + `IfcMechanicalFastener` (ANCHORBOLT).                                                                                                                                                                                                                                                          |
| Pad footing             | `add_footing`                                            | At a location, or `underColumns: true` for every steel / concrete column foot of the level. Default 1500 × 1500 × 600, top 300 below the level.                                                                                                                                                                                                                                                                                                                                                                                                      |
| Cladding panel          | `add_panel`                                              | Planar sandwich / sheeting panel through 3D corners; thickness grows along the right-hand normal. Roof or wall role.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Equipment               | `add_equipment`                                          | Machine footprint with height, rotation, maintenance clearance (drawn dashed in plan) and operating weight (IFC property set `Pset_llullEquipment`); edit in place with `update_equipment`.                                                                                                                                                                                                                                                                                                                                                          |
| Cable tray              | `add_cable_tray`                                         | Open U-section tray along a 3D route with width, side height and cable system (power, data…). Layer `E-TRAY`, marks CT, `IfcCableCarrierSegment`.                                                                                                                                                                                                                                                                                                                                                                                                    |
| Pipe run                | `add_pipe_run`                                           | 3D polyline with service, line number, DN (outside diameter from the EN 10220 table) and from / to ends — the pipe schedule is the line list; bends at every interior point.                                                                                                                                                                                                                                                                                                                                                                         |
| Pipe support            | `add_pipe_support`, `check_pipe_supports`                | Shoe / guide / anchor on steel below, hanger (rod) from steel above, on a pipe chosen by `pipeId` or `line`, at `at` points (snapped to the centreline) or every `spacing`. Bears on the nearest steel member in reach (or `memberId`); none found ⇒ unattached (warned). On a riser a guide / shoe / anchor is a clamp with a bracket to steel beside the pipe. Block / rod / clamp geometry on layer `P-SUPP`, marks PS, plan symbols, `IfcBuildingElementProxy` (PIPESUPPORT). Follows its pipe and re-attaches when its steel or pipe is edited. |

## Coordination

`check_clashes` (read-only, like Navisworks / Plant 3D) reports **hard clashes** between pipes,
equipment, steel, walls, concrete columns, beams and stairs, and **clearance violations** into
an equipment's maintenance zone, with element ids and penetration depth. Steel-to-steel joints
and pipe connections (a pipe end inside equipment or on another pipe) are not clashes. In the
Building panel, _Check clashes_ lists them; click a row to select both elements.

## Structural check and design

`check_portal_frames` (read-only) solves every portal frame of a level as a 2D frame (direct
stiffness method, pinned bases (or fixed with `columnBase: 'fixed'`), section properties from the profile outline — no root radii,
≈ 4–5 % conservative; haunches are not counted as stiffening) for every EN 1990 combination of:

- **G** — roof dead load (`deadLoad`, kN/m²) on the tributary width + member self-weight + runway
  self-weight at the crane brackets;
- **S** — snow (`snowLoad`, kN/m²);
- **W** — wind (`windPressure` = peak velocity pressure qp, kN/m², default 0 = off): windward wall
  +0.8, leeward −0.5, roof −0.6, each with internal pressure cpi +0.2 and −0.3, from the left and
  from the right;
- **C** — overhead cranes, read from the runway capacity (`add_crane_runway` / the hall `crane`
  option, or `craneCapacity` to override, 0 to ignore): maximum / minimum wheel reactions with
  dynamic factors and a 10 % lateral surge, applied at the brackets with their eccentricity.

Combinations: 1.35G+1.5S, 1.35G+1.5W+0.75S, 1.0G+1.5W (uplift); with cranes, crane-leading
1.35G+1.35C(+0.75S)(+0.9W, either direction) and wind-leading 1.35G+1.5W+0.75S+1.35C — crane at
either rail, each wind direction. Every combination includes sway imperfections (EN 1993-1-1
§5.3.2) applied where column compression enters (column tops and crane brackets). The elastic
critical factor αcr is estimated with Horne's method per column storey; outside Horne's scope
(roof slope > 26° or rafter N > 0.09 Ncr) the modified estimate 0.8 αH (1 − N/Ncr) is used. All
moments are amplified by 1/(1 − 1/αcr) when αcr < 10 (conservative) and the frame fails when
αcr < 3.

Checks, worst per element with the governing combination: member cross-section (§6.2), flexural
buckling with N–M interaction (§6.3.3; columns over their full height, rafters between purlins),
moment-connection bolt groups (grade 8.8 tension / shear, EN 1993-1-8, for every combination —
uplift reverses the apex moment), sway stability, and serviceability: rafter deflection under snow
≤ span/200, eaves sway under wind ≤ h/150, rail-level sway under crane ≤ h/400 (EN 1993-6).

`design_portal_frames` iterates with the same loads: it up-sizes failing rafter / column sections
uniformly (next heavier profile, then IPE → HEA / HEB), stiffens rafters and columns together when
a frame fails on sway or stability, picks the bolt diameter and row count of each connection type
against all combinations, and reports the changes and final utilisations. Connections also carry
full-strength fillet weld sizes in their schedule and weld length / metal in the takeoff.

Lateral-torsional buckling uses Mcr from the section (It, Iw) with the compression flange
restrained at the purlins (rafters) and side rails (columns) — fly braces assumed.

Companion checks, all read-only and driven by the same loads:

- `check_bracing` — longitudinal wind on the gables (and frame stability forces) → roof and wall
  X-bracing as tension-only diagonals, eaves struts in compression, gable posts in bending.
- `check_purlins` — roof purlins and wall rails per bay under dead + snow and wind with the
  EN 1991-1-4 zones (roof F / G / H / I, walls A / B / C / D, cpi ±): bending (uplift with the free
  flange reduced), shear, deflection span/200 (purlins) and span/150 (rails).
- `check_foundations` — characteristic base reactions per load case → pad footing soil bearing
  (effective width), uplift (EQU), sliding, base plate concrete bearing and anchor bolts. With a
  ground slab the frame thrust is tied through it (tie-force row, slab friction against sliding);
  `thrustTie: false` makes each pad resist its own reaction.
- `check_crane_runways` — runway beams under two moving wheels: biaxial bending (top flange takes
  the surge), shear, lateral-torsional buckling, L/600 deflections (EN 1993-6) and fatigue with the
  damage-equivalent factor of the crane class (S2–S4, detail category 71).

`design_footings` designs the pad footings (EN 1992-1-1, C25/30, B500): bottom mat both ways from
bending at the base plate face (minimum steel, bar H12–H25 at 100–250 mm), one-way shear and
punching at 2d; footings that fail shear or punching are reported "increase thickness". The bars
go to the footing schedule and the rebar mass to the takeoff. `check_foundations` adds elastic
settlement (`soilModulus`, 25 mm) and differential settlement between frame columns (L/500).

### Any steel structure: `check_steel_members`

Multi-storey process structures, platforms and pipe racks are not portal frames, so
`check_steel_members` (read-only) verifies **every** steel member of the model with loads derived
from it:

- **Floors**: `floorDeadLoad` (0.5 kN/m², gratings) and `imposedLoad` (5 kN/m², process floors; not
  under equipment footprints) go to the beams under each slab by the 45° tributary rule.
- **Equipment**: operating weight on the floor it stands on, spread over the bays its footprint
  covers. Equipment on grade is reported, not carried.
- **Pipes and trays** resting on a beam (underside at top of steel ±10 mm): water-filled steel pipe
  (standard wall by OD) and `cableTrayWeight` (75 kg/m), tributary length to the neighbouring
  supports. A pipe that has `add_pipe_support` supports is carried by them only: each support on
  steel takes weight/m × half the span to its neighbours (the whole overhang to a free end) as a
  point load on its beam — a shoe / guide / anchor on the top flange, a hanger at the rod
  attachment — or axially on a column (a bracket off a column is noted); an unattached support is
  warned. A guide on a riser is lateral only and carries no weight; a shoe / anchor clamp on a riser
  carries its tributary share like any support. A pipe with both ends in equipment or on a header within the table span rests on its
  nozzles.
- **Self weight** from the catalogue.

ULS 1.35 G + 1.5 Q. Beams (simply supported unless a joint is rigid): bending with LTB (restrained by
a floor or by pipes), shear, deflection ≤ L/`deflectionRatio` (250) under G + Q. Columns: Npl and
flexural buckling per storey segment between beam levels. Bracing: equivalent horizontal forces (`notionalFactor` 1/200,
EN 1993-1-1 §5.3.2) shared by the bracing planes; X-bracing tension-only with λ ≤ 300; chord beams
of braced bays as struts. `data.members` has one verdict row per member (`utilisation`, `ok`,
governing check); members it cannot analyse (rafters, purlins, crane beams — use the dedicated
checks — or sections outside the catalogue) are listed with the reason. `data.loads.assumptions`
states every rule above; `data.warnings` lists model gaps (equipment on grade, pipes resting on no
beam, a storey without bracing or a moment frame in one direction).

#### Moment frames (rigid joints)

Beam-to-column joints are pinned by default. A beam declares `startJoint` / `endJoint: 'rigid'`
(`add_steel_member`, `update_steel_member`) when it is moment-connected to the column it frames
into, and a column declares `baseFixity: 'fixed'` (default: its base plate's fixity — a plate
created with `fixity: 'fixed'`, as the portal-hall generator does for `columnBase: 'fixed'` — else
pinned; `check_steel_members` warns when the member and its plate disagree, because
`check_foundations` only sees the plate). Columns and beams in one vertical plane (`x = const` or
`y = const`) joined by rigid joints form a **moment frame**; the pinned end of a frame beam is
released, a free end is a cantilever, a column belongs to one frame plane (a second plane's rigid
joints on it are rejected with the reason). Each frame is solved as a 2D frame (direct stiffness,
the `@lib/frame2d` solver with member end releases):

- **Loads**: the beam loads of the load path above (floor, equipment, pipes, point loads of
  secondary beams), the reactions of the pinned beams and pipes on the frame columns, column self
  weight, and the §5.3.2 notional forces φ × the factored vertical load at each beam level, toward
  both sides.
- **Checks** (one row per member, as for any member): `frame N+M (§6.3.3)` — beams with LTB over the
  span (sagging; restrained by a floor or pipes) and over the **hogging length** at rigid ends,
  columns with Lcr = the storey piece on the axis the frame plane bends (the column `roll` decides:
  at roll 0 the depth lies along X, so a bent in a plane `x = const` bends the **weak** axis — use
  roll π/2 for the strong axis; rolls between the axes are not analysed); `cross-section N+M
(§6.2.9)` with the shear reduction of §6.2.8; `shear (§6.2.6)`; beam `deflection` relative to the
  chord; column `sway h/300` (`swayRatio`) storey drift under G + Q + the notional forces; and
  `sway stability αcr ≥ 3` on the column with the lowest αcr = h / (200 δ) (drift δ under V/200,
  Horne). When αcr < 10 all moments are amplified by 1 / (1 − 1 / αcr) (conservative).
- **Joint moments** for the connection design: `forces.jointMomentStart` / `jointMomentEnd` of the
  beam rows (kNm, hogging negative, worst of both sway directions), column `forces.baseMoment` for
  fixed bases, and `data.frames[].jointMoments`.
- A frame is the lateral system of its direction for the storeys below its highest beam: those
  storeys no longer warn "no bracing in direction …". Bracing in the same direction keeps taking
  the full storey force (both systems are verified for it — conservative).
- Failures: a rigid joint at a beam end that bears on nothing or on a beam, a beam outside the X / Y
  planes, a column already in another frame plane, or a beam with no length between its columns
  leave the beam **not analysed** (reason in its row and in `data.warnings`); a frame that is a
  mechanism (for example a pinned-base column with a rigid cantilever) leaves all its members not
  analysed.

A pipe-rack bent is the typical case: IPE tier beams with rigid joints to HEB columns (roll π/2,
pinned or fixed bases) in every bent, longitudinal X-bracing in the column-line planes (the pipes
run through the bents, so the transverse direction cannot be braced).

### Pipe supports and spans: `add_pipe_support`, `check_pipe_supports`

`add_pipe_support` { `pipeId` | `line`, `at` | `spacing`, `type`, `memberId?`, `maxReach?`,
`planTolerance?` } places supports on a pipe: `type` shoe (default), guide, anchor (rest on steel
below, pedestal height = gap pipe underside → steel top) or hanger (rod from steel above, rod length
= gap steel underside → pipe top). The steel is `memberId`, else the nearest member in reach:
vertical gap ≤ `maxReach` (500 mm below, 3 m for a hanger), plan distance ≤ half the member width +
`planTolerance` (100 mm); columns carry shoes / guides / anchors (on top or as a bracket). No steel in
reach ⇒ the support is created **unattached** (`memberId` null; the summary warns, it carries
nothing and fails the span check). `spacing` auto-places supports at most that far apart, one
`min(300 mm, spacing/4)` from each free end and bend; ends in equipment or on another pipe are carried
and risers are skipped (`spacing` never places on a riser; give an `at` point there). Supports follow
their pipe (moved, copied, deleted with it) and appear in `building_schedule` kind `support` (Mark,
Line, Pipe, Type, Bears on, x, y, z, Rod length), the takeoff (`pipe-support.<type>.ea`,
`pipe-support.hanger-rod.m`) and the IFC; a support touching its own pipe and steel is not a clash.

**Risers** (a run of segments steeper than 44° from horizontal, |dz| / length > 0.7, at least 0.5 m
long): a hanger cannot hang there; a `guide`, `shoe` or `anchor` at an `at` point on it is a clamp
with a horizontal bracket to the steel beside the pipe — a column, or a horizontal member whose
section reaches the clamp elevation ± `planTolerance` and whose face is within `maxReach` (500 mm)
of the pipe surface (the nearest face wins; `standoff` = bracket length, `standoffAngle` = plan
direction to the member). A guide carries no weight; a shoe or anchor clamp carries the riser weight
(an anchor guides too). No steel in reach ⇒ unattached, as on horizontal runs.

**Attachment follows edits** (also on replay, because it runs in every building regeneration):
deleting a member re-attaches the supports bearing on it to the nearest steel in reach (same search
as `add_pipe_support`, default reach: 500 mm below / beside, 3 m for a hanger, widened to the
support's own pedestal / rod / bracket) or leaves them unattached, never with a dangling `memberId`;
moving a pipe (`move_building_element`) or copying it with `copy_level_elements` re-runs the search at
the new position (the current member is kept while still in reach); moving or editing a member
(`move_building_element`, `update_steel_member`) re-checks the supports on it (pedestal / rod length
updated, re-attached, or detached). Supports that were unattached are only re-attached when their
pipe moves. The summary of the edit lists them: `kept`, `re-attached SB1 -> SB2`, `DETACHED from SB1`.

**Plan symbols** (`export_dxf`, `export_plan_sheet`, the 2D building view): the supports of the
plotted level (the level of their pipe, as pipes are drawn) at their plan position, 300 mm symbols on
layer `P-SUPP` with the mark as text: shoe = filled square, hanger = circle with a cross, guide =
square with a tick along each side of the pipe, anchor = hatched square with both diagonals. Fills
go to `P-SUPP-PATT` in the DXF, like every other fill.

`check_pipe_supports` (read-only) gives one row per pipe: the support spacing against the standard
maximum span of horizontal water-filled standard-wall steel pipe (MSS SP-69 Table 3 / ASME B31.1
Table 121.5: DN25 2.1 m, DN50 3.0 m, DN80 3.7 m, DN100 4.3 m, DN150 5.2 m, DN200 5.8 m, DN250 6.7 m,
DN300 7.0 m … DN600 9.8 m) × `spanFactor`. Spans run along the centreline between supports that bear
on steel (risers are not counted); a pipe end in equipment or on another pipe is carried (a nozzle);
a free end needs a support within `overhangRatio` (0.5) × the allowed span; a pipe without supports
uses the beams it rests on (`basis` "resting"). Row: `{ id, mark, line, dn, maxSpanM, allowedSpanM,
largestSpanM, overhangM, supports, unattached, basis, risers, ok, issues }`.

Each riser is checked by a design-aid rule (not a quoted code clause) and `ok` includes it. The
spacing is the MSS SP-69 table value of the DN applied to the vertical length, × `spanFactor`:

- lateral restraints — attached guides and anchors on the riser, an end carried by equipment or a
  header — at most that span apart;
- a free end (an elbow) at most `overhangRatio` × that span from the nearest restraint; a riser
  between two elbows with no guide may be that long at most;
- the riser weight (water-filled, standard wall) carried by an end in equipment or on a header
  (nozzle), a shoe or anchor clamp on the riser, or an attached support of the pipe within
  `overhangRatio` × the span, along the pipe, of one of its elbows (the riser hangs on the elbow like
  a free end); otherwise "carried by nothing".

`risers: [{ fromZM, toZM, lengthM, guides, maxGuideSpacingM, allowedSpacingM, weightKn, weightBy
("carried end" | "clamp" | "elbow support" | null), ok, issues }]`; the riser issues are also in the
pipe's `issues`. A guide on a riser is no support for the horizontal spans (a shoe or anchor clamp
counts as a support at its elbow). Risers shorter than 0.5 m are fittings, not rows.

### Design workflow

Run the design commands in order — each one sizes what the next one checks:

1. `design_portal_frames` — frame sections, connection bolt groups, fixed base plates (M + N).
2. `design_purlins` — purlin and side rail profiles.
3. `design_footings` — pad plan size, thickness and reinforcement from the final base reactions.
4. Verify with `check_portal_frames`, `check_bracing`, `check_purlins`, `check_foundations` and
   `check_crane_runways` using the same loads.

Crane halls are best built with `columnBase: 'fixed'`: rail-level sway (h/400) otherwise drives
pinned frames to very heavy sections.

## Site and fabrication deliverables

- `export_anchor_plan` — anchor bolt setting-out plan (SVG): grids, footings, base plates and every
  anchor bolt dimensioned from the grid lines, with a bolt schedule (grid reference with offset,
  bolts, embedment, projection, top of concrete / grout).
- `export_nc_files` — DSTV NC1 files for CNC saw-drill and plate lines: one file per distinct part
  (profile, length, pitched cuts, bolt holes; base and end plates with their contour and holes),
  with quantities.

Not covered: cold-formed section local buckling (effective widths), wind on irregular shapes, dynamic crane analysis. This is a preliminary design aid, not a substitute for
the engineer of record.

## Quantities and fabrication lists

`quantity_takeoff` adds steel **mass per profile (kg)**, length per profile, **paint / coating
surface (m²)**, footing count and concrete volume, cladding area by role, equipment count and
pipe length by service and diameter, cable tray length by system and size, base plate mass and anchor bolt counts by diameter — all priceable with `set_cost_rates` (keys like
`member.HEA400.kg`, `member.paint.m2`, `panel-roof.sandwich-panel.m2`). `building_schedule`
kinds `member` (cut list: mark, role, profile, length, mass, grade), `footing`, `panel`,
`equipment`, `pipe`, `tray`, `plate` (base plates with bolts and mass), `connection` (end plates, bolts, haunches, mass) and `support` (pipe supports).

## Drawings and exchange

| Deliverable | Command                                       | Notes                                                                                                                                                                                               |
| ----------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Elevation   | `export_elevation_sheet` { direction }        | North / south / east / west (+Y is north), hidden lines removed, level datums, grid bubbles, scale bar, title block. `exclude: ["panel"]` shows the frame behind the cladding.                      |
| Section     | `export_elevation_sheet` { direction, cutAt } | The model nearer than the cut plane is removed; cut faces are filled (steel solid, concrete hatched, others grey) with heavy outlines.                                                              |
| Floor plan  | `export_plan_sheet`, `export_dxf`             | Columns cut at 1.2 m as sections, beams / bracing as hidden axis lines, equipment with clearance zone and name, pipes with service, footings hidden. Roof framing belongs to elevations.            |
| IFC4        | `export_ifc`                                  | IfcColumn / IfcBeam / IfcMember with IfcIShapeProfileDef / IfcRectangleHollowProfileDef / IfcCircleHollowProfileDef…, IfcFooting, IfcCovering, IfcBuildingElementProxy (equipment), IfcPipeSegment. |

## Building panel

_Steel hall_ (starter) generates a default 24 × 48 m hall. The tool picker's **Industrial / steel**
group has forms for the hall generator (with optional crane), steel member, pad footing, cladding
panel, crane runway, machine / equipment and pipe run (route as `x,y,z; x,y,z`). _Clash
detection_, the takeoff (kg lines), schedules and _Deliverables → Elevation / Section sheet_ sit
below. MCP agents get the same workflow from the `design_factory` prompt.
