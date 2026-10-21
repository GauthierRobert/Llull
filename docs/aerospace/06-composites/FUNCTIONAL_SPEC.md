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

Operator model per [`../AGENT_FIRST.md`](../AGENT_FIRST.md). Laminate sizing and allowables feed structural
substantiation, so a qualified reviewer is part of this gap whenever a result supports release or a margin is
accepted.

| Role | Who | Uses | In this gap |
| ---- | --- | ---- | ----------- |
| **Operator (primary)** | AI agent (Claude Code or similar) | `llull` CLI (`--doc` or `--app`), MCP for cloud agents | Enters materials, rosettes, zones and plies as plans; runs `check_layup`, `analyze_laminate`, `drape_ply`; reads numeric `data`; exports DXF, laser and ply-book files with `--save` |
| **Owner** | Person asking for "a 600 × 400 skin panel with a pad for a fitting" | Natural language; may watch the desktop app | States the goal, receives a plain-language summary, the files, and the list of items that need a qualified engineer |
| **Qualified reviewer** (stress / composites authority, DOA signatory) | Engineer who owns allowables, margins and the release | Desktop app review surfaces (ply tree, core samples, shear map), check report, 09 PLM approval | Accepts margins, approves rule waivers and over-lock flat patterns, releases the ply book (human gates) |

The domain roles of the previous revision (composite design engineer, stress engineer, manufacturing engineer,
inspector) are now owners or reviewers on whose behalf the agent works.

User stories:

- **US-1 (operator).** Asked for a skin with a pad, I write zones with stacking strings (`[45/-45/0/90]s`, …),
  run `generate_plies_from_zones` and read the generated plies and ramp widths in `data`, without drawing ply
  boundaries.
- **US-2 (operator).** I call `core_sample` at any point and read the ordered plies, materials, orientations
  and thickness (with units) to confirm the stack before analysis.
- **US-3 (operator).** I run `analyze_laminate` and read A, B, D, Ex, Ey, Gxy, νxy and first-ply-failure
  strength ratios with units and provenance. Results built on unverified or mean-basis material values carry
  `unverified`, and any margin result carries `reviewRequired`.
- **US-4 (operator).** For a woven ply on a dome I run `drape_ply` and read the shear angle per node, the
  counts over the warning and lock limits and the named over-lock regions, not a colour map; I add a dart
  (`split_ply`) and re-run until the counts are acceptable.
- **US-5 (operator).** I end every job with `check_layup`: pass / warn / fail findings with stable codes
  (rules R1-R5, ramp conflicts, over-lock plies, FPF margin ≤ 0, unverified materials, defaulted thresholds).
- **US-6 (operator).** I export DXF flat patterns and laser-projection outlines with `--save`, and a ply book
  whose numeric content (`ply_book_data`) I can check before the SVG/PDF sheets are written.
- **US-7 (operator).** Given "a 600 × 400 panel, Nx = 300 N/mm, quasi-isotropic base, pad at the centre", I write
  a plan, run `check_layup` and `analyze_laminate`, adjust the stacks until the margins are positive, and export
  the flat patterns; I report the margins to the owner as "computed by llull, not approved".
- **US-8 (operator).** I hand the layup to 05 FEA as shell sections (ply table per zone) so the stress model and
  the CAD layup cannot diverge.
