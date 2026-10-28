# 08 ASC — Assembly scale: large patterned assemblies, connections, design modules — Functional specification

Status: specification only (2026-10-28). Nothing in this pack is built. Gap id `ASC`. Template:
[`../../aerospace/TEMPLATE.md`](../../aerospace/TEMPLATE.md); operator model: [`../../aerospace/AGENT_FIRST.md`](../../aerospace/AGENT_FIRST.md).

## 1. Summary

An agent built a 2,450-part CFM56-5B4 turbofan cutaway in llull (15 `.lld` modules, native OCCT kernel) and made it
interference-free: 0 overlaps, 0 floating parts, rotors carried only by bearings, checked with `check_assembly`. Doing
so exposed ten limits. Each one forced a workaround, cost hours, or made a correct model impossible to prove:

| # | Limit hit | Workaround used | Cost |
| - | --------- | --------------- | ---- |
| 1 | One `boolean union` of a disk with 36 lofted blades takes 26 s and is killed at the 30 s kernel timeout; cost is superlinear (4 tools 1.7 s, 12 tools 4.3 s, 36 tools 26.4 s) | gave up whole-row unions; blade "units" (blade + own platform) arrayed instead | redesign of every bladed module |
| 2 | `check_assembly` refuses more than 500 parts; 175 parts take 269–283 s | check unique parts plus each array's master and first copy, by hand | trust gap: the full model is never checked |
| 3 | Bolted joints are touching faces only: every part is `FPR_PART_RESTING_ONLY`; declaring a rigid connection is one `allow_interference` per pair | left 174 warnings | the check cannot say "this assembly holds together" |
| 4 | `array_polar` / `array_linear` make full copies; no instance mode | none | 2,450 entities, 2,450 meshes |
| 5 | `.lld` has no modules: per-module files are joined by an external script | `assemble.mjs` concatenation | no scoping, no parameter passing |
| 6 | `.lld` JSON object values are verbatim: no alias, no parameter inside `sections=[{…}]` | `loft_sections` through polylines instead of `create_wing` | lost the exact wing path |
| 7 | `.lld` cannot build a list from a formula, has no functions and no conditional | stepped casing profiles generated outside llull and pasted as literals; `min(k,1)` as an `if` | rounded literals caused 0.002 mm gaps that `check_assembly` flagged |
| 8 | A bare alias passed to a `string \| string[]` parameter silently means its first id only (`boolean b=tools` used 1 of 4 tools) | always write `[alias]` | silent wrong geometry |
| 9 | Fidelity: a rotated revolve's bounding box reaches 1.17–1.37× its radius; a ruled loft through rectangles has rounded corners and non-planar faces (up to 0.21 mm) | checks moved to unrotated parts; pylon rebuilt as an extrusion | wrong measurements, false clashes |
| 10 | Agent visibility: `render_view` decimates scenes above its polygon budget into fragments; no CLI command captures the GPU viewport of the desktop app | screen grab through the OS (once sent a keystroke to the wrong window) | the agent cannot see the model it built |

Plus two installer defects found on the same day: `npm --prefix desktop run dist` packs the whole repository (16 GB
unpacked, 7-Zip fails) because `desktop/` and `server/` depend on `"llull": "file:.."`, and `prepare-python` breaks on
Windows when Git's `tar` is first on `PATH`.

This pack specifies how to remove all of them, so that an agent can build, check, see and export an assembly of
10,000+ parts, most of them patterned, with a proof that it holds together.

## 2. Context and value

- **Who needs it.** Every large mechanical assembly is patterned: turbomachinery (blade rows of 36–120 blades, stage
  after stage), gearboxes, bearings, bolted flanges (24–96 bolts), heat exchangers (thousands of tubes), building
  structures (repeated bays). The source model of this pack is an A320 engine; the same limits block a gearbox or a
  plant skid.
