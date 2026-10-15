# CMP: Composite structures design (functional specification)

Gap id **CMP** · Status: specification only · Written 2026-10-15 · Depends on 01 KRN, 02 SRF, 08 MAT;
feeds 05 FEA and 04 XCH.

## 1. Summary

llull models solids and 2D drafting. It has no notion of a **ply**, a **laminate** or **fibre orientation**.
In composites work, the deliverable is not the cured solid shape. It is the **layup definition**:

- which plies of which material are laid,
- at which orientation relative to a rosette,
- over which boundary on a tool surface,
- in which sequence,
- with which ply drops,

plus the manufacturing data derived from it: flat patterns for the cutter, laser-projection outlines and the
ply book. On top of that, the stiffness and strength of the laminate (Classical Laminate Theory) drive every
sizing decision. Composites make up roughly half of the structural weight of current wide-body airliners:
53 % for the A350 XWB [R1][R2], and about half for the 787 [R3][R4]. Without composites support, llull
cannot be used for most aerospace primary or secondary structure, nor by the tier-1/2 suppliers who build
skins, spars, fairings, radomes, nacelles and interiors.

This gap adds a **composites domain plugin** with the following parts:

- lamina materials;
- rosettes;
- ply-based and zone-based laminate definition with stacking notation;
- ply drop-offs and ramps;
- core samples;
- design-rule checks;
- CLT stiffness (ABD, engineering constants) and first-ply failure;
- kinematic drape simulation with producibility (shear and locking angle);
- flat patterns;
- exports: DXF cutter data, laser projection, ply book, and an explicit and later AP242 composite STEP.

Every capability is a command, so it is reachable from the UI, the `llull` CLI and MCP. It runs offline on
the desktop with the OCC kernel.

## 2. Aerospace context and value

### 2.1 Programmes

| Programme | Composite content | Source |
| --------- | ----------------- | ------ |
| Airbus A350 XWB | Composites are 53 % of the aircraft by weight, including the fuselage and wings; over 70 % of the airframe is advanced materials (composites, titanium, advanced Al) | [R1], [R2] |
| Boeing 787 | Airframe is about half CFRP and other composites by weight (AERO Q4 2014); "50 percent of structural weight" | [R3], [R4] |
| F-35 (JSF) inlet duct, built by Quickstep | Fibersim ply-based design halved engineering hours (300 to 150 h) and cut manufacturing hours from 450 to 200 h; average saving of about 20 % per part over 80+ parts | [R5] |
| SpaceX fairing boat-tail panel | Design-to-manufacturing time from 7 to 2 days (71 %) with Fibersim (secondary source) | [R6] |

### 2.2 How it is done today

Composite design in aerospace is dominated by three dedicated tools, all ply-based and all built on top of a
host CAD system:

| Tool | Host | Key concepts (public documentation) | Source |
| ---- | ---- | ----------------------------------- | ------ |
| CATIA Composites Design (CPD / 3DEXPERIENCE) | CATIA | Grid design and zone design (including solid slicing), plies and limit contours, ply table import from Excel, producibility (draping) analysis, flattening, splicing, darting, ply export, ply book, core sample, numerical analysis | [R7], [R8] |
| Siemens Fibersim | NX, CATIA V5, Creo | Ply-based modelling; flat-pattern export that accounts for shape, material and layup process, with layup markers and nesting; laser projection data and automated ply verification; core sample tool for symmetry and balance | [R9], [R10] |
| Ansys Composite PrepPost (ACP) | Ansys Mechanical | Plies applied on Oriented Selection Sets (OSS); rosettes and selection rules fix the 0° direction per element; draping (internal algorithm or user-defined); failure criteria including LaRC | [R11], [R12] |

Altair HyperWorks and PTC Creo also ship kinematic drape tools. Both use a seed point plus warp/weft
directions, a constant step length, and a locking-angle limit [R13][R14].

### 2.3 The engineering chain llull must support

```
material allowables (CMH-17 / NCAMP)                  -> lamina material
tool surface (02 SRF / imported STEP)                 -> composite part + rosette
zones / plies / sequences / ramps                     -> layup definition (document = recipe)
core samples, rule checks, CLT ABD, first-ply failure -> sizing loop (with 05 FEA)
drape simulation, producibility                       -> darts / splices / boundary edits
flat patterns, DXF, laser projection, ply book        -> shop floor (cutter, projector, laminator)
AP242 composite export                                -> OEM / supplier exchange (04 XCH)
```

