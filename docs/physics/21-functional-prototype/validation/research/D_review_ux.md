# Research D: review UX for an agent-built mechanism (llull)

Accessed 2026-10-16. Context: an AI agent builds the model through the command registry (CLI/MCP), and a human engineer uses the UI to **review** it. The example is a piston, connecting rod, crankshaft, gearbox and propeller train. The reviewer checks that it moves, has no interferences, has real wall thickness, and is connected.

Citation tags: **[Rn]** means the page was fetched and read. **[Rn-s]** means the official page is JS-rendered and WebFetch returned only boilerplate. Those claims rest on the search engine's excerpt of that official URL plus a fetched third-party page that corroborates them. Treat them as slightly weaker.

---

## 1. How mature CAD/CAE tools present motion and check results

### 1.1 Interference: a results list with one row per pair, sorted by volume, that drives the 3D view
- **SOLIDWORKS Interference Detection.** After *Calculate*, interferences appear in a **Results** list with each **volume shown beside the entry**. Expanding an entry shows the interfering components. Selecting an entry **highlights the interference volume in red**. Right-click offers **Zoom to selection**. An entry can be **Ignored**, and ignored items stay listed with a grey icon when "Show ignored" is on. Further options are "Treat coincidence as interference" and a "Create fasteners folder" that groups expected fastener interferences [R1].
- **"Isolate when done"** was added in SOLIDWORKS 2020. You tag an interference, close the tool, and the model shows **only the interfering bodies** until you exit isolation. A Component View lets you isolate the parent, the child, or just the interference body [R2].
- **Interference over time (motion studies).** The results list is indexed per interference with time and volume. Selecting an index enables *Details* and *Zoom to Selection* [R3-s].
- **CATIA DMU Check Clash.** This is the most review-oriented design found:
  - **Three conflict types:** *Clash* is overlapping volume, shown as red intersection curves. *Contact* is distance below the tessellation sag, shown as yellow triangles. *Clearance* is closer than a specified gap such as 25 mm, shown as green triangles.
  - A **Value** column and a reviewer-editable **Status** column (*Not inspected / Relevant / Irrelevant*), plus a **Comment** field per conflict.
  - A **traffic-light roll-up:** red means at least one relevant conflict, orange means none relevant but some not inspected, green means all irrelevant.
  - **Filters** by type, value (sorted up or down) and status. Two lists: **by conflict** and **by product**.
  - Selecting a conflict opens a **preview showing only the products in conflict**. A dedicated results window can be tiled beside the main view [R4][R5].
  - Note the precision caveat. Contact is defined relative to tessellation sag (default 0.2 mm), so results near that threshold can flip [R4].

### 1.2 Thickness: a colour map against a target, hover to read the value, and a ranked report
- **SOLIDWORKS Thickness Analysis.** You set a **target thickness** and show thin or thick regions. The colour scale can be **continuous or discrete bands** with an editable target colour. **Hovering shows the thickness value at the cursor**. "Treat corners as zero thickness" is an option. *Save Report* writes the settings, area and percentage in four thickness ranges, and **critical features ranked by deviation from target** [R6]. Only one body is analysed at a time, and you can restrict the analysis to selected faces [R6].

### 1.3 Motion: one shared time cursor across the animation and every plot
- **Adams PostProcessor (Hexagon).** "You can place plots and animations together on the same page, and … see Adams PostProcessor track the corresponding data on the plot as the animation plays." On Play it "**displays a line on the plot at the same data point that the animation is displaying**." A slider scrubs frames forward and back. Pages hold multi-viewport layouts. A **treeview** of pages, plots and curves selects what is edited. *Surf* mode swaps curves without accumulating them, for quick browsing. Measured distances are drawn **as coloured lines in the animation** (e.g. a green line for the wheel-to-steering distance) [R7][R8].
- **20-sim.** Its feature page describes the same link: "While a plot is being drawn, simultaneously the animation will be shown!" The link "is kept after a simulation has finished". Inspecting numeric values moves the 3D view at the same time [R9].
- **SOLIDWORKS Motion Analysis results.**
  - You plot a result against **time or frame**.
  - A **triad shows the local XYZ** of the measured component or mate.
  - Reaction forces and moments, linear displacement, velocity and acceleration can be shown as **vectors in the graphics window**, which replay with the motion [R10-s].
  - **Trace Path** draws a point's path in 3D. It is not plotted as a graph, and it can be converted to a curve feature [R11-s].