- **How incumbent tools do it.**
  - Patterns stay instances that reference one definition: SOLIDWORKS pattern-driven component patterns [R10],
    Onshape Replicate [R12], STEP `next_assembly_usage_occurrence` [R20].
  - Patterned geometry is copied instead of regenerated: Onshape face and feature patterns "with no feature
    regeneration" [R15], SOLIDWORKS Geometry Pattern [R16].
  - Connections are semantic data on groups, not per face pair: Onshape fastened mate and Group, with a ~250-mate
    performance warning [R11]; Fusion as-built joints and rigid groups [R13]; NX Fix and Bond [R14]; Creo rigid bodies
    [R17]; Ansys connection groups that auto-detect contacts as Bonded [R18].
  - Interference tools ignore touching faces by default and class fasteners apart: SOLIDWORKS "treat coincidence as
    interference" and "create fasteners folder" [R9].
- **How code-CAD languages do it.**
  - Scoped modules: OpenSCAD `use` vs `include` [R22]; KCL `export` / `import … as` with acyclic imports evaluated once [R23].
  - List comprehensions and functions: OpenSCAD [R24], KCL `map` / `reduce` [R25], Jsonnet [R27].
  - Typed array parameters with per-item checks: FeatureScript [R26], KCL `[T; n+]` [R23].
  - Hermetic, hash-frozen imports: Dhall [R28].
- **Why llull must close the gap.** The agent-first model ([`../../aerospace/AGENT_FIRST.md`](../../aerospace/AGENT_FIRST.md))
  only works if the agent can (a) express a patterned design compactly, (b) regenerate it in seconds, (c) prove it with
  a check, and (d) see it. Today (a) needs an external script, (b) times out, (c) is capped at 500 parts and cannot
  express joints, and (d) shows fragments.

## 3. Personas and user stories

- **Agent (operator, CLI).**
  - US-1: "I write one `.lld` per engine module, `use` it from a top design with parameters, and every module gets its own layer and group."
  - US-2: "I pattern a blade unit 80 times as instances; the fuse of the whole row takes seconds, not a timeout."
  - US-3: "I declare once that a blade row is bolted to its disk; the check counts it as connected."
  - US-4: "I run `check_assembly` on 10,000 parts and get the result in about a minute, with each patterned pair checked once."
  - US-5: "I capture the desktop viewport to a PNG to see what I built."
- **Owner (non-engineer).**
  - US-6: "I ask for an engine and get one that is proven not to overlap, and I can see it."
  - US-7: "Building the installer works on my Windows machine."
- **Qualified reviewer.**
  - US-8: "I see which joints are declared (bolted, welded, bonded), on which parts, and why; `check_assembly` lists them."

## 4. Scope

| Phase | Content |
| ----- | ------- |
| **MVP** | M0 installer fixes · M1 kernel boolean performance (one General Fuse call, parallel / OBB, progress and cancel instead of kill) · M4a `.lld` strict reference typing and expression indexing · M6a `capture_viewport` |
| **V1** | M1b pattern-aware fuse · M2 instance patterns (render instancing, STEP and glTF instancing) · M3 assembly check at scale (broad phase, mesh narrow phase, parallel, symmetry reduction, cache) and connection groups · M4b value grammar, comprehensions, conditionals, functions · M5 fidelity (tight boxes, exact ruled polygon lofts) |
| **V2** | M4c scoped `.lld` modules with typed parameters and content hashes · M6b `render_view` routed to the GPU above budget · incremental re-check in agent loops |
| Out of scope | Kinematic solving of joints (exists separately: dynamics plugin); fastener libraries and smart fasteners (future pack); full STEP AP242 kinematics export |

## 5. Functional requirements