### 2.4 Value for llull

- **Supplier market.** Tier-2/3 composite shops (fairings, interiors, UAV airframes, radomes) need a
  ply-based tool that costs far less than CATIA CPD or Fibersim. llull can offer an offline desktop tool that
  an agent can drive.
- **AI leverage.** A layup is highly structured data (stacking strings, zones, rules). An agent can propose
  stacks that satisfy the design rules, run CLT, iterate and regenerate flat patterns through MCP or the CLI.
  This is the "edit one parameter, everything regenerates" promise of llull's parametric core (L8).
- **Quantified precedent.** The cases in §2.1 report 50 % fewer engineering hours [R5] and 71 % shorter
  design-to-manufacturing time [R6] when the ply model drives the manufacturing data. These are vendor or
  secondary figures, used here as order-of-magnitude motivation.

## 3. Personas and user stories

| Persona | Description |
| ------- | ----------- |
| P1 Composite design engineer | Defines plies, zones, ramps; owns the layup definition and ply book |
| P2 Stress engineer | Needs ABD, engineering constants and first-ply failure margins; exports laminates to FEA |
| P3 Manufacturing / process engineer | Checks drapability, adds darts and splices, generates flat patterns, nesting and laser data |
| P4 Quality / inspection | Uses the ply book, laser projection and core samples to verify layup |
| P5 AI agent (MCP or CLI) | Builds layups from requirements, runs checks, iterates; never bypasses commands |

User stories:

- **US-1 (P1).** As a design engineer, I define a skin as zones with stacking strings
  (`[45/-45/0/90]s`, …), and llull generates continuous plies with ramps between zones, so I avoid
  hand-drawing hundreds of ply boundaries.
- **US-2 (P1/P4).** I click anywhere on the part and see the core sample: the ordered plies, materials,
  orientations and total thickness.
- **US-3 (P2).** I get the A, B, D matrices, Ex, Ey, Gxy, νxy and first-ply failure under a load set for any
  core sample, with the same numbers in the UI, the CLI and MCP.
- **US-4 (P3).** I simulate drape from a seed point and see the shear angle map with warning and lock
  colouring. Then I add a dart and re-check.
- **US-5 (P3).** I export DXF flat patterns (one closed outline per ply piece, labelled, with an orientation
  arrow) that a ply cutter can nest, and laser-projection outlines for the layup tool.
- **US-6 (P1/P4).** I publish a ply book: one sheet per sequence with the ply outline on the part, the flat
  pattern, the material and the orientation.
- **US-7 (P5).** As an agent, I receive "a 600 × 400 panel, Nx = 300 N/mm, quasi-isotropic base, pad at the
  centre". I write a plan, run `check_laminate_rules` and `analyze_laminate`, adjust the stacks until the
  margins are positive, and export the flat patterns.
- **US-8 (P2).** I hand the layup to 05 FEA as shell sections (ply table per zone) so that the stress model
  and the CAD layup cannot diverge.

## 4. Scope and phases

| Phase | In scope |
| ----- | -------- |
| **MVP** | Lamina materials (UD tape, woven); rosettes (translational, cylindrical); stacking notation parser; composite part on one exact tool face; ply-based plies (boundary curve on surface, orientation, sequence); zone-based laminates with automatic ply generation and linear ramps; core sample; design-rule check R1-R5; CLT (ABD, constants, ply stresses) and first-ply failure (max stress, Tsai-Hill, Tsai-Wu); laminate mass; flat patterns for developable faces (planes, cylinders, cones); DXF flat-pattern export |
| **V1** | Kinematic (pin-jointed net) drape on any OCC face with shear map, warning and lock limits; flat patterns from drape on doubly curved faces; darts and splices; producibility report; laser projection export; ply book (SVG/PDF sheets via the drawings module); cores (honeycomb/foam) with chamfered edges; offset solids per ply (visual and thickness check); laminate hand-off to 05 FEA |
| **V2** | STEP AP242 composite export (implicit "precise" + explicit tessellated per ply, CAx-IF rec. practices); import of ply tables (CSV/Excel) and of AP242 composites; LaRC03 and progressive failure; hygrothermal (CTE/CME) loads; stacking-sequence optimiser (agent-assisted) with blending; AFP/ATL course generation; nesting |