- **US-9 (owner).** I get one paragraph: what was built, what passed, what needs a qualified engineer.
- **US-10 (qualified reviewer).** I review the layup in the desktop app (ply tree, core samples, shear map from
  the same data), and I alone can accept a negative or marginal margin, approve a rule waiver or an over-lock
  flat pattern, and release the ply book through 09 PLM.

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
| FR-CMP-20 | MUST | Design-rule check through a read-only check command (`check_laminate_rules`, aggregated by `check_layup`, FR-CMP-66) on every core sample / zone stack: R1 symmetric; R2 balanced; R3 minimum fraction per 0/±45/90 family (default 10 %); R4 maximum consecutive same-angle plies (default 4); R5 outer plies ±45. Each finding has a stable code (`CMP_RULE_R1_SYMMETRY` … `CMP_RULE_R5_OUTER_PM45`), the zone or point, the offending plies and a remediation | The commonly published laminate guidelines (CMH-17 / industry), applied by llull so the agent never has to know them (AF-20, AF-30) | [R20], [R21], [R22] |
| FR-CMP-21 | MUST | All rule thresholds are configurable per part; defaults are named in the results with their source (FR-CMP-67). Disabling a rule records a justification; for release the disable is a waiver that only a human approval through 09 PLM makes effective (FR-CMP-71) | Rules vary between programmes; the sources disagree (e.g. 4 vs 5 contiguous) | [R20], [R21] |
| FR-CMP-22 | SHOULD | Additional rules: ply-drop symmetry, maximum angle change between adjacent plies (disorientation, e.g. ≤ 45°), no dropped outer plies, minimum ply width at drops | Common company rules | [R22] |
| FR-CMP-30 | MUST | Lamina stiffness: compute Q and Q̄(θ) for every ply | CLT foundation | [R19] |
| FR-CMP-31 | MUST | Laminate stiffness: compute A, B, D (and the 6×6 inverse) at any core sample or zone. Report engineering constants Ex, Ey, Gxy, νxy for both the membrane (A⁻¹) and the free-bending (ABD⁻¹) definitions, labelled | Stress engineer's daily tool; NASA RP-1351 covers ABD and constants | [R19] |
| FR-CMP-32 | MUST | First-ply failure under a load vector (Nx, Ny, Nxy, Mx, My, Mxy). Ply stresses at the bottom and top of each ply in material axes; strength ratio and failure index for max stress, Tsai-Hill and Tsai-Wu (F12* configurable, default -0.5); critical ply and criterion reported | Sizing; criteria are standard in all tools | [R12], [R19], [R23] |
| FR-CMP-33 | MUST | Laminate mass and thickness: per ply piece, per part, with centre of gravity; integrates with `mass_properties` | Weight is a top driver | — |
| FR-CMP-34 | SHOULD | Laminate hand-off to 05 FEA: per-zone shell section definition (ply table with material, thickness, angle, offset) exported in a solver-neutral JSON and, via 05 FEA, as Nastran PCOMP / CalculiX shell section | Single source of truth between CAD and analysis | 05 FEA |
| FR-CMP-40 | MUST (V1) | Kinematic drape simulation on any exact face. Pin-jointed net from a seed point and a seed direction, constant step, geodesic or user-curve generators; outputs fibre directions and shear angle per node | Mack & Taylor fishnet algorithm, used by Fibersim, CPD, Altair and Creo | [R13], [R14], [R24] |
| FR-CMP-41 | MUST (V1) | Producibility as numbers (AF-21): shear angle per node (deg), counts and area over the material warning shear and locking angle, named over-lock regions per ply, in `data` of `drape_ply` / `check_producibility`; findings `CMP_DRAPE_OVER_LOCK` / `CMP_DRAPE_OVER_WARNING` in `check_layup`. The colour map is a review overlay built on the same data | Fabrics lock beyond a characteristic shear angle | [R13] |
| FR-CMP-42 | SHOULD (V1) | Darts and splices: user-placed cut curves split a ply into pieces (with overlap or butt), and drape is recomputed per piece | Standard remedy for over-shear | [R7] |
| FR-CMP-43 | MUST | Flat patterns. Exact developable unrolling for planes, cylinders and cones (MVP); drape-based flattening for doubly curved faces (V1). Each pattern carries the 0° direction, ply name, sequence and material, and optional excess/trim allowance | Cutter input | [R9] |
| FR-CMP-44 | COULD | Fibre-deviation map: angle between the draped fibre and the design orientation (rosette projection) | Stress knock-down awareness | [R12] |
| FR-CMP-50 | MUST | DXF flat-pattern export: one closed outline per ply piece, layer per ply, text labels, orientation arrow, mm units; optional nesting is V2 | Universal cutter input (ASTM D6673 shows DXF pattern exchange practice) | [R25] |
| FR-CMP-51 | SHOULD (V1) | Ply book: numeric content first (`ply_book_data`: per sequence the ply, material, orientation, area with unit, flat-pattern piece ids, boundary length), then sheets (one per sequence: 3D view of the ply on the part, flat pattern, table) through the existing drawings module, written with `--save`. A ply book for production is released through 09 PLM (human gate) | Shop-floor layup documentation; checkable by an agent before sheets exist | [R7], [R8] |
| FR-CMP-52 | SHOULD (V1) | Laser projection export: per ply, ordered 3D boundary points in tool coordinates with a configurable spacing (default 75 mm) plus every corner, consistent winding, plain-text format | Projector-guided layup | [R26], [R27] |
| FR-CMP-53 | SHOULD | Ply table export/import (CSV): ply, sequence, material, orientation, rosette, zone, area, mass | Excel-driven workflows in CPD | [R8] |
| FR-CMP-54 | SHOULD (V1) | Explicit per-ply solids (offset by cumulative thickness) for visualisation, interference checks and STEP AP214/AP242 export as ordinary solids | Visual verification; explicit AP242 representation | [R28] |
| FR-CMP-55 | COULD (V2) | STEP AP242 composite export following the CAx-IF composite recommended practices (laminate table, ply, orientation, ply boundaries, cores, validation properties) | Supply-chain exchange | [R28], [R29], [R30] |
| FR-CMP-56 | COULD (V2) | Cross-check drape and CLT results against external tools (Ansys ACP via PyACP sample data) | Confidence | [R31] |
| FR-CMP-60 | MUST | Every capability is a registered command with a zod schema and an agent-written description (what, when, units, refusals, next command), so it is available in the CLI (`llull search` / `describe`), MCP and the UI with identical results | Architecture L1/L5; AF-01, AF-02 | CLAUDE.md |
| FR-CMP-61 | MUST | The layup is parametric: stacking strings, zone boundaries, ramp ratios and orientations can reference document parameters; editing one regenerates plies, flat patterns and analyses | L8 recipe | CLAUDE.md |
| FR-CMP-62 | SHOULD | MCP toolset `composites` with discovery prompts ("design a laminate for …") and read-only query tools flagged safe; `llull guide` gains a composites section (units N-mm-MPa, stacking bottom-to-top from the tool, rosette convention, minimal zone plan ending with `check_layup`) (AF-03) | AI-first product | — |
| FR-CMP-63 | MUST | Every physical param states its unit in its schema description (lengths in document units, moduli and strengths in MPa for mm documents, angles in degrees, density in mass per unit³, loads `Nx` in N/mm, `Mx` in N·mm/mm) (AF-04) | No unit inferred silently | AGENT_FIRST |
| FR-CMP-64 | MUST | Every query returns `data` with a documented shape and a unit on every number (`unit` fields or suffixes such as `thicknessMm`, `shearDeg`); large outputs (drape nets, per-node arrays) are paged or written with `--save` (AF-10, AF-12) | Agent-readable results | AGENT_FIRST |
| FR-CMP-65 | MUST | Every refusal and finding has a stable code from TECHNICAL_SPEC §7.1 (e.g. `CMP_NOTATION_PARSE`, `CMP_MATERIAL_NOT_POSITIVE_DEFINITE`, `CMP_ZONES_NOT_BLENDABLE`), the offending ids or param path, and a one-line remediation (AF-11) | Self-correcting agent loop | AGENT_FIRST |
| FR-CMP-66 | MUST | Closing read-only check `check_layup`: aggregates rule findings (FR-CMP-20), ramp conflicts, blending feasibility, over-lock plies (V1), FPF strength ratio < 1 under the stored load cases, missing or unverified material data and defaulted thresholds into one pass / warn / fail list with codes (AF-20, AF-30) | An agent ends every job with it | AGENT_FIRST |
| FR-CMP-67 | MUST | No safety-relevant default is silent: Tsai-Wu F12* (−0.5), rule thresholds (10 %, 4 plies), ramp ratio (20) and drape step are either given or reported as `{value, unit, source, defaulted: true}`. Material allowables and locking angle have **no** default: missing values refuse the dependent analysis with a code (AF-31) | Non-engineer operator | AGENT_FIRST |
| FR-CMP-68 | MUST | Lamina data whose `basis` is `mean` or `unknown`, or whose `source` is not a cited verified reference, is `unverified`; the flag propagates to ABD, constants, FPF ratios, mass and `check_layup` (warning `CMP_MATERIAL_UNVERIFIED`, not suppressible) (AF-32) | Typical textbook values must not pass as allowables | AGENT_FIRST |
| FR-CMP-69 | MUST | `analyze_laminate` FPF results, `check_layup` with `purpose: "release"`, `allowOverLock` flat patterns and the ply book carry `reviewRequired: true` with the reason; summaries say "computed by llull, not approved: needs a qualified engineer" (AF-33, AF-36) | Margins and producibility feed substantiation | AGENT_FIRST |
| FR-CMP-71 | MUST | Human gates: accepting a strength ratio < 1 or a marginal margin, disabling a rule for release, exporting an over-lock flat pattern for production and releasing the ply book need an approval recorded through 09 PLM `record_approval` by a human caller; an agent can prepare the request (`request_layup_waiver`) but the finding stays `fail` with `waiverStatus: "pending"` until approved (AF-34) | Approval acts belong to qualified people | AGENT_FIRST, 09 PLM TR-PLM-16 |
| FR-CMP-72 | MUST | Every computed value carries `provenance` (method: CLT per NASA RP-1351, criterion name and F12*, drape algorithm and step, flat-pattern method; inputs: material record, stack, loads) (AF-35) | Explainable to the owner, auditable by the reviewer | AGENT_FIRST |
| FR-CMP-70 | MUST | Performance: a 200-ply, 3-zone panel regenerates in ≤ 2 s; drape at 17 k nodes ≤ 500 ms on the desktop reference machine | Interactive use | — |