| Id | Pri | Requirement | Rationale | Source |
| -- | --- | ----------- | --------- | ------ |
| FR-ASC-01 | MUST | `npm --prefix desktop run dist` produces a Windows installer from a clean checkout without packing repository folders (no `solver/target`, no `desktop/build/cargo-target`, no `coverage`). Unpacked app ≤ 1.5 GB | installer failed: 16 GB unpacked, 7-Zip exit 8 | measured 2026-10-28 |
| FR-ASC-02 | MUST | `prepare-python` extracts the bundled Python on Windows whatever `tar` comes first on `PATH` | Git `tar` reads `C:\…` as a remote host | measured 2026-10-28 |
| FR-ASC-03 | MUST | A union or subtract of one body with N disjoint tools runs as one kernel operation. Its time grows no worse than linearly in N for disjoint tools of similar size; 36 lofted blades on a disk ≤ 10 s on the reference machine | 26.4 s today, killed at 30 s with a shroud ring | measured; [R1] |
| FR-ASC-04 | MUST | A long kernel operation reports progress and is cancelled cleanly at its deadline: a named refusal `KRN_TIMEOUT` with the stage reached, never a killed worker returning null | today: worker killed, `kernel returned null` | [R5][R6] |
| FR-ASC-05 | SHOULD | A rigid pattern of a tool around a body (same tool, rotated or translated copies, all overlapping the body the same way) is fused by computing one sector and replicating it; time independent of N | pattern features copy geometry in commercial CAD | [R15][R16] |
| FR-ASC-06 | MUST | `array_polar` and `array_linear` can create instances of one definition (`as: "instances"`) instead of copies; instances stay parametric (re-derived from the pattern step) | full copies today | [R10][R12][R20] |
| FR-ASC-07 | MUST | Instances render with GPU instancing (one draw per definition and material), select individually, and export as STEP occurrences and glTF `EXT_mesh_gpu_instancing` | 2,450 meshes today | [R19][R21][R20] |
| FR-ASC-08 | MUST | `check_assembly` accepts at least 10,000 parts; 2,450 parts complete in ≤ 60 s on the reference machine | cap 500; 175 parts in 269–283 s | measured |
| FR-ASC-09 | MUST | Pattern-aware checking: for N rigid copies the check evaluates each distinct relative position once (master vs copy k, k = 1…⌊N/2⌋, stopping when boxes no longer meet) and reports the result for every copy | O(N²) → O(N) pairs | symmetry argument; [R2] |
| FR-ASC-10 | MUST | Connection groups: one command declares a rigid connection (`bolted`, `bonded`, `welded`, `press_fit`, `thread`) over a set of parts (ids, a pattern, a layer, a group), optionally only for parts that touch within a tolerance. Grouped parts count as connected; no `RESTING_ONLY` for them | 174 warnings, per-pair intents only | [R11][R13][R14][R18] |
| FR-ASC-11 | MUST | A connection declared on a pattern seed propagates to every instance of the pattern | Replicate / pattern-driven | [R10][R12] |
| FR-ASC-12 | SHOULD | Parts can be tagged `fastener`; fastener-to-host overlaps (threads) are reported in a separate class, not as clashes | SOLIDWORKS IsFastener | [R9] |
| FR-ASC-13 | SHOULD | Re-running `check_assembly` after an edit re-checks only pairs whose parts or relative placement changed | NX incremental clearance analysis | [R8] |
| FR-ASC-14 | MUST | `.lld`: a bare alias passed to a parameter that accepts one id or a list means **all** of its ids when it names several; passing a several-id alias to a one-id parameter is refused with `DESIGN_ALIAS_ARITY` and a fix | silent first-id today | [R23][R29] |
| FR-ASC-15 | MUST | `.lld`: alias indexing accepts expressions (`blade[i]`, `blade[i-1]`, `blade[-1]`) and ranges (`blade[0..<4]`) | integer literals only | [R23] |
| FR-ASC-16 | MUST | `.lld`: object and list values are `.lld` expressions: keys may be bare names, values may use parameters, loop variables and alias references; every element is validated against the command schema with a path (`sections[3].span`) | verbatim JSON today | [R26] |
| FR-ASC-17 | MUST | `.lld`: list comprehensions (`[for i in 0..<n: expr]`, optional `if` filter), inclusive and exclusive ranges, `if … then … else …`, `let … in …`, and the built-ins `len`, `sum`, `concat`, `zip`, `linspace` | stepped profiles pasted as literals | [R24][R27] |
| FR-ASC-18 | SHOULD | `.lld`: pure user functions `fn name(a, b = 2) = expr` (no commands inside, no recursion) | repeated flowpath formulas in 30 places | [R22][R25] |
| FR-ASC-19 | SHOULD | `.lld`: scoped modules: `use "fan.lld" as fan with D=1735` runs a module with typed parameters, namespaces its aliases (`fan.rotor`), exposes only `export`ed names, and puts its parts on its own layer and group. Imports are relative to the root design, acyclic, evaluated once per argument set, and recorded with their content hash in the recipe step so the document replays without the files | external concatenation today | [R22][R23][R28] |
| FR-ASC-20 | SHOULD | `.lld`: `llull expand_design` prints the fully expanded command list with resolved ids and values | the agent verifies what will run | [R23] |
| FR-ASC-21 | MUST | A command that creates both a record and an entity (e.g. `airfoil_from_naca`) exposes both to `.lld`: `af` = the record, `af.entity` = the created curve, so `loft_sections sectionIds=[af0.entity, …]` works with exact curves | alias names the record only | code survey |
| FR-ASC-22 | MUST | `measure_bounding_box` returns the exact (optimal) box of any rotated solid, within 1e-6 of the model size | 1.37× radius on a rotated revolve | [R7]; measured |
| FR-ASC-23 | MUST | A ruled `loft_sections` through polygon sections (rectangle, closed polyline) keeps every corner and gives planar side faces when corresponding edges are coplanar | Catmull-Rom rounding, 0.1–0.2 mm deviation | code survey; measured |
| FR-ASC-24 | MUST | `capture_viewport` (with `--app`) renders the open desktop viewport at a given camera and size and saves a PNG, without changing the user's camera or document and without OS-level window focus | no capture command; OS screen grab sent a keystroke to another window | [R30] |
| FR-ASC-25 | SHOULD | `render_view` never returns a fragmented image: above its polygon budget it routes to the GPU path (desktop or native raster) or reports `RENDER_BUDGET_EXCEEDED` with the share of polygons drawn | fragmented images today | measured |
| FR-ASC-26 | MUST | All new checks and refusals use stable codes (§7 of the technical spec), work offline, and are deterministic | AF-11, AF-13, AF-41 | AGENT_FIRST |