**Out of scope:**

- Cure simulation, springback and process FE (resin flow, consolidation).
- Micromechanics beyond rule-of-mixtures helpers.
- Certification analysis: llull supplies inputs and checks, while allowables and certification remain the
  engineer's responsibility under AC 20-107B [R15].
- Machine-specific NC post-processors for cutters and projectors beyond documented open formats.

## 5. Functional requirements

| Id | Pri | Requirement | Rationale | Source |
| -- | --- | ----------- | --------- | ------ |
| FR-CMP-01 | MUST | Define lamina materials. Form: UD tape, woven fabric or core. Elastic constants E1, E2, G12, ν12 (G13, G23 optional); strengths Xt, Xc, Yt, Yc, S; cured ply thickness; density; optional locking angle and warning shear (fabrics); a free-text source and basis (mean / B-basis / A-basis) | CLT and drape inputs; traceability of allowables | [R16], [R17], [R18] |
| FR-CMP-02 | MUST | Material values are validated: positive moduli and strengths; ν12² < E1/E2 (positive-definite compliance); thickness > 0 | Wrong input must fail loudly | Jones/NASA RP-1351 [R19] |
| FR-CMP-03 | SHOULD | Lamina materials can be referenced from the 08 MAT library (CMH-17 / NCAMP datasets) and keep a provenance link | Single source of allowables | [R16], [R18] |
| FR-CMP-04 | MUST | Laminates can be entered in standard stacking notation: `/` separator, `±θ`, repeat `_n`, groups `( )_n`, symmetric `s`, `ns`, total `T`, unduplicated middle ply. They are stored expanded, bottom to top, with the original string kept | Industry-standard notation; agent-friendly | [R19] |
| FR-CMP-05 | MUST | Rosettes define the 0° direction: origin, 0° axis and normal; methods translational (projected) and cylindrical (axis); later radial and edge-following. Every ply references a rosette | All orientations are relative to a rosette | [R11], [R13] |
| FR-CMP-06 | MUST | A composite part references one or more exact tool faces of an existing solid or surface (`faceNear` point, robust to topology renumbering) and a laminate side (+/- normal) | Plies live on the tool surface; KI5 naming lesson | KI5 |
| FR-CMP-07 | MUST | Ply-based definition: a ply has name, sequence label, step order, material, orientation (°), rosette, a boundary on the tool surface (closed curve set or a whole face), and optional drape settings. Plies can be added, edited, reordered and deleted | Core of every composites tool | [R7], [R9] |
| FR-CMP-10 | MUST | Zone-based definition: zones are closed regions on the tool surface with a stacking string and a priority. `generate_plies_from_zones` produces continuous plies across zones by blending, rejecting non-blendable stacks with the zone pair named | Zone/grid design is the preliminary-design workflow in CPD | [R7], [R8] |
| FR-CMP-11 | MUST | Core sample: at a point (or along a polyline section), return ordered plies with material, orientation in rosette and in global axes, thickness, cumulative z, and laminate total thickness | Inspection and design checks | [R10], [R14] |
| FR-CMP-12 | MUST | Ply drop-offs and ramps. Configurable ramp ratio (default 20:1), minimum stagger (in dropped thicknesses), drop order (inner first / outer first), and number of continuous cover plies. Report conflicts where the ramp does not fit between boundaries | Interlaminar stress risers at drops; 1:20 commonly used | [R20], [R21] |
| FR-CMP-13 | SHOULD | Cores: honeycomb or foam core regions with edge chamfer angle; plies above and below; core sample reports the core | Sandwich panels are common in fairings and interiors | [R7] |
| FR-CMP-20 | MUST | Design-rule check on every core sample / zone stack, with these rules: R1 symmetric; R2 balanced; R3 minimum fraction per 0/±45/90 family (default 10 %); R4 maximum consecutive same-angle plies (default 4); R5 outer plies ±45. Each finding names the zone or point, the rule and the offending plies | The commonly published laminate guidelines (CMH-17 / industry) | [R20], [R21], [R22] |
| FR-CMP-21 | MUST | All rule thresholds are configurable per part. Rules can be disabled with a recorded justification | Rules vary between programmes; the sources disagree (e.g. 4 vs 5 contiguous) | [R20], [R21] |
| FR-CMP-22 | SHOULD | Additional rules: ply-drop symmetry, maximum angle change between adjacent plies (disorientation, e.g. ≤ 45°), no dropped outer plies, minimum ply width at drops | Common company rules | [R22] |
| FR-CMP-30 | MUST | Lamina stiffness: compute Q and Q̄(θ) for every ply | CLT foundation | [R19] |
| FR-CMP-31 | MUST | Laminate stiffness: compute A, B, D (and the 6×6 inverse) at any core sample or zone. Report engineering constants Ex, Ey, Gxy, νxy for both the membrane (A⁻¹) and the free-bending (ABD⁻¹) definitions, labelled | Stress engineer's daily tool; NASA RP-1351 covers ABD and constants | [R19] |
| FR-CMP-32 | MUST | First-ply failure under a load vector (Nx, Ny, Nxy, Mx, My, Mxy). Ply stresses at the bottom and top of each ply in material axes; strength ratio and failure index for max stress, Tsai-Hill and Tsai-Wu (F12* configurable, default -0.5); critical ply and criterion reported | Sizing; criteria are standard in all tools | [R12], [R19], [R23] |
| FR-CMP-33 | MUST | Laminate mass and thickness: per ply piece, per part, with centre of gravity; integrates with `mass_properties` | Weight is a top driver | — |
| FR-CMP-34 | SHOULD | Laminate hand-off to 05 FEA: per-zone shell section definition (ply table with material, thickness, angle, offset) exported in a solver-neutral JSON and, via 05 FEA, as Nastran PCOMP / CalculiX shell section | Single source of truth between CAD and analysis | 05 FEA |
| FR-CMP-40 | MUST (V1) | Kinematic drape simulation on any exact face. Pin-jointed net from a seed point and a seed direction, constant step, geodesic or user-curve generators; outputs fibre directions and shear angle per node | Mack & Taylor fishnet algorithm, used by Fibersim, CPD, Altair and Creo | [R13], [R14], [R24] |
| FR-CMP-41 | MUST (V1) | Producibility: shear map against the material warning shear and locking angle; regions over the limit are flagged and named per ply | Fabrics lock beyond a characteristic shear angle | [R13] |
| FR-CMP-42 | SHOULD (V1) | Darts and splices: user-placed cut curves split a ply into pieces (with overlap or butt), and drape is recomputed per piece | Standard remedy for over-shear | [R7] |
| FR-CMP-43 | MUST | Flat patterns. Exact developable unrolling for planes, cylinders and cones (MVP); drape-based flattening for doubly curved faces (V1). Each pattern carries the 0° direction, ply name, sequence and material, and optional excess/trim allowance | Cutter input | [R9] |
| FR-CMP-44 | COULD | Fibre-deviation map: angle between the draped fibre and the design orientation (rosette projection) | Stress knock-down awareness | [R12] |
| FR-CMP-50 | MUST | DXF flat-pattern export: one closed outline per ply piece, layer per ply, text labels, orientation arrow, mm units; optional nesting is V2 | Universal cutter input (ASTM D6673 shows DXF pattern exchange practice) | [R25] |
| FR-CMP-51 | SHOULD (V1) | Ply book export: one sheet per sequence with 3D view of the ply on the part, flat pattern, table (ply, material, orientation, sequence, area), through the existing drawings module | Shop-floor layup documentation | [R7], [R8] |
| FR-CMP-52 | SHOULD (V1) | Laser projection export: per ply, ordered 3D boundary points in tool coordinates with a configurable spacing (default 75 mm) plus every corner, consistent winding, plain-text format | Projector-guided layup | [R26], [R27] |
| FR-CMP-53 | SHOULD | Ply table export/import (CSV): ply, sequence, material, orientation, rosette, zone, area, mass | Excel-driven workflows in CPD | [R8] |
| FR-CMP-54 | SHOULD (V1) | Explicit per-ply solids (offset by cumulative thickness) for visualisation, interference checks and STEP AP214/AP242 export as ordinary solids | Visual verification; explicit AP242 representation | [R28] |
| FR-CMP-55 | COULD (V2) | STEP AP242 composite export following the CAx-IF composite recommended practices (laminate table, ply, orientation, ply boundaries, cores, validation properties) | Supply-chain exchange | [R28], [R29], [R30] |
| FR-CMP-56 | COULD (V2) | Cross-check drape and CLT results against external tools (Ansys ACP via PyACP sample data) | Confidence | [R31] |
| FR-CMP-60 | MUST | Every capability is a registered command with a zod schema, so it is available in the UI, CLI and MCP with identical results | Architecture L1/L5 | CLAUDE.md |
| FR-CMP-61 | MUST | The layup is parametric: stacking strings, zone boundaries, ramp ratios and orientations can reference document parameters; editing one regenerates plies, flat patterns and analyses | L8 recipe | CLAUDE.md |
| FR-CMP-62 | SHOULD | MCP toolset `composites` with discovery prompts ("design a laminate for …") and read-only query tools flagged safe | AI-first product | — |
| FR-CMP-70 | MUST | Performance: a 200-ply, 3-zone panel regenerates in ≤ 2 s; drape at 17 k nodes ≤ 500 ms on the desktop reference machine | Interactive use | — |