- **Onshape.** A moderator said Onshape cannot automatically trace continuous motion paths, and forum users fall back on screen capture. This is a gap llull can fill [R12].
- **Ansys Mechanical (FEA analogue).** Probes always keep a **time history**. Results appear in a **Tabular Data** window and as a displaced mesh [R13].

### 1.4 Mechanism-assembly diagnostics
- **Simscape Multibody Explorer.**
  - Selecting a model-tree node **highlights that block's frames in turquoise**. Clicking a solid in 3D selects the matching tree node.
  - The **Variable Viewer summarises the assembly status of each joint** and isolates the failing joint, with green circles meaning assembled.
  - **Go To Block** jumps from the joint to its definition.
  - Error messages name the root cause, e.g. "position violation" [R14][R15].
- **Onshape mates.**
  - Mate glyphs in the graphics area are coloured by state: **blue/white good, grey suppressed, red problem**.
  - A **triad icon** in the list marks an instance with unconstrained DOF, with a tooltip. A Rigid icon marks a fully constrained subassembly. A limit icon marks mates with limits.
  - An **"Animate mate DOF" play button** previews a mate through Start/End/Steps with single, reciprocate or loop playback [R16].
- **Fusion joints.** Each joint type has its own icon: rigid 0 DOF, revolute and slider 1, cylindrical and pin-slot 2, planar and ball 3. *Preview Motion* runs the joint alone. Browser actions are **Animate Joint** and **Animate Joint Relationships** [R17].

---

## 2. AI agents in CAD: how the human reviews the agent's work

- **Zoo Design Studio / Zookeeper.**
  - All output is **KCL code with a feature tree**. Point-and-click edits, code edits and agent edits land on the same model [R18][R19].
  - KCL is "terse enough for human reviewable version-control diffs" [R19].
  - The agent "frequently executes the model to check for errors" and "reviews the geometry via multi-view snapshots". Selected faces and edges are passed to it as context [R20].
  - A third-party reviewer warns: "**Do not confuse the agent reviewing its own snapshot with an independent engineering check**" [R21]. This is the main lesson for llull.
  - Leo's review: Zoo "cannot run physical tests or guarantee manufacturability", and the recommended workflow is to "describe a base feature, review it, then add the next operation" [R22].
  - The Text-to-CAD panel keeps chat history, lets you **expand the model's reasoning**, and lets you rate the output [R23].
- **Autodesk Assistant (AU 2026 preview, rolling out 2027).** Autodesk frames it as "designed to support professional judgment with controls and human oversight" and says it "keeps professionals in control" [R24][R25]. **AI Transparency Cards** cover models, data, limitations and safeguards, and the Assistant cites the card when asked [R25]. Architosh notes that no audit-log or approval mechanics were described. Firms "will need to establish strict protocols regarding where the AI's recommendation ends, and professional liability begins" [R26].
- **Onshape AI Advisor (PTC).** No fetchable primary page was available (the PTC press release returned HTTP 403). Search excerpts describe it as embedded guidance with design agents on the roadmap. Unverified here.
- **Siemens NX Design Copilot.** Only 2025 press material was found: "users retain complete control, selecting which tasks they wish to delegate". No review UI is documented (search excerpt only, not fetched).
- **Adam (YC W25).**
  - Edits Onshape and Fusion feature trees agentically [R27].
  - The docs mention task history ("Return to previous tasks, find generated files, share results") but no diff or approve flow [R27].
- **Leo AI.**
  - Its trust model is **citations**. It "cites every answer with a source", and "If it can't find one, it says so" [R28].
  - Leo-authored material says engineers can inspect the source, formulas, standards and assumptions behind a recommendation. That is a vendor claim, and the fetched page did not confirm formulas or assumptions [R28].
- **nTop.** Searches turned up nothing on agent features.
- **Generic agent-review patterns from software tools:**
  - **GitHub Copilot agent:**
    - **One PR per task**. A **session log** shows "internal reasoning and the tools it used". The agent runs tests and linters before pushing [R29][R30].
    - **Stop session** keeps the commits already pushed [R30].
    - The docs warn: "Logs do not replace your own review and testing" [R29].
  - **Cursor:** a **live diff during the run**, stop and redirect, revert, and an **Agent Review** pass that "analyzes proposed edits line by line and flags potential problems". You can also review the whole branch against main [R31].