## 6. Workflows

**CLI first (agent).**

```text
# 1. modular design
llull apply_design source=@text:engine.lld --app          # engine.lld uses fan.lld, hpc.lld, … (FR-ASC-19)
# 2. patterned rows as instances, bolted to their disks
#    in hpc.lld:
#      array_polar blades id=blade count=n as="instances"            (FR-ASC-06)
#      add_connection_group rotor kind="bolted" members=[disk, blades] (FR-ASC-10/11)
# 3. prove it
llull check_assembly --app --json                          # 10,000 parts, symmetry-reduced (FR-ASC-08/09)
# 4. see it
llull capture_viewport view=iso width=1600 height=1000 --save engine.png --app   (FR-ASC-24)
# 5. ship it
llull export_step_ap242 --save engine.step --app           # occurrences, not copies (FR-ASC-07)
```

**UI (review).** Instances highlight as a set and individually; the Connections panel lists groups with kind, members
and reason; `check_assembly` results open with the pair highlighted.

## 7. Acceptance criteria

| Given | When | Then | VC |
| ----- | ---- | ---- | -- |
| a clean checkout on Windows 11 | `npm --prefix desktop run dist` | one NSIS installer, unpacked app ≤ 1.5 GB, no repo folder inside `resources` | VC-ASC-01, 02 |
| a disk and 36 lofted blades | `boolean op=union a=disk b=[blades]` | one solid in ≤ 10 s, volume = disk + blades − overlaps (± 1e-6 rel.) | VC-ASC-03, 04 |
| a kernel op that cannot finish in its deadline | it runs | `KRN_TIMEOUT` with the stage reached; the worker stays alive | VC-ASC-05 |
| a rigid pattern of 80 blades on a disk | pattern-aware fuse | result identical (volume, face count) to the full fuse; time within 2× of one blade | VC-ASC-06 |
| `array_polar … as="instances"` of 80 | render, select, export STEP | one draw call per definition; picking returns the instance; STEP has 80 occurrences of one product | VC-ASC-07, 08, 09 |
| the 2,450-part turbofan | `check_assembly` | all parts checked in ≤ 60 s; same findings as the 175-part representative check | VC-ASC-10, 11 |
| blade units, a disk, one `add_connection_group kind=bolted` | `check_assembly` | no `RESTING_ONLY` for the group; group listed with kind and reason | VC-ASC-12, 13 |
| `boolean b=tools` where `tools` names 4 ids | apply design | 4 tools used; `cut a=x b=tools` on a one-id param → `DESIGN_ALIAS_ARITY` | VC-ASC-14 |
| `sections=[for k in 0..<3: {airfoilId: af[k], span: k*290}]` | apply design | `create_wing` receives 3 sections with resolved ids | VC-ASC-15, 16 |
| a stepped casing profile written as a comprehension | apply design | identical to the literal profile, and blade platforms touch it with 0 overlap | VC-ASC-17 |
| `use "fan.lld" as fan with D=1735` twice with different D | apply design | two namespaced modules, own layers and groups; recipe records both hashes; replay works with the files deleted | VC-ASC-18, 19 |
| a revolve rotated about X | `measure_bounding_box` | radius exact within 1e-6 | VC-ASC-20 |
| a ruled loft through rectangles | inspect faces | planar side faces, sharp corners; mounts touching its underside report touch, not overlap | VC-ASC-21 |
| the app open with a model | `capture_viewport --save x.png --app` | PNG of the requested size; user camera unchanged | VC-ASC-22 |
| a 1 M polygon scene | `render_view` | GPU route or `RENDER_BUDGET_EXCEEDED`; never a fragmented image | VC-ASC-23 |