## 6. Workflows

### 6.1 UI: zone-based skin panel (MVP)

1. Model or import the tool surface (e.g. `add_box` top face, or a 02 SRF lofted skin).
2. **Composites > Material**: pick T300/5208 from the 08 MAT library, or enter the values (`create_lamina_material`).
3. **Composites > Rosette**: click the origin, then the 0° direction (`define_rosette`).
4. **Composites > New part**: pick the tool face and the laminate side (`create_composite_part`).
5. **Zones**: sketch closed curves on the face, and type the stacking string per zone (`define_zone`). The
   zone table shows the ply count, thickness and rule status live.
6. **Ramps**: set the ratio and stagger (`set_ply_drop_rules`), then click **Generate plies**
   (`generate_plies_from_zones`). The ply tree fills with sequences S1…Sn and ramps are drawn.
7. **Core sample** tool: hover anywhere to see the ply stack (`core_sample`). Click to pin a sample.
8. **Analysis** panel: enter loads and get ABD, constants, and FPF margins per criterion (`analyze_laminate`).
9. **Check** panel: rule findings, with click-to-zoom (`check_laminate_rules`).
10. **Export**: DXF flat patterns (`export_flat_patterns_dxf`), ply table CSV, and the ply book in V1.

### 6.2 UI: doubly curved woven ply (V1)