- **Microsoft HAX guidelines** [R32]:
  - G2: *Make clear how well the system can do what it can do*.
  - G9: *Support efficient correction*.
  - G11: *Make clear why the system did what it did*.
  - G15: *Encourage granular feedback*.
  - G16: *Convey the consequences of user actions*.

**What makes the work auditable across these tools:**
1. An editable, diffable recipe (code or feature tree).
2. A step log of tool calls with the reasoning behind each.
3. Self-checks the agent ran, shown separately from the human's own review.
4. One reviewable unit per task (a PR).
5. Citations for numbers.
6. Stop and revert controls.

---

## 3. Engineering review, sign-off and traceability

- **SOLIDWORKS Design Checker.** It shows either a confirmation or a **list of failed checks grouped by criticality**. Each failure expands to **actual vs preferred value**, with *Correct selected* / *Auto-correct all*, then a mandatory *Recheck*, and the output is a saved report [R33][R34].
- **Onshape release workflow.**
  - **All mandatory approvers must sign off**, and any one rejection blocks the release.
  - Required properties gate Submit/Release: the section header turns red and the buttons stay disabled.
  - Workflows can **require approver comments** before moving from In Review to Released [R35].
- **Verification programme practice.**
  - "Map each design input to verification method, acceptance criteria, responsible party, and expected evidence."
  - Use "numeric or pass/fail criteria".
  - "Link each record to the specific requirement it verifies".
  - "Any design change after verification triggers an impact assessment and **selective re-verification**" [R36].
- **CATIA's Status/Comment columns** are a ready-made sign-off model: not inspected, relevant, irrelevant, plus a comment [R4].

---

## 4. Visualization conventions

- **Kinematic graph.** Simscape `plotKinematicGraph` draws **bodies (solids, world frame) as dots** and **joints as lines with an arrow toward the follower frame**. Layouts are *tree* (default, rooted at the world-attached body), *circle*, *snake* (good for chains) and *layered* [R37]. A drivetrain fits a snake or layered layout, rooted at the world-fixed engine block.
- **Joint glyphs and DOF:**
  - Per-type icons with DOF counts (Fusion table above) [R17].
  - State-coloured mate indicators and an "unconstrained DOF" triad badge (Onshape) [R16].
  - Frames highlighted in a single accent colour (turquoise) when a joint is selected (Simscape) [R14].
