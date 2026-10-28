# 08 ASC — Sources

Grades: **A** primary source read (official docs, standard, header file) or measured in llull; **B** vendor or expert
secondary; **C** forum, located but not confirmed. Accessed 2026-10-28. "Measured" rows were run in llull on the owner's
workstation (native OCCT 7.9.2).

| Id | Source | URL | Taken | Grade |
| -- | ------ | --- | ----- | ----- |
| R1 | OCCT Boolean Operations specification | https://occt3d.com/dev/doc/overview/html/specification__boolean_operations.html | GF takes an unlimited number of arguments; Glue (Shift / Full) only for coinciding arguments, gains up to 90 %; fuzzy value; `SetUseOBB`; `SetCheckInverted(false)` up to 10 %; `SetNonDestructive`; CellsBuilder | A |
| R2 | BRepExtrema_ShapeProximity.hxx, BRepExtrema_SelfIntersection.hxx, BRepExtrema_DistShapeShape.hxx | https://eic-code-browser.sdcc.bnl.gov/lxr/source/include/opencascade/BRepExtrema_ShapeProximity.hxx | proximity on existing triangulations (tolerance 0 = intersecting faces); DistShapeShape `SetMultiThread`, progress range | A |
| R3 | OCCT forum: multi-argument fuse threads | https://dev.opencascade.org/content/fuse-operation-problem-multiple-arguments-and-tools ; https://dev.opencascade.org/content/slow-fuse-operation-solids | reports of invalid results on many-solid fuses (from about 35 solids); advice to fuse all at once | C |
| R4 | BRepAlgoAPI_BuilderAlgo.hxx / BRepAlgoAPI_Algo.hxx / BRepAlgoAPI_BooleanOperation.hxx | https://eic-code-browser.sdcc.bnl.gov/lxr/source/include/opencascade/BRepAlgoAPI_BuilderAlgo.hxx | `SetToFillHistory`, `SimplifyResult`, `SetRunParallel`; constructor with a precomputed `BOPAlgo_PaveFiller`; `Build(Message_ProgressRange)` | A |
| R5 | BOPAlgo_Algo reference | https://occt3d.com/dev/doc/refman/html/class_b_o_p_algo___algo.html | `Perform(Message_ProgressRange)` enables progress and user break; a break adds an error to the report | A |
| R6 | OCCT commit "Progress indicator for Boolean operations" | https://git.rbts.co/OpenCascade/occt/commit/7e785937b3e65df86f35364e1036e446d6339cec | booleans honour `UserBreak()` since 7.6 | A |
| R7 | BRepBndLib.hxx | https://eic-code-browser.sdcc.bnl.gov/lxr/source/include/opencascade/BRepBndLib.hxx | `AddOptimal` precise boxes; `AddOBB(…, isOptimal)` tighter OBB at a cost | A |
| R8 | NX Open ClearanceSet API | https://docs.plm.automation.siemens.com/data_services/resources/nx/12/nx_api/custom/en_US/open_c++_ref/a00888.html | clearance sets, exclusion rules, incremental re-analysis (via search summary; page is JS-rendered) | B |
| R9 | SOLIDWORKS Interference Detection (with fasteners; PropertyManager) | https://help.solidworks.com/2017/english/Solidworks/sldworks/c_Interference_Detection_with_Fasteners.htm ; https://help.solidworks.com/2024/english/SolidWorks/sldworks/HIDD_DVE_INTERFERENCE.htm | `IsFastener=1`; fasteners folder; "treat coincidence as interference" off by default (via search snippets; pages JS-rendered) | A (snippet) |
| R10 | SOLIDWORKS Component Patterns | https://help.solidworks.com/2021/English/SolidWorks/sldworks/c_component_patterns.htm | pattern-driven component patterns follow a part pattern | A |
| R11 | Onshape Fastened mate; Group vs Fasten | https://cad.onshape.com/help/Content/Assembly/fastened_mate.htm ; https://www.onshape.com/en/resource-center/tech-tips/tech-tip-when-to-use-the-group-vs-fasten-features-in-onshape | fastened = 0 DOF; ~250+ fastened mates cause performance problems, use Group | A / B |
| R12 | Onshape Replicate | https://cad.onshape.com/help/Content/Assembly/replicate.htm | replicates a seed instance and its mate onto matching geometry | A |
| R13 | Fusion As-built joint | https://help.autodesk.com/cloudhelp/ENU/Fusion-Assemble/files/ASM-AS-BUILT-JOINT.htm | joints between already-positioned components | A |
| R14 | NXOpen.Positioning.ConstraintType | https://docs.plm.automation.siemens.com/data_services/resources/nx/12/nx_api/custom/en_US/nxopen_python_ref/NXOpen.Positioning.ConstraintType.html | Fix, Bond constraint types | A |
| R15 | Onshape circular pattern; faster patterns tip | https://cad.onshape.com/help/Content/PartStudio/circular_pattern.htm ; https://www.onshape.com/en/resource-center/tech-tips/tech-tip-how-to-create-faster-patterns-in-onshape | face / feature patterns copy geometry without regeneration; identical topology required | A / B |
| R16 | SOLIDWORKS Geometry Pattern | https://blogs.solidworks.com/solidworksblog/2013/09/solidworks-geometry-pattern-a-simple-option-to-make-patterns-regenerate-faster.html | instances copied, not solved | B |
| R17 | Creo mechanism model | https://support.ptc.com/help/creo/creo_pma/r7.0/usascii/simulate/mech_des/overview/creating_model_mdx.html | rigid bodies; connections only between distinct bodies | A |
| R18 | Ansys Connection Group; contact settings | https://ansyshelp.ansys.com/public/Views/Secured/corp/v261/en/wb_sim/ds_connections_group.html ; https://ansyshelp.ansys.com/public/Views/Secured/corp/v261/en/wb_sim/ds_contact_ctrlpanel.html | auto-detected contacts, default Bonded; face angle 75° (within 15° of parallel), overlap tolerance, cylindrical include / exclude / only | A |
| R19 | three.js InstancedMesh; BatchedMesh | https://threejs.org/docs/pages/InstancedMesh.html ; https://threejs.org/docs/pages/BatchedMesh.html | `setMatrixAt`, bounding sphere recompute, `perObjectFrustumCulled`; instancing cuts draw calls not vertex work (forum C) | A |
| R20 | STEP item definition structure | https://downloads.steptools.com/stds/smrl/data/modules/item_definition_structure/sys/f_guide.htm | one product, n `next_assembly_usage_occurrence`; shape reuse by `mapped_item` | A |
| R21 | glTF EXT_mesh_gpu_instancing | https://gltf-transform.dev/modules/extensions/classes/EXTMeshGPUInstancing | `TRANSLATION` / `ROTATION` / `SCALE` instance accessors | A |
| R22 | OpenSCAD include / use; functions and modules | https://en.wikibooks.org/wiki/OpenSCAD_User_Manual/Include_Statement | `use` imports definitions only and does not see caller globals; `include` overrides silently | A |
| R23 | KCL modules, arrays, types | https://zoo.dev/docs/kcl-lang/modules | `export`, `import … as`, acyclic, evaluated once, version fixed by entry point; ranges `[a..b]`, `[a..<b]`; `[T; n+]`; typed errors | A |
| R24 | OpenSCAD list comprehensions | https://en.wikibooks.org/wiki/OpenSCAD_User_Manual/List_Comprehensions | `[for …]`, `each`, `if`, `let` | A |
| R25 | KCL map / reduce | https://zoo.dev/docs/kcl-book/map_reduce.html | anonymous functions over arrays | A |
| R26 | Onshape FeatureScript UI spec | https://cad.onshape.com/FsDoc/uispec.html | array parameters with per-item preconditions | A |
| R27 | Jsonnet tutorial | https://jsonnet.org/learning/tutorial.html | hermetic evaluation; comprehensions; `if … then … else` | A |
| R28 | Dhall safety guarantees | https://docs.dhall-lang.org/discussions/Safety-guarantees.html | hash-frozen imports cannot change; total language | A |
| R29 | Grasshopper GH_ParamAccess | https://developer.rhino3d.com/api/grasshopper/html/T_Grasshopper_Kernel_GH_ParamAccess.htm | item / list / tree access; implicit matching is a known error source (secondary sources) | A / B |
| R30 | Electron webContents; offscreen rendering | https://www.electronjs.org/docs/latest/api/web-contents ; https://www.electronjs.org/docs/latest/tutorial/offscreen-rendering | `capturePage(rect, {stayHidden})` → NativeImage; offscreen frames only when invalidated | A |
| R31 | STEP binary_assembly_constraint; AP242 e2 notes | https://downloads.steptools.com/docs/stp_aim/html/t_binary_assembly_constraint.html ; https://downloads.steptools.com/docs/stp_aim/notes_ap242e2.html | assembly constraint entities; no dedicated fastener entity found | A |
| R32 | CAx-IF / MBx-IF recommended practice, AP242 XML kinematics v1.3 | https://www.mbx-if.org/home/wp-content/uploads/2025/10/rec_prac_ap242xml_kinematics_v1.3.pdf | kinematics export practice (later pack) | A |
| M1 | llull measurement: fuse timings | `plans/bladed_disk.lld` | 1.7 / 4.3 / 26.4 s for 4 / 12 / 36 blades | A |
| M2 | llull measurement: check_assembly | turbofan, 175 representative parts | 269–283 s; 500-part refusal | A |
| M3 | llull measurement: alias arity | `plans/alias_arity.lld` | first id only (274888.872 mm³); exact 4-hole volume 270175.376 mm³ | A |
| M4 | llull measurement: bounds, ruled loft | `plans/fidelity.lld` | 1240.438 vs ≤ 1060 (1445.255 on the engine inlet); pylon × mount penetration 0.206 mm | A |
| M5 | llull measurement: installer | `npm --prefix desktop run dist` | 16 GB unpacked, 7-Zip exit 8; Git tar extract failure | A |
| S1 | code survey (main 52c1c51e) | paths in TECHNICAL_SPEC §1 | current behaviour and constants | A |