1. Composite part on a dome face; material with `lockingAngle`.
2. `add_ply` with drape settings: seed point, direction and step. The viewport shows the fibre net coloured
   by shear (green below the warning shear, amber between warning and lock, red above the lock).
3. `check_producibility` lists over-lock regions per ply. Add a dart curve (`split_ply`) and re-drape.
4. Export the flat pattern (drape-based) and the laser projection data.

### 6.3 CLI (local agent, KI6)

```bash
llull --app run docs/aerospace/06-composites/validation/plans/cmp-flat-panel-zones.json --validate
llull --app run docs/aerospace/06-composites/validation/plans/cmp-flat-panel-zones.json --progress
llull --app core_sample part=part-5.1 point=[300,200,0] --json
llull --app analyze_laminate '{"part":"part-5.1","point":[50,50,0],"loads":{"Nx":300}}' --json
llull --doc panel.llull.json export_flat_patterns_dxf part=part-5.1 --save flats.dxf
llull search laminate ply drape        # discovery ranks the composites toolset
```

The verbs (`run`, `exec`/shorthand, `--validate`, `--save`, `--json`) are the existing ones from
`server/src/cli/usage.ts`. Only the command names are new.

### 6.4 MCP agent (cloud)

1. `tools/list` with toolset `composites`.
2. The agent calls `build_project` with a plan: material, rosette, part, zones, generation.
3. The agent loops: `check_laminate_rules` (read-only), then `analyze_laminate` (read-only). If any margin
   is ≤ 0 or any rule fails, it edits the zone stacking (`edit_zone`) and repeats.
4. `export_flat_patterns_dxf`, returning the DXF text or a resource link.
5. Every step lands in the feature history, and the user can undo any agent step in the desktop app.

## 7. Acceptance criteria