- **Physics overlays (MuJoCo, llull's engine).** The visualizer can render "contact positions and normals, contact forces that can be separated into normal and tangential components, … joint and actuator axes, … local frames, … text labels". Joint labels draw "a string … next to each joint" [R38]. The decor category includes force arrows and constraint violations [R39].
- **Free-body diagrams.**
  - Forces are drawn as **straight arrows in their direction of action**, and **moments as curved arrows**. Reactions carry **hash marks through the stem**.
  - A solved FBD shows direction, line of action, magnitude and **point of application**.
  - Exclude other bodies, internal forces and velocity or acceleration vectors. Include a coordinate system [R40].
- **Crank-angle plots (4-stroke).**
  - The x-axis runs **0–720°**, with **0° = intake TDC and 360° = combustion (firing) TDC** (MathWorks SI Combustion Cylinder convention).
  - Cylinder pressure is P_cyl(θ) in MPa [R41].
  - Label which TDC is the reference, because conventions vary between sources.
  - For multi-cylinder engines, offset each cylinder by 720°/n. This came from a search excerpt of a patent and was not fetched.

---

## 5. Accessibility and clarity

- **Colour maps.**
  - Use perceptually uniform maps with **monotonic lightness**: viridis, plasma, inferno, magma, cividis.
  - "The human brain perceives changes in the lightness parameter … much better than … hue". Jet and HSV are "a poor choice" because L* varies widely, and they fail in greyscale.
  - "Avoiding colormaps with both red and green will avoid many problems".
  - Use a **diverging map only when the data has a critical middle**. That fits thickness relative to a target, or clearance around 0. BrBG and RdBu are rated good [R42].
- **Categorical palette.** Okabe-Ito (CUD): #E69F00 orange, #56B4E9 sky blue, #009E73 bluish green, #F0E442 yellow, #0072B2 blue, #D55E00 vermillion, #CC79A7 reddish purple, #000000. Above 8 categories, add shape or pattern [R43].
- **WCAG 1.4.1 (Level A).** Colour must not be the only means of conveying status. Its examples are "error is shown in red" and colour-only chart series. For colour-coded images, add numbers and a legend [R44]. So pass/warn/fail needs **icon shape plus text**, not just green/amber/red.
- **Units.** Adams, SOLIDWORKS and MathWorks all carry units on results (Pcyl in MPa, volumes, thickness tooltips) [R6][R41]. Recommendation: every number in llull's review UI renders with a unit and its source (see the proposals below).

---

## 6. Patterns worth adopting in llull (mapped to its architecture)

All proposals are **read-only presentation** over the results of query commands (`src/ui`). Any "accept", "ignore" or "sign-off" state that must persist is **document data written by a command**, per the L1/L4 laws.

1. **Review Checklist panel (the hub).**
   - Rows: *Moves* (DOF and drive check), *No interference*, *Wall thickness ≥ t_min*, *Connected* (graph has one component and every body is reachable from ground), *Mass and CoM*.
   - Each row shows a **status icon whose shape and text differ by state** (✓ pass / ▲ warn / ✕ fail / ○ not run), a value with its unit, the threshold, and **"why"**.
   - "Why" expands to the method, the command that produced the value, its inputs and the step id (HAX G11, Leo-style citations).
   - Roll-up traffic light as in CATIA. A **Reviewer status** per finding (*Not inspected / Accepted / Rejected + comment*) is stored through a command.
   - **Re-verify when stale:** if a later feature step touches an entity, the rows that depend on it flip to "stale" (selective re-verification [R36]).
2. **Findings list → 3D (one component for clash, thickness and connection issues).**
   - One row per pair, showing the volume or penetration (mm³ / mm) or the minimum gap.
   - Type chip: Clash / Contact / Clearance.
   - Click to highlight the overlap body in red and **zoom to selection**. Double-click to **isolate** only the two bodies with ghosted context. Filters by type, status and value-sort. "Group by part" toggle.
3. **Shared time cursor (Adams / 20-sim pattern).** A timeline scrubber and the 3D view are linked to **every plot**.
   - Each plot draws a vertical cursor line at the current time. Clicking a plot point seeks the animation there.
   - The x-axis can switch to **crank angle 0–720°** with TDC labels.
   - Interference-over-time events appear as markers on the timeline.
4. **3D overlays toggled from a legend.**
   - **Joint glyphs** per type (revolute ring, prismatic arrow pair, fixed lock) coloured by state, with a DOF badge.
   - **Force arrows** with tail at the point of application. Length is proportional to magnitude and labelled with value and unit. Moments are drawn as curved arrows.
   - **Contact normals** from MuJoCo. **Trace paths** for a chosen point, e.g. the wrist pin, as the toggle Onshape lacks.
5. **Thickness heat map.**
   - Viridis for absolute thickness, or a **diverging map centred on t_target**, with discrete bands as an option.
   - Hover shows "3.2 mm (target 4.0)". A ranked list of the thinnest regions has click-to-zoom.
   - Corners can optionally count as zero thickness.
6. **Mechanism graph view.**
   - Nodes are bodies: piston, rod, crank, gear stages, prop, ground. Edges are joints, with type glyph and DOF, and gear couplers drawn as dashed edges with their ratio.
   - Use a layered or snake layout rooted at ground. Selection syncs with 3D and the tree.
   - Disconnected nodes and over- or under-constrained loops are highlighted red with a text reason (Simscape Variable Viewer + Go To Block).
7. **Agent activity / provenance timeline.**
   - The feature-step log grouped per agent task: command name, params, summary, affected ids.
   - **Per-step document diff**: added, changed and removed entities, highlighted in 3D (Cursor/Copilot pattern).
   - **Agent self-checks are labelled separately from reviewer checks** [R21][R29].
   - Revert to a step by running history meta-commands.

---

## References

- [R1] SOLIDWORKS: Interference Detection — CATI — https://www.cati.com/?p=120210 (accessed 2026-10)
- [R2] SOLIDWORKS 2020 What's New – Isolating Interference in Assemblies — CATI — https://www.cati.com/?p=128106 (accessed 2026-10)
- [R3-s] Detecting Interference (Motion Studies) — Dassault Systèmes SOLIDWORKS Help — https://help.solidworks.com/2019/english/SolidWorks/motionstudies/t_detecting_interference_motion.htm (accessed 2026-10; JS-rendered, search excerpt)
- [R4] Reading Clash Command Results (CATIA V5 tutorial) — City, University of London — https://www.staff.city.ac.uk/~ra600/ME2105/Catia%20course/CATIA%20Tutorials/asmug_C2/asmugbt1102.htm (accessed 2026-10)
- [R5] View Results in a Dedicated Window (CATIA V5 tutorial) — City, University of London — https://www.staff.city.ac.uk/~ra600/ME2105/Catia%20course/CATIA%20Tutorials/asmug_C2/asmugbt1103.htm (accessed 2026-10)
- [R6] Thickness Analysis Tool – SOLIDWORKS Utilities — GoEngineer — https://www.goengineer.com/blog/thickness-analysis-tool-solidworks-utilities (accessed 2026-10)
- [R7] Adams 2021.3 Getting Started Using Adams PostProcessor — Hexagon — https://documentation-be.hexagon.com/bundle/Adams_2021.3_Getting_Started_Using_Adams_PostProcessor/raw/resource/enus/Adams_2021.3_Getting_Started_Using_Adams_PostProcessor.pdf (accessed 2026-10)
- [R8] ADAMS/PostProcessor — MSC Software (Yumpu mirror) — https://www.yumpu.com/en/document/view/13888916/adams-postprocessor-msc-software (accessed 2026-10)
- [R9] 3D Animation — 20-sim (Controllab) — https://www.20sim.com/features/3d-animation/ (accessed 2026-10)
- [R10-s] Displaying Vectors with Reaction Force Results — SOLIDWORKS Help — https://help.solidworks.com/2018/English/SolidWorks/motionstudies/t_displaying_vectors_reaction_force_results.htm (accessed 2026-10; search excerpt)
- [R11-s] Tracing the Motion of a Point in an Assembly — SOLIDWORKS Help — https://help.solidworks.com/2025/English/SolidWorks/motionstudies/t_tracing_motion_point_in_assy.htm (accessed 2026-10; search excerpt)
- [R12] Onshape forum, motion path tracing thread — Onshape — https://forum.onshape.com/discussion/comment/20024 (accessed 2026-10; SSO-gated, search excerpt)
- [R13] Probe Object Usage — Ansys Help 2026 R1 — https://ansyshelp.ansys.com/public/Views/Secured/corp/v261/en/wb_sim/ds_probe_overview.html (accessed 2026-10)
- [R14] Visualize Simscape Multibody Frames — MathWorks — https://www.mathworks.com/help/sm/ug/visualize-frames.html (accessed 2026-10)
- [R15] Find and Fix Aiming-Mechanism Assembly Errors — MathWorks — https://www.mathworks.com/help/sm/ug/find-and-fix-aiming-mechanism-assembly-errors.html (accessed 2026-10)
- [R16] Mates — Onshape Help — https://cad.onshape.com/help/Content/Assembly/mates.htm (accessed 2026-10)
- [R17] Create a joint — Autodesk Fusion Help — https://help.autodesk.com/cloudhelp/ENU/Fusion-Assemble/files/ASM-CREATE-JOINT.htm (accessed 2026-10)
- [R18] Zoo Text-to-CAD Review — Leo AI — https://www.getleo.ai/blog/zoo-text-to-cad-review (accessed 2026-10)
- [R19] Zoo Design Studio v1: A New Stack for Mechanical CAD — Zoo — https://zoo.dev/blog/zoo-design-studio-v1 (accessed 2026-10)
- [R20] Zookeeper: The Conversational CAD Agent For Parametric Modeling — Zoo — https://zoo.dev/research/zookeeper (accessed 2026-10)
- [R21] Zoo.dev review in 2026: Zookeeper, KCL, and real CAD work — Texocad — https://blog.texocad.ai/posts/zoo-text-to-cad-review (accessed 2026-10)
- [R22] = [R18] (Leo AI review of Zoo)
- [R23] What's New With Zoo, September Edition — Zoo — https://zoo.dev/blog/whats-new-september (accessed 2026-10)
- [R24] AU 2026: Autodesk's AI Assistant is evolving — Engineering.com — https://www.engineering.com/au-2026-autodesks-ai-assistant-is-evolving/ (accessed 2026-10)
- [R25] Autodesk Previews Agentic AI Across Forma, Fusion, and Flow — Unite.AI — https://www.unite.ai/autodesk-previews-agentic-ai-across-forma-fusion-and-flow/ (accessed 2026-10)
- [R26] AU2026: Autodesk Shifts AI from Chatbots to Agentic Ecosystems — Architosh — https://architosh.com/2026/10/au2026-autodesk-shifts-ai-from-chatbots-to-agentic-ecosystems/ (accessed 2026-10)
- [R27] Adam documentation — Adam — https://docs.adam.new/ (accessed 2026-10)
- [R28] What Makes Leo the AI Copilot Mechanical Engineers Actually Trust — Leo AI — https://www.getleo.ai/blog/what-makes-leo-the-ai-copilot-mechanical-engineers-actually-trust (accessed 2026-10)
- [R29] About Copilot coding agent — GitHub Docs — https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent (accessed 2026-10)
- [R30] Using the Copilot coding agent logs — GitHub Docs — https://docs.github.com/en/copilot/using-github-copilot/coding-agent/using-the-copilot-coding-agent-logs (accessed 2026-10)
- [R31] Review (Agent) — Cursor Docs — https://cursor.com/docs/agent/review (accessed 2026-10)
- [R32] HAX Design Library: Guidelines for Human-AI Interaction — Microsoft — https://www.microsoft.com/en-us/haxtoolkit/library/ (accessed 2026-10)
- [R33] SOLIDWORKS: Design Checker — CATI — https://www.cati.com/?p=132014 (accessed 2026-10)
- [R34] = search excerpt of SOLIDWORKS Design Checker help — https://help.solidworks.com/2019/english/SolidWorks/solidworks_design_checker/c_check_active_document.htm (accessed 2026-10; search excerpt)
- [R35] Enforce Required Properties in Release Management Workflows — Onshape — https://www.onshape.com/en/resource-center/tech-tips/enforce-required-properties-release-management-workflows (accessed 2026-10)
- [R36] How To Build A Design Verification Program For Production — Racklify — https://racklify.com/encyclopedia/how-to-build-a-design-verification-program-for-production/ (accessed 2026-10)
- [R37] plotKinematicGraph — MathWorks Simscape Multibody — https://www.mathworks.com/help/sm/ref/simscape.multibody.compiledmultibody.plotkinematicgraph.html (accessed 2026-10)
- [R38] MuJoCo Overview (3.9.0) — Google DeepMind — https://mujoco.readthedocs.io/en/3.9.0/overview.html (accessed 2026-10)
- [R39] MuJoCo Visualization (3.3.1) — Google DeepMind — https://mujoco.readthedocs.io/en/3.3.1/programming/visualization.html (accessed 2026-10)
- [R40] Free body diagram — Wikipedia — https://en.wikipedia.org/wiki/Free_body_diagram (accessed 2026-10)
- [R41] SI Combustion Cylinder — MathWorks Simscape Driveline — https://www.mathworks.com/help/sdl/ref/sicombustioncylinder.html (accessed 2026-10)
- [R42] Choosing Colormaps in Matplotlib (3.5.2) — Matplotlib — https://matplotlib.org/3.5.2/tutorials/colors/colormaps.html (accessed 2026-10)
- [R43] Okabe-Ito Palette Hex Codes: Complete Reference — ConceptViz — https://conceptviz.app/blog/okabe-ito-palette-hex-codes-complete-reference (accessed 2026-10)
- [R44] Understanding SC 1.4.1 Use of Color — W3C WAI (WCAG 2.2) — https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html (accessed 2026-10)

### Not reached or unverified
- The official SOLIDWORKS help pages are JS-rendered, so WebFetch returned boilerplate. The ptc.com, javelin-tech and autodesk.com pages returned HTTP 403.
- No documentation was found for: a Simcenter 3D Motion graph-to-animation cursor, the nTop agent, an Onshape AI Advisor review UI, or the Adams Model Browser filters.