## 8. Standards alignment

- STEP AP242 (ISO 10303-242): assembly occurrences (`next_assembly_usage_occurrence`, `mapped_item`) for instances
  [R20]; assembly constraints `binary_assembly_constraint` exist [R31]. No dedicated fastener entity was found, so
  fasteners export as parts. Kinematic export follows the CAx-IF practice [R32] in a later pack.
- glTF 2.0 `EXT_mesh_gpu_instancing` for instanced export [R21].

## 9. KPIs

| KPI | Today | Target |
| --- | ----- | ------ |
| Turbofan full rebuild (`apply_design`, 2,450 parts) | 12 s | ≤ 12 s with instances, ≤ 20 s with whole-row fuses |
| Union of 36 blades on a disk | 26.4 s (killed with a shroud) | ≤ 10 s (one GF call), ≤ 1 s pattern-aware |
| `check_assembly` | 500-part cap; 175 parts in 269–283 s | 10,000 parts; 2,450 in ≤ 60 s |
| Parts reported `RESTING_ONLY` on a correctly bolted model | 174 / 175 | 0 when groups are declared |
| External scripts needed to build a modular design | 1 (`assemble.mjs`) | 0 |
| Literal numbers pasted from outside llull | 3 stepped profiles (~90 points) | 0 |
| Agent sees the full model | fragments | full-fidelity PNG |
| Installer from clean checkout | fails | succeeds, ≤ 1.5 GB unpacked |

## 10. Risks and assumptions

- Multi-argument General Fuse is reported unreliable on some many-solid inputs [R3]: keep the tree path as a checked
  fallback (`BRepCheck_Analyzer`).