| # | Given | When | Then | VC |
| - | ----- | ---- | ---- | -- |
| AC-1 | T300/5208 entered with the Tsai-Hahn constants | `analyze_laminate` on a [0]8 core sample | Q11 = 181.8 GPa, Q22 = 10.34 GPa (±0.1 %), Ex = E1 exactly | VC-CMP-01, 02 |
| AC-2 | A [0/45/-45/90]s and a [0/60/-60]s laminate | ABD computed | A11 = A22 = U1·h, A16 = 0, B = 0, identical Ex = 69 675.7 MPa | VC-CMP-03, 04 |
| AC-3 | [0/90]T, 0° ply at the bottom | ABD computed | B11 = -1 339.57 N, B22 = +1 339.57 N | VC-CMP-05 |
| AC-4 | Load Nx = 1 N/mm | FPF requested | Strength ratios equal `clt_reference.json` within 1e-4 and name the critical ply | VC-CMP-06, 07 |
| AC-5 | 10 stacking strings | Parsed and checked | Expansion and R1-R5 verdicts equal `layup_rules_reference.json` | VC-CMP-08, 09 |
| AC-6 | The 3-zone flat panel plan | Plies generated; core sample at two points | 8 plies / 1.0 mm and 24 plies / 3.0 mm; ramp widths n·t·20 | VC-CMP-10, 11 |
| AC-7 | Hemisphere R = 100, seed at the pole, step 1 mm | Drape | Shear at polar 45° on the diagonal = 15.7 ± 0.6°; Gauss-Bonnet residual ≤ 0.5°; max shear 51.9 ± 1.0° | VC-CMP-12 |
| AC-8 | Locking angle 40° | Producibility check | About 8.5 % of the quadrant is flagged; no flat pattern without `allowOverLock` | VC-CMP-13 |
| AC-9 | Cylinder and cone plies | Flat pattern | Width 2πr; cone sector angle 254.558°, area 44 428.8 mm² | VC-CMP-14, 15 |
| AC-10 | Cone flat pattern | Exported to DXF and re-imported | Area within 0.2 %; layer per ply; INSUNITS = 4 | VC-CMP-16 |
| AC-11 | Any ply | Laser projection exported | Point spacing ≤ 75 mm, corners present, consistent winding | VC-CMP-17 |
| AC-12 | Any plan in `validation/plans` | Replayed through UI, CLI and MCP | Identical documents and query data; commands pure | VC-CMP-20, 21 |

## 8. Standards and regulatory alignment

| Standard / guidance | Relevance | What llull does | Source |
| ------------------- | --------- | --------------- | ------ |
| FAA AC 20-107B (2009, Chg 1 2010), Composite Aircraft Structure | Acceptable means of compliance for composite structure under 14 CFR 23/25/27/29 (material and fabrication development, static proof, fatigue and damage tolerance, etc.) | llull produces the design definition and the checks that feed compliance. It does not claim compliance | [R15] |
| CMH-17 (SAE R-484 Vol. 2 Rev H; Vol. 3) / MIL-HDBK-17-3F | Statistically based material data (Vol. 2) and design and analysis guidance (Vol. 3) | Material records keep the basis (A/B/mean) and a source reference. Rule set R1-R5 follows the commonly published guidelines; clause text is not reproduced | [R16], [R17] |
| NCAMP (NIAR) shared databases | Public, FAA-overseen allowables reports (e.g. Hexcel 8552 IM7) | 08 MAT can import NCAMP values with the report id | [R18] |
| ISO 10303-242 (AP242) + CAx-IF composite rec. practices | Composite exchange (implicit precise and explicit tessellated) | V2 export; MVP explicit per-ply solids | [R28], [R29], [R30] |
| ASTM D6673 (DXF pattern data, withdrawn 2019) | Shows DXF practice for 2D pattern exchange (no cutter instructions) | DXF flat patterns use plain closed outlines plus labels, which is cutter-neutral | [R25] |

## 9. KPIs and success metrics

