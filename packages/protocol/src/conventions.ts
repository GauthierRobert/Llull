/**
 * The agent modeling conventions guide an agent should read BEFORE modeling, printed by `llull guide`.
 * Not a registry command: the `buildCommandTools().length === listCommands().length` invariant must hold.
 */

export const CONVENTIONS_GUIDE: string = `# llull CAD — Agent Modeling Conventions

Read this BEFORE creating or editing geometry. It defines the world frame,
anchor points, rotation convention, and the recommended workflow loop.

---

## 1. Units

Every llull document has a \`units\` field (default: \`"mm"\`). All coordinates,
sizes, radii, and heights you pass to commands are in those document units.
Check the document \`units\` (a field of the document file; \`set_units\` changes them) before
placing geometry. Do NOT mix units — if the document is in \`mm\`, a box of
\`size: [1, 1, 1]\` is 1 mm × 1 mm × 1 mm.

Supported units: \`"mm"\`, \`"cm"\`, \`"m"\`, \`"in"\`, \`"ft"\`.

---

## 2. World Frame (right-handed, +Z up)

llull uses a **right-handed coordinate system with +Z pointing up**:

- **+X** → right (East)
- **+Y** → into the screen / forward (North)
- **+Z** → up

The world origin is at \`[0, 0, 0]\`. Ground plane is Z = 0.
Positive Z is above ground; negative Z is below ground.

When \`render_view\` shows the axis triad:
  - Red axis  = X
  - Green axis = Y
  - Blue axis  = Z (up)

---

## 3. Placement Anchor per Primitive

\`position\` is the **anchor point** of each primitive — NOT necessarily a
corner. Knowing the anchor lets you place objects without offset math errors.

| Command         | \`position\` anchor                              |
| --------------- | ----------------------------------------------- |
| \`add_box\`       | **center** of the box (centroid of all 8 corners) |
| \`add_cylinder\`  | **center** (geometric center; spans ±height/2 about position) |
| \`add_sphere\`    | **center** of the sphere                         |
| \`add_cone\`      | **base-center** (center of the bottom circle)    |
| \`add_torus\`     | **center** of the torus (center of the donut hole) |
| \`add_wedge\`     | **lower-front-left corner** of the bounding box  |
| \`add_pyramid\`   | **base-center** (centroid of the rectangular base) |
| \`extrude_profile\` | **origin** of the 2D profile in the XY plane  |
| \`sweep_profile\` | **path start** (the first path point; path stored relative to it) |
| \`loft_sections\` | **first section centre** (rings stored relative to it) |
| \`add_subdivision_solid\` | **cage origin** (box / cylinder cages are centred on it) |

**Common pitfall**: center-anchored primitives are half-buried at \`position[2] = 0\`.
To sit them ON the ground (Z=0), set \`position[2]\` to half their height:
\`add_box\` → \`size[2] / 2\`, \`add_cylinder\` → \`height / 2\`, \`add_sphere\` → \`radius\`.
Only \`add_cone\` is base-anchored, so \`position[2] = 0\` already places its base ON
the ground (apex at \`+height\`).

---

## 4. Rotation Convention

\`rotation\` is an **Euler XYZ tuple in RADIANS**, not degrees.

\`\`\`
rotation: [rx, ry, rz]   // XYZ Euler, radians
\`\`\`

- \`[0, 0, 0]\` = no rotation (default orientation)
- \`[0, 0, Math.PI / 2]\` = 90° rotation around Z axis
- To convert degrees to radians: \`radians = degrees * Math.PI / 180\`

**Common pitfall**: Passing degrees (e.g. \`rotation: [0, 0, 90]\`) gives a
wildly unexpected orientation. Always use radians.

---

## 5. Recommended Agent Loop

1. **Orient** — call \`describe_scene\` to see what entities exist, their ids,
   kinds, positions, and the current scene bounds.

2. **Create / edit** — call the appropriate command(s) (e.g. \`add_box\`,
   \`move_entities\`, \`scale_entity\`). Commands return the new entity id in
   \`affected\` and a factual \`summary\`.

3. **SEE it** — call \`render_view\` with \`showAxes: true\` (default) and
   \`showGrid: true\` (default). The rendered image now shows:
   - A colored X/Y/Z triad anchored at the world origin (X=red, Y=green, Z=blue).
   - A faint grid on the Z=0 ground plane.
   - A scale label showing the unit and pixel-to-unit ratio.
   Compare the object's position relative to the origin and grid to verify
   placement matches your intent.

4. **Lint** — call \`check_model\` to catch dangling references, invalid
   dimensions, or other document issues.

5. **Iterate** — if render_view shows the object is misplaced, use
   \`move_entities\` or re-create it with corrected params.

---

## 6. Common Pitfalls

- **Wrong anchor assumption**: "I set \`position: [0,0,0]\` but the box is
  half-buried below ground." → For \`add_box\`, position is the center, so
  use \`position[2] = height/2\` to place it on the ground.

- **Rotation in degrees**: \`rotation: [0, 0, 90]\` rotates ~1571 rad around
  Z, not 90°. Use \`[0, 0, 1.5708]\` or \`[0, 0, Math.PI/2]\`.

- **Units mismatch**: A 1 m box in a mm document would be tiny. Check
  the document \`units\` first.

- **Forgetting +Z up**: Y is NOT up in llull. Stacking objects vertically
  means increasing the Z component of \`position\`.

- **Not using render_view after creation**: Always visually verify. The
  axis triad and grid in the image are your spatial reference — trust them
  over mental math.

- **Large offsets from origin**: The camera auto-fits the scene. If entities
  are far from each other (e.g. [0,0,0] and [10000,0,0]), they may appear
  very small. Keep related geometry near each other and near the origin.

---

## 7. Key Commands Reference

| Command           | Purpose                                            |
| ----------------- | -------------------------------------------------- |
| \`describe_scene\`  | Read-only: scene snapshot (entities, bounds, etc.) |
| \`render_view\`     | Render to image (use showAxes+showGrid for context) |
| \`check_model\`     | Lint the document for errors                       |
| \`add_box\`         | Create a rectangular box solid                     |
| \`add_cylinder\`    | Create a cylinder (center anchor)                  |
| \`add_sphere\`      | Create a sphere (center anchor)                    |
| \`add_cone\`        | Create a cone (base-center anchor)                 |
| \`add_torus\`       | Create a torus/donut (center anchor)               |
| \`add_wedge\`       | Create a wedge/ramp (lower-front-left anchor)      |
| \`add_pyramid\`     | Create a rectangular pyramid (base-center anchor)  |
| \`sweep_profile\`   | Pipe/tube/rail along a path; \`stations\` = tapered/variable section |
| \`loft_sections\`   | Skin a solid through 2+ sections (round→square, tapered bodies) |
| \`blend_union\`     | Weld solids into one piece with filleted joints (frames, tees) |
| \`pattern_along_path\` | Oriented copies along a curve (chain links, tread, teeth) |
| \`add_subdivision_solid\` | Freeform smooth solid from a cage (saddle, hoods, grips) |
| \`edit_subdivision_cage\` | Sculpt it: move/scale cage regions, crease edges |
| \`surface_from_curves\` | Shell part spanning 2 or 4 boundary curves (hoods, panels) |
| \`revolve_profile\` | Turned part from a profile or a sketched spline loop |
| \`move_entities\`   | Translate entities by a delta vector               |
| \`delete_entities\` | Remove entities by id                              |
| \`set_entity_name\` | Assign a human-readable name to an entity          |
| \`export_code\`     | Model as CadQuery/build123d/OpenSCAD/FreeCAD source |
| \`import_code\`     | Rebuild the model from edited CadQuery/build123d   |
| \`export_step\`     | Exact B-rep STEP file (server Python bridge)       |
| \`import_step\`     | STEP solids → named, coloured mesh entities        |

To trace a scanned drawing instead of estimating scale by eye: \`add_image_underlay\` (PNG/JPEG
data URL), \`calibrate_underlay\` (two pixel points + their real distance; optional \`origin\` pins a
pixel to a world point, \`align\` de-skews), then \`image_to_world\` turns pixel coordinates read
off the picture (origin top-left, +y down) into model [x, y] points for \`draw_polyline\`,
\`extrude_profile\` or \`revolve_profile\`.

To read or rework a whole model at once, call \`export_code\` (language "cadquery"):
the code lists every parameter, dimension and feature in build order. Edit it and
send it back with \`import_code\` to regenerate an editable feature history.

## 8. Materials, fasteners and manufacturing features (toolsets materials, fasteners, manufacturing)

Engineering results are computed, not approved: every one carries unverified (with reasons) and
reviewRequired. Never present them as released; say what a qualified person must check.

- **Units.** Physical values are \`{ value, unit }\` (\`g/cm^3\`, \`lb/in^3\`, ksi, MPa, degF);
  \`convert_quantity\` converts. Lengths in manufacturing commands are document length units; angles degrees.
- **Materials.** \`define_material_record\` (designation, temper, form, specs, licence, export marking) →
  \`set_material_property\` (value or temperature table, \`basis\` A / B / S / typical / …, \`source.citation\`
  required, at most one \`preferred\` per key) → \`assign_material\` → \`mass_properties\` (massG / massKg /
  massLb + densitySource). Allowables: \`get_material_allowable\` never substitutes a basis and never
  extrapolates; \`forCertification: true\` refuses typical, unverified and superseded values. Libraries:
  \`import_material_library\`, \`diff_material_libraries\`; private (licensed) libraries are imported by
  reference and filled by \`resolve_material_libraries\` on an exact sha256 match — their values never
  enter saved files. Readiness: \`check_materials\`. ITAR / EAR-marked content refuses exports
  (MAT_EXPORT_CONTROLLED); an agent cannot confirm the export (MAT_HUMAN_GATE).
- **Fasteners.** \`import_fastener_catalog\` (your licensed catalogue file) → \`list_fastener_families\` /
  \`decode_part_number\` → \`select_fastener\` (grip, washers ≤ 1/8 in, protrusion ≥ one thread; data.rules
  names every default) → \`insert_fastener_stack\` / \`insert_fastener_row\` (one feature step: hole cut,
  one component per part number, instances) → \`check_fastener_layout\` → \`bill_of_materials\`
  (standardParts, \`includeMaterials\`). Delete with \`delete_fastener_stack\`, never \`delete_entities\`.
- **Machined features.** \`add_hole\` (simple / counterbore / countersink / counterdrill; through_all,
  up_to_next, up_to_face or blind with a 118° point reported as defaulted; face picked by \`face.near\`),
  \`add_pocket\` (islands, \`upToFace\`, \`open\`), \`add_rib\`, \`set_thread\` (cosmetic),
  \`hole_table\`, \`check_machining\` (thresholds are data with a source; missing ones are skipped and
  listed). \`recognize_features\` needs an exact kernel (\`--kernel occt-native\`); imported parts come from
  \`import_step_exact\`; \`holes_from_recognition\` turns their holes into \`add_hole\` plan steps.
- **Sheet metal.** \`sheet_metal_calc\` (no part; K-factor explicit, or mode faa_empirical) →
  \`create_sheet_metal_rule\` (material, thickness, inside radius, K; no defaults) →
  \`import_bend_radius_table\` (every row needs its source) → \`add_sheet_metal_base\` (closed profile) →
  \`add_flange\` (angle = angle bent through; cuts the rule relief itself) / \`add_contour_flange\` (multi-bend profile) /
  \`add_hem\` / \`add_joggle\` / \`add_sheet_cutout\` / \`add_relief\` / \`add_corner_relief\` / \`add_flanged_hole\` / \`add_bead\` →
  \`check_sheet_metal\` → \`flat_pattern\` → \`export_flat_pattern_dxf --save blank.dxf\`. Existing exact
  solids: \`convert_to_sheet_metal\`. Waivers stay FTR_WAIVER_NOT_APPROVED until a human approval exists.

## 9. Topology optimization (toolset analysis)

A topology result is a concept shape computed by llull, never a released design: say what an engineer must check.

- **Set-up.** \`create_analysis\` (static) → \`set_part_idealization\` (the solid, one material with E and nu) → \`add_fea_constraint\` +
  \`add_fea_load\` (force loads only) → \`create_topology_study\` (\`voxel\` and lengths in document units, \`volumeFraction\` 0.7 = 30 % lighter,
  dimension 2 = plate layout on a plane, 3 = voxel solid) → optional \`set_topology_regions\` (keepIn bosses and interfaces, keepOut clearances;
  load and support layers are protected by default) and \`set_topology_settings\` (named defaults: penal 3, move 0.2, filter radius 1.5 voxels).
- **Solve.** \`llull topology_solve studyId=ID --progress\` (\`timeoutS\` default 1800, \`resumeFromLast=true\` continues the last finished run,
  \`device=cpu|gpu|auto\`) runs the native \`llull-compute topopt\` (2D studies up to 2000 voxels also solve in TypeScript when it is missing; else
  TOP_TOOL_MISSING) and records the result with \`record_topology_result\`. Never write a result by hand: the numbers are recomputed from the stored field.
  Units are the analysis unit system (E in its stress unit, forces in its force unit, compliance in force x length).
  \`topology_report\` shows state (unsolved | solved | stale | missing | untrusted), compliance, volume fraction, grey level.
- **Rebuild.** The derived solid on layer layer-topology is read-only (TOP_DERIVED_READ_ONLY). \`suggest_rebuild\` gives closed loops (outer
  counter-clockwise, holes clockwise) → \`extrude_profile\` (profile = the points, placement from the answer) for the outer loop, each hole with
  \`extrude_profile\` + \`boolean\` subtract, \`fillet_edge\` on sharp corners → analyse the rebuild → \`compare_to_topology\` (IoU against the optimum).
- **Finish.** \`check_topology\` with \`rebuildEntityIds\` (and \`release\` for ids about to be released: iso-surfaces are TOP_RESULT_NOT_RELEASABLE).
  Any change to the study, the analysis or the geometry makes the result stale (TOP_RESULT_STALE): solve again.

## 10. Material laws (toolsets materials, material-lab)

Laws are data on a document material (\`create_material\` name), never in the solver. Every fit and result is unverified until a source and a reviewer exist.

- **Define.** \`add_material_model\` (elastic, j2_plasticity, hill48_plasticity, ramberg_osgood, hyper_* neo_hooke / mooney_rivlin / polynomial / yeoh / ogden / arruda_boyce,
  visco_prony, creep, rate; durability laws too) states HOW it is written (Ogden convention, Ramberg-Osgood \`form\`, curve inputMeasure, modulusKind, Hill
  \`form\`): none is defaulted. \`define_constitutive_set\` combines models; \`check_material_models\` lists readiness.
- **Fit.** \`fit_material_model\` returns a model, never edits the document: linear laws by exact QR, hyper_ogden / hyper_arruda_boyce / visco_prony with free times /
  ramberg_osgood form true_stress / j2_voce / j2_chaboche / creep_garofalo by Levenberg-Marquardt (\`start\`, \`bounds\`; data.convergence has iterations, cost,
  Jacobian conditioning). Refusals: MATL_FIT_DID_NOT_CONVERGE, MATL_FIT_ILL_CONDITIONED, MATL_FIT_START_INVALID. Pass data.model / validity / fit to \`add_material_model\`.
- **Drive.** \`material_point_response\` (small strain: elastic, J2, Hill, Prony, creep; finite: incompressible modes or compressible general paths with D1 > 0).
  \`export_material_cards\` writes CalculiX / Nastran cards and refuses laws they cannot represent (MATL_EXPORT_UNSUPPORTED).
- **MFront (optional).** The CLI tool mtest_run (not a registry command) runs an MTest script on a behaviour outside this set. MFront is NOT bundled: install it yourself, set LLULL_MTEST (and LLULL_MFRONT
  to compile) and LLULL_ALLOW_CODE_EXECUTION=1; absent tools answer MFRONT_TOOL_MISSING with the reason. \`llull mtest_run probe=true\` reports what was found.

## 11. Structural analysis (FEA, toolset analysis)

llull sets up, meshes and solves (CalculiX) and reports numbers; it never approves a design. Say what an engineer must check.

- **Units.** The analysis unit system follows the document unit: mm -> N-mm-t-s (MPa), m -> N-m-kg-s (Pa), in -> lbf-in-slinch-s (psi). Lengths of targets
  and mesh sizes are in DOCUMENT units; loads, pressures and gravity are in the case unit system (N-mm-t-s: N, MPa, gravity 9810 mm/s^2). Result field names carry the unit.
- **Factors of safety.** \`create_analysis\` factors default to ultimate 1.5 (14 CFR 25.303) and yield 1.0 (25.305(a)); margin results name each factor with its source
  and a defaulted flag. When the user states a safety factor ("SF 2") set it there (\`factor\` = one number for both). Never invent a factor.
- **Minimal static plan.** \`create_analysis\` → \`set_part_idealization\` (the solid) → a material with E and nu (\`add_material_model\` + \`define_constitutive_set\`, then
  \`assign_material\`; add Ftu / Fty with \`define_property_model\` when margins are wanted) → \`add_fea_constraint\` + \`add_fea_load\` (a moment may carry
  \`referencePoint\`) → \`set_mesh_controls\` → transports \`llull fea_mesh analysisId=ID\` then \`llull fea_solve analysisId=ID\` (they run the mesher / solver and record the
  artifacts) → \`analysis_report\` / \`compute_margins\`. \`set_result_view\` picks the field the desktop app shows; \`fea_result_field\` reads node values from the verified results.
- **Shells.** \`set_part_idealization\` with idealization=shell, thickness=… (default: the wall thickness found), offset=mid|top|bottom; preview the surface with
  \`extract_midsurface\`; mesh with \`set_mesh_controls\` elementFamily=shell_tri or shell_quad.
- **Modal / buckling.** analysisType modal or buckling with \`modes\`; a buckling case multiplies its first non-preload load case, and \`set_buckling_preload\` names a constant
  preload case applied first (the Nastran export refuses preloads).
- **Exports.** \`llull fea_export analysisId=ID format=calculix_inp|nastran_bdf|vtu --save FILE\` writes the deck or a VTU (mesh + results) and runs nothing.
- **Margins and the human gate.** \`compute_margins\` reads the verified results (stale or missing artifacts are refused; run fea_mesh and fea_solve again). Use \`set_margin_band\` for
  a MARGINAL band (no default). FAIL / MARGINAL rows are disposition pending_human: only a qualified human can \`dispose_margin\` them, an agent always gets FEA_HUMAN_GATE: hand the
  row over, never retry or work around it. A disposition never turns a FAIL into a PASS.
- **Singularities.** Nodes within a radius of point / edge loads and supports are excluded from the part rows and listed in separate singular rows that never count towards minMs.
  Default radius = 2 x mesh globalSize (named llull default); override with singularityRadius (document units, 0 = none) which REQUIRES singularityNote (your justification).
  Re-entrant corners and sharp edges are NOT screened: judge them yourself.
- **Finish.** Every FEA job ends with \`check_analysis\` and its items (stale results, unverified inputs, FEA_MS_NEGATIVE, pending dispositions) reported to the user.

## 12. Data exchange (STEP AP242 / IGES, toolset exchange)

llull receives and delivers exact geometry; the checks below tell an engineer what to trust.

- **Receive.** \`llull verify_exchange_file file=part.stp\` first: schema, length unit with its exact factor to millimetres (\`data.unitFactor\`, 25.4 for inch), entity census and the validation
  properties (GVP: volume, surface area, centroid) the sender embedded. With the exact kernel it also compares them with the recomputed geometry. Then \`llull import_step_exact file=part.stp\`
  (an assembly keeps its structure: one component per product, one instance per placed occurrence; \`assembly: false\` flattens) or \`llull import_iges file=part.igs\` (faces are sewn at
  max(file resolution, 1e-6 x diagonal); \`data.iges\` lists open shells and untranslated entity types).
- **Bands.** green: delta <= 1e-3 relative and <= 1e-3 x bounding-box diagonal; yellow: <= 1e-2 and <= 1 mm (CATIA default); red: beyond; not-checkable: the sender gave none or all zero
  (a placeholder). Yellow: report the numbers to the owner. Red or not-checkable: the bodies are marked unverified (\`doc.exchange.provenance\`), reviewRequired is true, and delivery needs a human.
  The import always completes; verify_exchange_file exits 1 on red. Never hide a red or not-checkable band from the user.
- **Deliver.** \`llull export_step_ap242 --save part.stp\` (schema ap242 by default, ap214 / ap203 on request) writes products, placed occurrences, names, colours, layers, materials and the validation
  properties of every product and the root assembly, in the DOCUMENT unit (numbers are not converted; the file says the unit), then re-reads them (\`data.selfCheck\` must be green). Pass \`timestamp\`
  for a reproducible header; the same document and timestamp give identical bytes. \`llull export_iges --save part.igs\` writes B-rep solids (mode faces for legacy CAM). \`export_step_ap242\` with schema ap214 and includeValidationProperties false
  is the simple AP214 form (without validation properties, PMI or self-check; import_step_exact format iges reads an IGES file without the IGES census). Exporting bodies that were imported red or not-checkable (or ply solids written from triangles) needs \`acceptUnverified\` with a human signature on export_step_ap242 and export_iges alike: an agent gets XCH_HUMAN_GATE and hands the request over.
- **Minimal sequence.** verify_exchange_file, import_step_exact (read \`data.report.exchange\` and reviewRequired), model, geometric_validation_properties (the values that will be embedded),
  export_step_ap242, then verify_exchange_file on the written file.
## 13. Structural dynamics: frequency and random response (toolset analysis, PHY-09)

g = 9.80665 m/s^2; ASD levels in g^2/Hz; frequencies in Hz. There is NO default damping and no default modal truncation rule; the 3-sigma
peak factor is a named default stated in every result; Miles' equation is a quick check, never the answer of record.

- **Quick checks first (no solver).** \`define_vibration_spectrum\` (points + source, or library gevs_component_qual / gevs_component_accept: grade B,
  results stay unverified) → \`psd_rms\` (grms) → \`sdof_response\` (fnHz + zeta or Q: exact rms and Miles beside it) → \`damping_coefficients\`
  (Rayleigh alpha / beta from two ratios) → \`shock_response_spectrum\` (half-sine or sampled history, Q).
- **Random vibration plan.** \`create_analysis\` analysisType random_response with modes (enough to pass 1.5 x the top of the band) →
  \`set_part_idealization\` → \`add_fea_constraint\` fixed on the base faces → \`set_dynamic_damping\` (cited) → \`set_base_excitation\` (direction +
  spectrum) → \`set_frequency_sweep\` → \`add_result_probe\` (a_x/y/z in g, u_x/y/z_rel, s_xx/yy/zz) → \`check_structural_dynamics\` (no error) →
  the fea_mesh and fea_solve transports (modes by CalculiX, response by llull; the nodal rms field runs in llull-compute when installed) →
  \`analysis_report\` view dynamic → \`equivalent_static_load_case\` into a static case → \`compute_margins\` → \`check_structural_dynamics\`.
  frequency_response: same set-up with loads or \`set_base_excitation\` amplitudeG; \`analysis_report\` view dynamic gives the peaks and half-power Q.
- Report results as "computed by llull, not approved": every dynamic result carries reviewRequired and its unverified reasons.

## 14. Fillets, chamfers and blends (toolset 3d, measure)

Blends need the exact native kernel (\`kernel_info\`); the mesh kernel refuses them and leaves the document unchanged. Sizes are document units, angles of
\`chamfer_edge\` are degrees. Pick edges by \`edgesNear\` points (an edge mid point from \`inspect_topology\`) or \`edgeNames\`: the step records persistent names, so a later
\`edit_step_params\` of the box re-rounds the same edge (REF_LOST / REF_SPLIT when the name is gone).

**Which command**

| Need | Command |
| ---- | ------- |
| round an edge, constant radius | \`fillet_edge\` with \`radius\` |
| the largest radius an edge accepts, BEFORE rounding | \`probe_fillet\` (maxRadius per edge) |
| radius that varies along the edge | \`fillet_edge\` \`radiusEnd\`, or \`edges: [{ near, size, sizeEnd, sizes, interpolation, law }]\`; "linear" is a straight transition, the default is smooth with flat ends |
| size by the chord between the contact lines | \`fillet_edge\` \`mode: "chord"\` |
| conic or curvature-continuous (G2 to planes) section, asymmetric legs | \`fillet_edge\` \`profile: { type: "conic", rho }\` / \`{ type: "curvature", shape }\`; asymmetric legs \`edges: [{ near, size, size2, side1Near }]\` |
| a vertex of 4+ rounded edges, or a patch you control | \`fillet_edge\` \`corners: [{ near: <vertex>, type: "setback", setback }]\` (straight edges between planar faces, constant or linear radius) |
| blend two face sets (several faces, curved faces, faces that share an edge) | \`fillet_faces\` \`facesA\` / \`facesB\` with \`radius\`, \`width\`, \`law\` or \`holdLine\` |
| half-round on the top of a rib | \`fillet_full_round\` \`side1\` / \`center\` / \`side2\` |
| bevel | \`chamfer_edge\` \`distance\`; \`distance2\` or \`angleDeg\` with \`side1Near\`; \`distanceEnd\` for a distance that runs along the edge |
| weld solids and round the joints | \`blend_union\` \`radius\`, \`joints: [{ near, radius }]\` for joints with their own radius |
| prove it | \`check_blends\` after every blend |

**Laws.** \`t\` runs 0..1 along the picked edge from its start point (\`inspect_topology\` lists start and end; \`fillet_faces\` has \`startNear\`). A radius on a closed edge (a rim)
must close on itself (BLD_LAW_NOT_PERIODIC). A variable radius needs one edge, not a chain. **Profiles** keep the contact lines of the circular fillet of the same size; the
result reports the measured gap. **Corners:** the default is the kernel rolling ball; a setback corner stops each blend that far from the vertex (at least the reported minimum)
and fills the corner with a G1 patch. Profile blends, setback patches and \`blend_union\` radii are held to the \`check_blends\` defaults when they are built (G0 1e-6 x diagonal, G1 0.01 rad; patches and re-skinned profiles 5 x the gap). Known exception: two circular \`fillet_edge\` steps on a box can read BLD_CHECK_G1_ANGLE (about 0.029 rad) where the second blend meets the first.

**Main refusals** (the document is unchanged; the error carries a code, the param paths and a remediation)

| Code | Do |
| ---- | -- |
| BLD_RADIUS_TOO_LARGE | use the largest radius named in the message, or \`probe_fillet\` it |
| BLD_WALKING_FAILURE, BLD_TWISTED_SURFACE | smaller radius, smoother law, or round fewer edges per step |
| BLD_CORNER_UNSUPPORTED, BLD_CORNER_FAILED | give the vertex a setback corner, or round fewer of the edges that meet there |
| BLD_SETBACK_TOO_SHORT | setback larger than the reported minimum |
| BLD_PROFILE_FAILED | the reason says which condition fails; try the circular profile, a smaller size, or a conic closer to rho 0.4142 |
| BLD_LAW_INVALID, BLD_RHO_RANGE, BLD_SHAPE_RANGE, BLD_CHAMFER_PARAMS | fix the param named in the error paths |
| BLD_CHAMFER_VARIABLE_PARAMS | \`distanceEnd\` > 0, no \`distance2\` / \`angleDeg\`, edges listed |
| BLD_CHAMFER_FAILED | variable chamfer: smaller distances, unlist edges that share a vertex, or a constant chamfer (no \`distanceEnd\`) |
| BLD_JOINT_PARAMS | \`blend_union\` \`joints\`: radius > 0, one radius per tangent chain, each point within 10 x its radius of a joint |
| BLD_ASYMMETRIC_SIDE_MISSING | add \`side1Near\` (a point on the face that carries the first size) |
| BLD_FACESET_EMPTY, BLD_FACESETS_OVERLAP | pick points on the faces (\`inspect_topology\`), no face in both sets |
| BLD_FACE_FILLET_NO_SOLUTION | use at least the reported radius, or a width |
| BLD_FACE_BLEND_UNSUPPORTED | the blend would round a face outside the sets (add it), or the shape is not built: the message names what |

**Worked plan** (\`llull run plan.json\`, native kernel): probe, round with a varying radius, bevel with a varying distance, a conic round, and check each.

\`\`\`json
{ "actions": [
  { "command": "add_box", "params": { "size": [20, 10, 5] }, "as": "b" },
  { "command": "probe_fillet", "params": { "id": "$b", "edgesNear": [[0, 5, 2.5]] } },
  { "command": "fillet_edge", "params": { "id": "$b", "edgesNear": [[0, 5, 2.5]], "radius": 1, "radiusEnd": 2 }, "as": "f" },
  { "command": "check_blends", "params": { "ids": ["$f"] } },
  { "command": "add_box", "params": { "size": [20, 10, 5] }, "as": "c" },
  { "command": "chamfer_edge", "params": { "id": "$c", "edgesNear": [[0, 5, 2.5]], "distance": 1, "distanceEnd": 2 }, "as": "ch" },
  { "command": "add_box", "params": { "size": [20, 10, 5] }, "as": "d" },
  { "command": "fillet_edge", "params": { "id": "$d", "edgesNear": [[0, 5, 2.5]], "radius": 1, "profile": { "type": "conic", "rho": 0.5 } }, "as": "p" },
  { "command": "check_blends", "params": { "ids": ["$p"], "require": "G1" } }
] }
\`\`\`

Read \`check_blends\`: \`status\` pass / warn / fail, per blend face the contacts (gap, \`g1AngleRad\`, \`order\`) and the realised radius, and coded findings (BLD_CHECK_*). A circular
fillet is G1 to a plane, never G2: ask for \`require: "G2"\` only with a curvature profile. Not offered (no param exists): partial fillets, cliff / trim modes of face blends, G3 blends.
`;