- Glue options are only valid for really coincident faces [R1]: use them only for the pattern-sector re-assembly,
  never for user booleans.
- Mesh narrow phase is approximate to the mesh deflection [R2]: every hard finding is confirmed exactly before it is
  reported.
- Instances change many code paths (booleans refuse instances today): instancing is opt-in per pattern until all
  commands accept instances.
- `.lld` grows: every extension must still expand to one flat command list in one recipe step (DESIGN_LANGUAGE §1),
  keep the language removable (§2), and stay total (no unbounded recursion).

## 11. References

See [`validation/sources.md`](validation/sources.md) for grades and what was taken from each.

- [R1] Boolean Operations specification — Open CASCADE — https://occt3d.com/dev/doc/overview/html/specification__boolean_operations.html (accessed 2026-10)
- [R2] BRepExtrema_ShapeProximity.hxx — Open CASCADE — https://eic-code-browser.sdcc.bnl.gov/lxr/source/include/opencascade/BRepExtrema_ShapeProximity.hxx (accessed 2026-10)
- [R3] Forum threads on multi-argument fuse — Open CASCADE — https://dev.opencascade.org/content/fuse-operation-problem-multiple-arguments-and-tools (accessed 2026-10)
- [R4] BRepAlgoAPI_BuilderAlgo.hxx — Open CASCADE — https://eic-code-browser.sdcc.bnl.gov/lxr/source/include/opencascade/BRepAlgoAPI_BuilderAlgo.hxx (accessed 2026-10)
- [R5] BOPAlgo_Algo reference (progress range, user break) — Open CASCADE — https://occt3d.com/dev/doc/refman/html/class_b_o_p_algo___algo.html (accessed 2026-10)
- [R6] Commit "Progress indicator for Boolean operations" — Open CASCADE — https://git.rbts.co/OpenCascade/occt/commit/7e785937b3e65df86f35364e1036e446d6339cec (accessed 2026-10)
- [R7] BRepBndLib.hxx (AddOptimal, AddOBB) — Open CASCADE — https://eic-code-browser.sdcc.bnl.gov/lxr/source/include/opencascade/BRepBndLib.hxx (accessed 2026-10)
- [R8] NX Open ClearanceSet API — Siemens — https://docs.plm.automation.siemens.com/data_services/resources/nx/12/nx_api/custom/en_US/open_c++_ref/a00888.html (accessed 2026-10)
- [R9] Interference Detection with Fasteners / Interference Detection PropertyManager — Dassault Systèmes — https://help.solidworks.com/2017/english/Solidworks/sldworks/c_Interference_Detection_with_Fasteners.htm ; https://help.solidworks.com/2024/english/SolidWorks/sldworks/HIDD_DVE_INTERFERENCE.htm (accessed 2026-10)
- [R10] Component Patterns — Dassault Systèmes — https://help.solidworks.com/2021/English/SolidWorks/sldworks/c_component_patterns.htm (accessed 2026-10)
- [R11] Fastened mate; Group vs Fasten tech tip — Onshape — https://cad.onshape.com/help/Content/Assembly/fastened_mate.htm ; https://www.onshape.com/en/resource-center/tech-tips/tech-tip-when-to-use-the-group-vs-fasten-features-in-onshape (accessed 2026-10)
- [R12] Replicate — Onshape — https://cad.onshape.com/help/Content/Assembly/replicate.htm (accessed 2026-10)
- [R13] As-built joint — Autodesk — https://help.autodesk.com/cloudhelp/ENU/Fusion-Assemble/files/ASM-AS-BUILT-JOINT.htm (accessed 2026-10)
- [R14] NXOpen.Positioning.ConstraintType — Siemens — https://docs.plm.automation.siemens.com/data_services/resources/nx/12/nx_api/custom/en_US/nxopen_python_ref/NXOpen.Positioning.ConstraintType.html (accessed 2026-10)
- [R15] Circular pattern help; faster patterns tech tip — Onshape — https://cad.onshape.com/help/Content/PartStudio/circular_pattern.htm ; https://www.onshape.com/en/resource-center/tech-tips/tech-tip-how-to-create-faster-patterns-in-onshape (accessed 2026-10)
- [R16] Geometry Pattern — Dassault Systèmes blog — https://blogs.solidworks.com/solidworksblog/2013/09/solidworks-geometry-pattern-a-simple-option-to-make-patterns-regenerate-faster.html (accessed 2026-10)
- [R17] Creating a mechanism model (rigid bodies, connections) — PTC — https://support.ptc.com/help/creo/creo_pma/r7.0/usascii/simulate/mech_des/overview/creating_model_mdx.html (accessed 2026-10)
- [R18] Connection Group; contact detection settings — Ansys — https://ansyshelp.ansys.com/public/Views/Secured/corp/v261/en/wb_sim/ds_connections_group.html ; https://ansyshelp.ansys.com/public/Views/Secured/corp/v261/en/wb_sim/ds_contact_ctrlpanel.html (accessed 2026-10)
- [R19] InstancedMesh; BatchedMesh — three.js — https://threejs.org/docs/pages/InstancedMesh.html ; https://threejs.org/docs/pages/BatchedMesh.html (accessed 2026-10)
- [R20] Item definition structure (NAUO, mapped_item) — STEP Tools — https://downloads.steptools.com/stds/smrl/data/modules/item_definition_structure/sys/f_guide.htm (accessed 2026-10)
- [R21] EXT_mesh_gpu_instancing — glTF-Transform / Cesium — https://gltf-transform.dev/modules/extensions/classes/EXTMeshGPUInstancing (accessed 2026-10)
- [R22] Include statement; user-defined functions and modules — OpenSCAD manual — https://en.wikibooks.org/wiki/OpenSCAD_User_Manual/Include_Statement ; https://en.wikibooks.org/wiki/OpenSCAD_User_Manual/User-Defined_Functions_and_Modules (accessed 2026-10)
- [R23] KCL modules, arrays, types — Zoo — https://zoo.dev/docs/kcl-lang/modules ; https://zoo.dev/docs/kcl-lang/arrays ; https://zoo.dev/docs/kcl-lang/types (accessed 2026-10)
- [R24] List comprehensions — OpenSCAD manual — https://en.wikibooks.org/wiki/OpenSCAD_User_Manual/List_Comprehensions (accessed 2026-10)
- [R25] map / reduce — Zoo KCL book — https://zoo.dev/docs/kcl-book/map_reduce.html (accessed 2026-10)
- [R26] FeatureScript UI specification (array parameters, preconditions) — Onshape — https://cad.onshape.com/FsDoc/uispec.html (accessed 2026-10)
- [R27] Jsonnet tutorial — Jsonnet — https://jsonnet.org/learning/tutorial.html (accessed 2026-10)
- [R28] Safety guarantees (frozen imports) — Dhall — https://docs.dhall-lang.org/discussions/Safety-guarantees.html (accessed 2026-10)
- [R29] GH_ParamAccess — McNeel — https://developer.rhino3d.com/api/grasshopper/html/T_Grasshopper_Kernel_GH_ParamAccess.htm (accessed 2026-10)
- [R30] webContents.capturePage; offscreen rendering — Electron — https://www.electronjs.org/docs/latest/api/web-contents ; https://www.electronjs.org/docs/latest/tutorial/offscreen-rendering (accessed 2026-10)
- [R31] binary_assembly_constraint — STEP Tools — https://downloads.steptools.com/docs/stp_aim/html/t_binary_assembly_constraint.html (accessed 2026-10)
- [R32] Recommended practice AP242 XML kinematics v1.3 — MBx-IF — https://www.mbx-if.org/home/wp-content/uploads/2025/10/rec_prac_ap242xml_kinematics_v1.3.pdf (accessed 2026-10)