| KPI | Target |
| --- | ------ |
| Validation cases passing on desktop OCC | 100 % of MVP VCs (01-11, 14-16, 18, 20, 21, 31, 32) before MVP release; V1 VCs before V1 |
| CLT agreement with the reference generator | rel ≤ 1e-4 on all 14 cases |
| Time to define a 3-zone, 24-ply panel and export flats (expert user) | ≤ 15 min (baseline: hand-drawn plies in a generic CAD, TBD measure) |
| Agent success rate (US-7 benchmark prompt, 10 runs) | ≥ 8/10 produce a rule-clean laminate with positive FPF margin |
| Regeneration time of a 200-ply panel | ≤ 2 s |
| DXF round-trip area error | ≤ 0.2 % |

## 10. Risks and assumptions

| Risk / assumption | Impact | Mitigation |
| ----------------- | ------ | ---------- |
| Surface quality: drape needs smooth exact faces; meshed or imported tessellated surfaces give noisy shear | Wrong producibility verdicts | Drape on the OCC face (TR-CMP-40); refuse mesh-only faces or warn; depends on 01 KRN / 02 SRF |
| Kinematic drape ignores material mechanics (no tension, friction or tool interaction) | Over- or under-estimates shear on irregular tools (S19 reports good agreement only on axisymmetric moulds) | Label as "kinematic"; V2 hook for FE forming tools |
| Topological naming: zones and plies reference faces | Broken references after upstream edits | `faceNear` points + re-resolution, as KI5 does for edges |
| Material values differ between sources (e.g. T300/5208 E2 10.3 vs 10.7 GPa) | Disagreement with customer tools | Store source and basis per material; tests use one pinned set |
| Design rules are company-specific; CMH-17 clause text not reproduced | False positives or negatives | Configurable thresholds, justification on disable |
| AP242 composite support in open-source toolchains is immature | V2 export effort | MVP explicit solids + CSV; V2 hand-written AP242 entities validated against CAx-IF |
| Document size: thousands of plies with flat patterns | Slow saves and sync | Derived geometry is regenerated, not stored (plugin `derivedEntityIds`) |
| Export-control / proprietary layups | Data leakage | Offline desktop first; nothing leaves the machine unless the user exports |

## 11. References