## 6. Workflows

### 6.1 CLI (primary: the operator agent), zone-based skin panel (MVP)

```bash
llull search laminate ply drape                 # ranks the composites toolset
llull describe create_lamina_material           # units of every param (MPa, mm, deg), refusals, next command
llull guide                                     # composites section: units, stacking bottom-to-top, minimal plan
# 1. plan file: material, rosette, part on the tool face, zones, ply-drop rules, generation, core samples, checks
#    (validation/plans/cmp-flat-panel-zones.json)
llull run cmp-flat-panel-zones.json --validate --doc panel.llull.json --kernel occt     # step path + param + code
llull run cmp-flat-panel-zones.json --doc panel.llull.json --kernel occt --progress --json
# 2. numbers
llull core_sample part=part-5.1 'point=[300,200,0]' --doc panel.llull.json --kernel occt --json   # 24 plies, thicknessMm 3.0
llull analyze_laminate '{"part":"part-5.1","point":[50,50,0],"loads":{"Nx":300},"criteria":["tsai_wu"]}' --doc panel.llull.json --json
#    data.firstPlyFailure.tsai_wu.R, data.unverified, data.reviewRequired, data.provenance
# 3. closing check: rules R1-R5, ramps, blending, FPF ratio, unverified materials, defaulted thresholds
llull check_layup part=part-5.1 --doc panel.llull.json --kernel occt --json
# 4. look at it
llull render_view view=iso isolate=part-5.1 --doc panel.llull.json --kernel occt --save out/panel.png
# 5. deliver
llull export_ply_flat_patterns_dxf part=part-5.1 --doc panel.llull.json --kernel occt --save out/flats.dxf
llull export_ply_table part=part-5.1 --doc panel.llull.json --save out/plies.csv
llull export_ply_book part=part-5.1 format=svg --doc panel.llull.json --kernel occt --save out/plybook/
```