- [R1] Airbus, "Airbus starts final assembly of first A350 XWB" (2012), via airframer.com: https://www.airframer.com/news/release/airbus-starts-final-assembly-of-first-a350-xwb (accessed 2026-10)
- [R2] A350 XWB data (Airbus 2009 statement, 53 % by weight), aerospaceweb.org: https://aerospaceweb.org/aircraft/jetliner/a350/ (accessed 2026-10)
- [R3] Boeing AERO Quarterly Q4 2014, 787 composite repair, via NASAMPE: https://www.nasampe.org/page/Boeing787 (accessed 2026-10)
- [R4] CompositesWorld, "Boeing sets pace for composite usage in large civil aircraft": https://compositesworld.com/articles/boeing-sets-pace-for-composite-usage-in-large-civil-aircraft (accessed 2026-10)
- [R5] Siemens Digital Industries Software, case study Quickstep Technology: https://resources.sw.siemens.com/en-US/case-study-quickstep-technology (accessed 2026-10)
- [R6] NextBigFuture, "Siemens Fibersim reduced SpaceX time" (2012): https://www.nextbigfuture.com/2012/08/siemens-fibersim-reduced-spacex-time.html (accessed 2026-10)
- [R7] Technia, CATIA 3DEXPERIENCE Composite Part Design training: https://www.technia.com/en/training/catia-3dexperience-composite-part-design/ (accessed 2026-10)
- [R8] Solid Solutions, 3DEXPERIENCE CATIA Composites training: https://www.solidsolutions.co.uk/training/3dexperience-catia-composites.aspx (accessed 2026-10)
- [R9] ATA Engineering, Siemens Fibersim Flat Pattern Export fact sheet: https://www.ata-e.com/wp-content/uploads/2024/10/Siemens-SW-Fibersim-Flat-Pattern-Export-Fact-Sheet.pdf (accessed 2026-10)
- [R10] structures.aero, Fibersim: https://structures.aero/fibersim/ (accessed 2026-10)
- [R11] Ansys ACP User's Guide, 2.1.9 Oriented Selection Sets: https://ansyshelp.ansys.com/public/Views/Secured/corp/v252/en/acp_ug/acp_oes.html (accessed 2026-10)
- [R12] Ansys ACP User's Guide, LaRC failure criterion: https://ansyshelp.ansys.com/public/Views/Secured/corp/v242/en/acp_ug/LaRc_Failure_Criterion.html (accessed 2026-10)
- [R13] Altair HyperWorks, Kinematic Draping Theory: https://help.altair.com/hwdesktop/hwx/topics/user_interface/kinematic_draping_approach_r.htm (accessed 2026-10)
- [R14] PTC Creo Composite Design, Draping Simulation: https://support.ptc.com/help/creo/creo_pma/r13/usascii/composite_design/about_draping_simulation.html (accessed 2026-10)
- [R15] FAA AC 20-107B Composite Aircraft Structure: https://www.faa.gov/documentLibrary/media/Advisory_Circular/AC20-107B.pdf (accessed 2026-10)
- [R16] SAE, Composite Materials Handbook Vol. 2 Rev H (CMH-17-2H): https://saemobilus.sae.org/content/R-484/ (accessed 2026-10)
- [R17] MIL-HDBK-17-3F (2002), EverySpec: https://everyspec.com/MIL-HDBK/MIL-HDBK-0001-0099/MIL_HDBK_17_3F_216/ (accessed 2026-10)
- [R18] NCAMP, Hexcel 8552 IM7 Uni statistical analysis report NCP-RP-2009-028 Rev B: https://wichita.edu/industry_and_defense/NIAR/Documents/NCP-RP-2009-028-Rev-B-HEXCEL-8552-IM7-Uni-SAR-4-16-2019.pdf (accessed 2026-10)
- [R19] A. T. Nettles, Basic Mechanics of Laminated Composite Plates, NASA RP-1351 (1994): https://ntrs.nasa.gov/citations/19950009349 (accessed 2026-10)
- [R20] Research on design rules for composite laminate, Sci. Eng. Compos. Mater. (De Gruyter): https://www.degruyterbrill.com/document/doi/10.1515/secm-2013-0251/html?lang=en (accessed 2026-10)
- [R21] DLR IB-FA-BS-2016-173, design rules consideration (Werthen): https://elib.dlr.de/107894/1/__Bsfait00_fa_Archive_IB_2016_IB_2016_173_MA%20Werthen.pdf (accessed 2026-10)
- [R22] N. Fedon, Stacking-Sequence Design of Composite Laminates with Many Plies (Univ. Bristol): https://www.researchgate.net/profile/Noemie-Fedon/publication/353972607 (accessed 2026-10)
- [R23] C. G. Dávila, P. P. Camanho, Failure Criteria for FRP Laminates in Plane Stress, NASA/TM-2003-212663: https://ntrs.nasa.gov/citations/20040001363 (accessed 2026-10)
- [R24] C. Mack, H. M. Taylor, J. Textile Inst. 47 (1956) T477, cited in Quilliot & Koko, ESAIM M2AN 29(7) (1995): https://www.numdam.org/item/M2AN_1995__29_7_765_0/ (accessed 2026-10)
- [R25] ASTM D6673-10 (withdrawn 2019), Sewn Products Pattern Data Interchange: https://store.astm.org/d6673-10.html (accessed 2026-10)
- [R26] McNeel wiki, Rhino with other programs (laser projector data): https://wiki.mcneel.com/rhino/rhinowithotherprogs (accessed 2026-10)
- [R27] Dassault Systèmes partner solution, CATFiber LASER Projection: https://www.3ds.com/partners/products/100000000000429_PDT00000001833_CATFiber_LASER_Projection_CAA_V6_Apps/ (accessed 2026-10)
- [R28] MBx-IF, Recommended Practices for Composite Materials v4.3: https://www.mbx-if.org/home/wp-content/uploads/2025/10/Rec_Pracs_Composites_V4.3.pdf (accessed 2026-10)
- [R29] MBx-IF, Composite Structure Validation Properties v1.0: https://www.mbx-if.org/home/wp-content/uploads/2026/06/rec_prac_val_prop_composite_v10.pdf (accessed 2026-10)
- [R30] ISO 10303-242 catalogue page: https://www.iso.org/standard/57620.html (accessed 2026-10)
- [R31] Ansys example-data, pyacp/class40/class40.cdb (MIT): https://raw.githubusercontent.com/ansys/example-data/main/pyacp/class40/class40.cdb (accessed 2026-10)

Full verification notes per source: [`validation/sources.md`](validation/sources.md).