If a step is refused, the CLI exits 1 with a code from TECHNICAL_SPEC §7.1 and a remediation; the agent edits
the plan (for example a stacking string named by `CMP_NOTATION_PARSE`) and re-validates. If `check_layup` fails
on a margin, the agent edits the zone stacks (`edit_zone`) and repeats. It never accepts a failing margin itself:
that is `request_layup_waiver` plus a human approval in 09 PLM. `--dry-run` tries an edit without writing.

### 6.2 CLI, doubly curved woven ply (V1)

1. Plan `validation/plans/cmp-hemisphere-drape.json`: material with an explicit `lockingAngle` and
   `warningShear` (no default, FR-CMP-67), part on the dome face, `add_ply` with drape settings (seed point,
   direction, `stepLength` in mm).
2. `llull drape_ply ply=<id> output=summary --json`: `data.maxShearDeg`, `data.nodesOverWarning`,
   `data.nodesOverLock`, `data.overLockRegions[]`; `output=nodes --save net.json` for the full net.
3. `llull check_producibility part=<id> --json`; add a dart (`split_ply`) and re-drape; `check_layup` lists
   `CMP_DRAPE_OVER_LOCK` until the counts are acceptable.
4. `render_view … --save dome.png` to look at the net; export the drape-based flat pattern and the laser
   projection with `--save`. An over-lock pattern needs `allowOverLock` and carries `reviewRequired`.

### 6.3 MCP agent (cloud)

1. `search_tools laminate ply`, then `enable_toolset composites`.
2. `build_project` with the same plan; loop `check_layup` (read-only) and `analyze_laminate` (read-only); edit
   zone stacks with `edit_zone` until no failure remains.
3. `export_ply_flat_patterns_dxf` returns the DXF text or a resource link.
4. Every step lands in the feature history; the user can undo any agent step in the desktop app.

### 6.4 UI (review and approval surface)

The desktop app shows the ply tree, zone table, core-sample tooltip and shear-map overlay, all built from the
same query `data`. The qualified reviewer uses it with the `check_layup` report to accept margins, approve
waivers and over-lock patterns, and release the ply book through 09 PLM. Ribbon actions for every command exist
because the UI iterates `listCommands()`; no capability depends on them.

## 7. Acceptance criteria

Each criterion is a CLI call with `--json` and an assertion against `validation/expected_results.json`
(`cli_by_vc` gives the call and JSON path per VC). `D` = `--doc t.llull.json --kernel occt --json`.

| # | Given | When (CLI) | Then (JSON assertion) | VC |
| - | ----- | ---------- | --------------------- | -- |
| AC-1 | T300/5208 with the Tsai-Hahn constants | `llull analyze_laminate '{"angles":[0,0,0,0,0,0,0,0],"material":"T300_5208"}' D` | `data.Q.Q11` = 181 800 ± 0.1 % MPa, `data.Q.Q22` = 10 340 ± 0.1 %, `data.constantsMembrane.Ex` = E1 (rel 1e-9) | VC-CMP-01, 02 |
| AC-2 | [0/45/-45/90]s and [0/60/-60]s | `analyze_laminate` on each | `data.A` A11 = A22 = U1·h, A16 = 0, B = 0; `constantsMembrane.Ex` = 69 675.7 MPa both | VC-CMP-03, 04 |
| AC-3 | [0/90]T, 0° ply at the bottom | `analyze_laminate` | `data.B[0][0]` = −1 339.57 N, `data.B[1][1]` = +1 339.57 N | VC-CMP-05 |
| AC-4 | Nx = 1 N/mm | `analyze_laminate … loads={"Nx":1} criteria=[max_stress,tsai_hill,tsai_wu]` | `data.firstPlyFailure.*.R` equal `clt_reference.json` within 1e-4; critical ply named; `data.reviewRequired = true` | VC-CMP-06, 07 |
| AC-5 | 10 stacking strings | `define_zone` + `check_laminate_rules` per string | expansion and R1-R5 verdicts equal `layup_rules_reference.json`; failing rules carry `CMP_RULE_*` codes | VC-CMP-08, 09 |
| AC-6 | `cmp-flat-panel-zones` plan | `llull run … D`; `core_sample` at two points | 8 plies / `thicknessMm` 1.0 and 24 plies / 3.0; ramp widths n·t·20 | VC-CMP-10, 11 |
| AC-7 | hemisphere R = 100, seed at the pole, step 1 mm | `llull drape_ply ply=$p1 output=summary D` | shear at polar 45° on the diagonal 15.7 ± 0.6°; Gauss-Bonnet residual ≤ 0.5°; `data.maxShearDeg` 51.9 ± 1.0 | VC-CMP-12 |
| AC-8 | locking angle 40° | `check_producibility` / `check_layup` | ≈ 8.5 % of the quadrant flagged; finding `CMP_DRAPE_OVER_LOCK`; `export_ply_flat_patterns_dxf` refused with `CMP_FLAT_OVER_LOCK` unless `allowOverLock` | VC-CMP-13 |
| AC-8b | hemisphere ply split by 4 darts along the generators | `split_ply` ×4, then `drape_ply` per piece along its bisector | 4 pieces; shear 0 ± 0.05° on each bisector, 15.7 ± 0.6° at the piece-edge node near polar 45° | VC-CMP-33 |
| AC-9 | cylinder and cone plies | `export_ply_flat_patterns_dxf … --save` + `data` | width 2πr; cone sector angle 254.558°, area 44 428.8 mm² | VC-CMP-14, 15 |
| AC-10 | cone flat pattern | `export_ply_flat_patterns_dxf --save cone.dxf`, `import_dxf file=cone.dxf`, `measure_area` | area within 0.2 %; layer per ply; `$INSUNITS = 4` | VC-CMP-16 |
| AC-11 | any ply | `export_laser_projection --save laser.txt` | point spacing ≤ 75 mm, corners present, consistent winding | VC-CMP-17 |
| AC-12 | any plan in `validation/plans` | CLI, MCP `build_project`, UI dispatch | identical documents and query data; commands pure | VC-CMP-20, 21 |
| AC-13 | a plan with `[45/-45/0/9O]s` (letter O), ν12 = 1.1 with E1 = E2, and unblendable zones | `llull run bad.plan.json --validate D` / run | exit 1; codes `CMP_NOTATION_PARSE`, `CMP_MATERIAL_NOT_POSITIVE_DEFINITE`, `CMP_ZONES_NOT_BLENDABLE` with path and remediation | VC-CMP-34 |
| AC-14 | AS4/3501-6 entered with `basis: "mean"` | `analyze_laminate`, `laminate_mass`, `check_layup` | `data.unverified = true` on each; warn `CMP_MATERIAL_UNVERIFIED` not suppressible | VC-CMP-35 |
| AC-15 | the flat panel, no F12* and no rule thresholds given | `analyze_laminate`, `check_layup purpose=release` | `data.defaults.tsaiWuF12Star = {value: −0.5, defaulted: true, source}`; thresholds named; `reviewRequired = true` with reason | VC-CMP-36 |
| AC-16 | Nx = 400 N/mm on Z-base (R < 1) | `check_layup`, `request_layup_waiver`, 09 `record_approval` as agent | `CMP_FPF_RATIO_BELOW_ONE` fail; approval refused; `waiverStatus: "pending"` | VC-CMP-37 |
| AC-17 | every composites command | `llull describe <cmd> --json`, result audit | no numeric param or result number without a unit; `llull search laminate` finds the main commands | VC-CMP-38 |

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
| Validation cases passing on desktop OCC | 100 % of MVP VCs (01-11, 14-16, 18, 20, 21, 31, 32, 34-38) before MVP release; V1 VCs before V1 |
| CLT agreement with the reference generator | rel ≤ 1e-4 on all 14 cases |
| Time to define a 3-zone, 24-ply panel and export flats (expert user) | ≤ 15 min (baseline: hand-drawn plies in a generic CAD, TBD measure) |
| Agent success rate (US-7 benchmark prompt, 10 runs, CLI only) | ≥ 8/10 produce a rule-clean laminate with positive FPF margin, end with `check_layup`, and report `reviewRequired` items to the owner |
| Self-check coverage | 100 % of refusals carry a code from TECHNICAL_SPEC §7.1; every VC runs from `cli_by_vc` without the UI (AF-23) |
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
| The operator is an agent and the owner is not a stress engineer | Textbook material values or a negative margin reported as "done" | No allowable defaults; `unverified` propagation; `check_layup` ends every job; `reviewRequired` on margins; waivers and releases are human gates (FR-CMP-66..71) |

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
