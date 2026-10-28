# UXD — Interaction depth for daily drafting and modelling — Functional specification

Gap id: **UXD** · Folder: `docs/readiness/02-drafting-interaction/` · Status: specification (2026-10-28), not built ·
Track: professional readiness ([`../README.md`](../README.md)), default level **PRL 3 daily-capable**
([`../VALIDATION.md`](../VALIDATION.md)) · Companion: [TECHNICAL_SPEC.md](TECHNICAL_SPEC.md) · Validation:
[validation/README.md](validation/README.md) · Neighbours: **06 E2E** (the Electron harness that runs the `electron` cases),
**03 PRF** (perf runner and corpus), **01 PIL** (pilot users who give the measured task times), **04 DSF** (undo guarantees),
design pack [`../../design/04-direct-freeform-editing`](../../design/04-direct-freeform-editing/) (3D sub-element gizmo sessions,
not repeated here).

---

## 1. Summary

llull has ~330 core commands plus the plugin commands, every one reachable from the Ctrl+K palette and the CLI. What it lacks is the
**interaction layer professionals use those commands through**. A drafter coming from AutoCAD or BricsCAD types `C`, Enter, snaps
to an intersection, types `25`, Enter, and presses Space to do it again; a SOLIDWORKS modeller selects four edges with Ctrl and
types a radius. In llull today (origin/main f1351cff, code audit TECHNICAL_SPEC §1):

- **No precise entry in the click flow.** Draw tools take points from clicks only (`drawToolTable.ts`: "Params come from clicks
  only"); there is no coordinate grammar (`@`, `<`, `#`), no direct distance entry, no dynamic input, no cursor coordinate readout;
  and with no snap target in reach the cursor is **always rounded to the adaptive grid** (`resolveSnap.ts`), so a free point
  cannot even be placed.
- **No command line.** The palette is a fuzzy search plus generated forms: no aliases, no prompts with keyword options, no repeat
  of the last command, no default values, no transparent view commands (2D pan is disabled while a tool is armed).
- **Snaps without control.** 8 object snap types + grid, all always on (extension / nearest always off), no per-mode toggles, no
  override, no tooltip, no cycling, no quadrant / node / insertion / geometric centre / apparent intersection / parallel, no object
  snap tracking; polar tracking is coded but unreachable; 3D gizmo snaps use bounding-box points, not real vertices.
- **No grips on 2D geometry**, no selection cycling, no 3D box selection, no select-similar, multi-selection Properties show a
  count only, no match properties, no layer states, a fixed (non-customisable) keymap with no F-keys, no view cube.

Of the 15 benchmark tasks of this pack (validation/data/benchmark_tasks.json) **8 can be completed to spec precision in the UI
today**. Where a flow exists it is competitive: on those 8 tasks the KLM-predicted expert time is 73.46 s for llull today against
75.58 s for the incumbent method (derivation: `validation/generate_refs.mjs` → `data/klm_predictions.json`). The gap is
**coverage of precise, keyboard-driven input**, not speed of the gestures that exist.

This pack defines the professional interaction baseline (§2.2), 47 functional requirements (§5), and a validation layer: a task
benchmark with KLM-predicted expert times from cited operator times, parity checklist cases, latency budgets and the measured
human-time ratio against the incumbent (TBD — measured in the pilot). The PRIME DIRECTIVE holds without exception: **every gesture
commits exactly one registered command**; the UI only gathers parameters; preferences (snaps, keymap, aliases, navigation preset)
are user settings, never document state.

## 2. Context and value

### 2.1 The incumbent interaction models

| Product | Interaction model (what a daily user relies on) | Source |
| ------- | ----------------------------------------------- | ------ |
| AutoCAD | Command prompt + aliases in `acad.pgp` (`abbreviation, *command`, last definition wins; Autodesk: "the Command prompt remains the fastest and most efficient way to execute a command") | [R1][R2] |
| AutoCAD | 14 running object snaps (Endpoint … Parallel), master toggle, object snap tracking, Tab cycles candidates | [R3] |
| AutoCAD | F3 osnap, F8 ortho, F10 polar (F8 / F10 mutually exclusive), F11 tracking, F12 dynamic input | [R4] |
| AutoCAD | Dynamic Input: 2nd point relative by default, `#` absolute, `<` polar; direct distance entry | [R5] |
| AutoCAD | Window (left→right, fully inside) vs crossing (right→left, touching); lasso; selection cycling Shift+Space | [R6][R7] |
| AutoCAD | Multifunctional grips: Stretch / Add / Remove vertex, Lengthen on endpoints | [R8] |
| AutoCAD | Enter / Space / right-click repeats; `'ZOOM` transparent; Quick Properties; MATCHPROP settings; layer states | [R9]–[R12] |
| AutoCAD | Command-line AutoComplete (prefix and mid-string), AutoCorrect, synonym search | [R13] |
| BricsCAD | Quad cursor menu (hover, entity-dependent, alternative to grips); entity snap tracking (STRACK) | [R14][R15] |
| Revit | Listening / temporary dimensions while placing; a typed value sets the dimension | [R22] |
| SOLIDWORKS | S-key shortcut bar per mode (part / assembly / drawing / sketch); mouse gestures 2–12 directions; inferencing lines and automatic relations (Ctrl suppresses); rollback bar | [R16]–[R19] |
| Fusion | Pan / zoom / orbit presets: Fusion (middle pan, Shift+middle orbit, wheel zoom), SolidWorks, Inventor, Tinkercad, Alias, PowerMill | [R20] |
| Onshape | Every keyboard shortcut customisable per area, reset one / all | [R21] |
| 3Dconnexion | Certified support: navlib / 3DconnexionJS (SDK ≥ 4), frame rate as with a 2D mouse, centre of rotation shown, enabled by default, all commands exported to device buttons | [R23] |

### 2.2 Professional baseline: prioritised parity matrix

Status today: ✔ met · ◐ partial · ✘ missing (evidence: TECHNICAL_SPEC §1). Rows with the same id are tracked in
`validation/data/parity_checklist.json` (VC-UXD-56).

**2D drafting (reference: AutoCAD / BricsCAD)**

| # | Capability | AutoCAD / BricsCAD | llull today | Pri | FR |
| - | ---------- | ------------------ | ----------- | --- | -- |
| P2-01 | Command line, autocomplete, prompts with options | ✔ [R13] | ◐ palette + forms | MUST | 01 |
| P2-02 | Editable aliases | ✔ [R1][R2] | ✘ | MUST | 02 |
| P2-03 | Repeat last, defaults | ✔ [R9] | ◐ 5 recents | MUST | 03 |
| P2-04 | Transparent view / settings | ✔ [R9] | ◐ zoom only | MUST | 04 |
| P2-05 | Coordinate grammar `@ < #`, direct distance | ✔ [R5] | ✘ | MUST | 06 |
| P2-06 | Dynamic input at cursor | ✔ [R5] [R22] | ◐ 3D ValueBox | MUST | 07 |
| P2-07 | Cursor coordinate readout | ✔ | ✘ | MUST | 09 |
| P2-08 | 14 running snaps, toggles | ✔ [R3] | ◐ 8 fixed | MUST | 10 |
| P2-09 | One-pick override | ✔ [R3] | ✘ | MUST | 11 |
| P2-10 | Snap tooltip, Tab cycle, aperture | ✔ [R3] | ◐ glyph | MUST | 12 |
| P2-11 | Grid snap off | ✔ | ✘ always on | MUST | 13 |
| P2-12 | Ortho / polar toggles | ✔ [R4] | ◐ held Shift | MUST | 14 |
| P2-13 | Object snap tracking | ✔ [R3][R15] | ✘ | MUST | 15 |
| P2-16 | Window / crossing (2D + 3D), click-click | ✔ [R6] | ◐ 2D drag | MUST | 18 |
| P2-17 | Selection cycling | ✔ [R7] | ✘ | MUST | 19 |
| P2-18 | Select all / previous / invert | ✔ | ◐ | MUST | 20 |
| P2-20 | Noun-verb + verb-noun | ✔ | ◐ | MUST | 22 |
| P2-22 | Grips + multifunctional menu | ✔ [R8][R14] | ✘ | MUST | 24, 25 |
| P2-24 | Copy / rotate / scale / mirror / stretch / break / join / lengthen by clicks | ✔ | ◐ | MUST | 27 |
| P2-25 | Arc + dimension tools, LINE chaining | ✔ | ✘ | MUST | 28, 29 |
| P2-26 | Properties multi-edit, quick properties | ✔ [R10] | ◐ | MUST | 30 |
| P2-27 | Match properties | ✔ [R11] | ✘ | MUST | 31 |
| P2-28 | Current layer, layer states | ✔ [R12] | ◐ | SHOULD | 32 |
| P2-29 | Customisable keymap | ✔ [R21] | ✘ | MUST | 33 |
| P2-30 | F-key / status toggles | ✔ [R4] | ✘ | MUST | 34 |
| P2-19 | Select similar / quick select | ✔ | ✘ | SHOULD | 21 |

**3D modelling and navigation (reference: SOLIDWORKS / Fusion)**

| # | Capability | SOLIDWORKS / Fusion | llull today | Pri | FR |
| - | ---------- | ------------------- | ----------- | --- | -- |
| P2-14 | Snaps on true vertices / edges / circle centres | ✔ | ◐ AABB points | MUST | 16 |
| P2-21 | Pick filters edges / faces / bodies, hover | ✔ | ◐ in edit modes only | SHOULD | 23 |
| P2-15 | Sketch inference | ✔ [R18] | ✘ | SHOULD | 17 |
| P2-23 | Triad with typed values, pivot | ✔ | ◐ | SHOULD | 26 |
| P2-31 | S-key bar, mouse gestures | ✔ [R16][R17] | ◐ context menu | SHOULD / COULD | 35, 36 |
| P2-32 | Navigation presets, pan during a command | ✔ [R20] | ◐ | MUST | 38 |
| P2-33 | View cube, orbit about point, previous view | ✔ | ◐ triad + presets | MUST | 39 |
| P2-34 | 3D mouse at certification level | ✔ [R23] | ◐ WebHID, unverified | MUST | 40 |
| P2-35 | Preview before commit, every tool | ✔ | ◐ | MUST | 41 |
| P2-36 | Prompt with options / defaults | ✔ | ◐ HintBar | MUST | 42 |
| P2-37 | Rollback marker | ✔ [R19] | ✘ | SHOULD | 43 |
| P2-38 | WCAG 2.2 AA keyboard / dragging | — | ◐ | MUST | 45 |

What llull already does **better than** the incumbents and must keep: one registry behind every surface (any of ~330 commands is
one Ctrl+K away), "Copy as CLI" parity, previews computed by the same pure `execute` as the commit, deterministic replay.

### 2.3 Evidence that drives the priorities

- **Keyboard paths are faster but under-used.** KLM: "even the simplest keystroke level analysis indicates that using a hotkey will
  be faster than clicking on an icon" [R34]; experienced users still rarely switch to shortcuts [R35]; in-product cues (audio
  feedback, disabling the menu path) increased hotkey use "by over 100%" [R34]. ⇒ aliases, shortcuts shown in every tooltip, and
  learning aids (FR-UXD-37) — not only a keymap.
- **Operator times** (grade A, [R25] with [R26]): K 0.28 s, P 1.1 s, B 0.1 s, BB 0.2 s, H 0.4 s, M 1.2 s (1.35 s in [R26]).
  A pick (M P BB = 2.5 s) costs about nine keystrokes; a precise value typed into a dialog that must first be opened costs one
  extra pick plus two homings (2.5 + 0.8 s). This is why typed values at the cursor (FR-UXD-06/07) and Space-repeat (FR-UXD-03)
  carry the largest per-task savings in `data/klm_predictions.json`.
- **Latency limits**: 0.1 s for "reacting instantaneously" [R29]; at 60 Hz one frame is 1000 / 60 = 16.7 ms (derived).
- **Accessibility**: WCAG 2.2 SC 2.5.7 requires a single-pointer alternative to every drag — the click-one-corner-then-the-other
  selection box is W3C's own example [R32]; SC 2.1.1 keyboard and 2.4.11 focus not obscured apply to the command line and panels
  [R33].

### 2.4 Value

The readiness question is daily use. A professional judges a CAD tool first by whether their hands can work without thinking
about the tool; a missing `@dx,dy` or a cursor that cannot leave the grid ends an evaluation in minutes regardless of the command
depth behind it. Closing UXD is the condition for PRL 3 (with 08 XCH and 07 VNV) and for any meaningful pilot (01 PIL): pilot
time-on-task numbers taken before this pack lands would measure missing input paths, not llull.

## 3. Personas and user stories

| Persona | Story | FRs |
| ------- | ----- | --- |
| Civil / site drafter (AutoCAD background, 15 years) | "I type `L`, Enter, snap the kerb end, `@12.5<35`, Enter, and Space for the next one — without looking at the keyboard." | 01–07, 10–15 |
| Steel detailer (AutoCAD / Tekla) | "I window-select a gusset group, stretch it with a crossing, and grip-edit a plate corner to a grid intersection." | 18, 24, 27 |
| Plant designer (Plant 3D / BricsCAD) | "I need my own aliases and keys; I will not relearn 400 shortcuts." | 02, 33, 34 |
| Mechanical designer (SOLIDWORKS) | "Ctrl-pick four edges, `3`, Enter. Double-click a feature dimension, type, done. My SpaceMouse just works." | 16, 23, 26, 38–40, 43 |
| Engineer with a motor impairment | "Everything I can drag I can also click; everything I can click I can reach from the keyboard." | 18, 45 |
| AI agent (CLI) | "Every gesture my user makes is a command I can replay; the command line text is my CLI call." | 05, 46 |

## 4. Scope

### 4.1 Phases

| Phase | Content | FRs |
| ----- | ------- | --- |
| **M1 Precision input** | coordinate grammar, dynamic input, cursor readout, grid-snap toggle, ortho / polar toggles, F-keys, status toggles | 06, 07, 09, 13, 14, 34 |
| **M2 Command line** | command line, aliases, repeat, transparent view, prompts, history / copy as plan, LINE chaining, arc + dimension tools | 01–05, 28, 29, 42 |
| **M3 Snap and track engine** | 14 modes, toggles, override, cycling, tooltip, tracking, spatial index, 3D true-geometry snaps | 10–12, 15, 16, 44 |
| **M4 Selection and grips** | window / crossing 2D+3D, click-click, cycling, select all / previous / invert, verb-noun, grips + `edit_grip`, pick filters | 18–20, 22–25 |
| **M5 Modify and properties** | click flows, new 2D modify commands, Properties multi-edit, quick properties, match properties, layers | 27, 30–32 |
| **M6 Keyboard and navigation** | keymap editor + presets, shortcut bar, navigation presets, view cube, 3D mouse native | 33, 35, 38–40 |
| **M7 Benchmark** | task benchmark on the harness, pilot timing, parity review | 47 |
| Later (SHOULD / COULD) | select similar, sketch inference, gizmo typed values, rollback marker, gestures, learning aids, layer states | 17, 21, 26, 32, 36, 37, 43 |

### 4.2 Out of scope

- 3D sub-element gizmo sessions, cage / pole editing, falloff (design pack 04 DIR, FR-DIR-01..09).
- New geometry capabilities beyond the four 2D modify commands of FR-UXD-27; drawing-sheet layout UX; DWG fidelity (08 XCH).
- Touch / pen input; VR; localisation of prompts (09 COM).
- Cloud usage telemetry or any network-based recommendation (product directive: local only).

## 5. Functional requirements

Columns: landing = where it lands (command / UI); every gesture ends in the named registered command. "UI-only" = presentation or
user preference with no document change (TECHNICAL_SPEC §3.3).

### 5.1 Command entry

| Id | Pri | Requirement | Landing | Source |
| -- | --- | ----------- | ------- | ------ |
| FR-UXD-01 | MUST | **Command line** docked at the bottom of the viewport. Typing while the canvas has focus goes to it. Accepts any registered command name, alias or synonym; AutoComplete by prefix and mid-string with a suggestion list (command, alias, toolset, key); Enter starts the command; the command then **prompts** for its parameters in order (points by pick or typed coordinate, numbers typed or picked as distances, ids by picking, enums as keyword options `[Close/Undo]`); each completed prompt sequence dispatches exactly one command. | UI over `listCommands()` + per-command prompt metadata derived from the zod schema (TR-UXD-06) | [R13] |
| FR-UXD-02 | MUST | **Aliases**: a default alias table shipped with llull, an AutoCAD-compatible preset (names mapped to llull commands), and a user file in `abbreviation, *command` syntax (`;` comments, last definition wins) importable from an existing `acad.pgp`; unknown targets reported, never silently dropped. | UI-only preference; file in the user profile | [R1][R2] |
| FR-UXD-03 | MUST | **Repeat**: Enter or Space at an empty prompt repeats the last command; right-click → "Repeat ‹name›" and "Recent ▸"; numeric prompts default to the last value used (shown in `<>`), Enter / Space accepts it; a "multiple" mode re-arms the same command until Esc. | UI | [R9] |
| FR-UXD-04 | MUST | **Transparent actions** during any armed tool or prompt: zoom, pan (middle-drag and keys), view presets, view cube, snap / ortho / polar / tracking / grid toggles, layer visibility. They never end the tool, never drop collected points, never dispatch a document command. | UI | [R9] |
| FR-UXD-05 | MUST | **History and parity**: a command-history pane lists each dispatched command with its summary; any entry or the whole session can be copied as a CLI call or as `build_project` plan steps. | UI over the command log | AF |

### 5.2 Coordinate and value entry

| Id | Pri | Requirement | Landing | Source |
| -- | --- | ----------- | ------- | ------ |
| FR-UXD-06 | MUST | **Coordinate grammar** at every point prompt: absolute `x,y[,z]`, relative `@dx,dy[,dz]`, polar `d<a` / `@d<a` (degrees CCW from +X), `#` absolute override when dynamic input makes relative the default, **direct distance entry** (a bare number along the current cursor / ortho / polar direction), unit suffixes (`mm cm m in ft`), arithmetic and `=parameter` references. Errors give the code and the column. | pure grammar in core `lib` (TR-UXD-02); the result feeds the prompting command's params | [R5][R31] |
| FR-UXD-07 | MUST | **Dynamic input**: next to the cursor, editable fields for the active prompt (length and angle for a segment, width and height for a rectangle, radius for a circle…); typing goes to the first field, Tab moves and **locks** a field, Enter commits; locked values constrain the rubber band. F12 toggles. | UI; values become the same params | [R5][R22] |
| FR-UXD-08 | SHOULD | Every numeric field (palette forms, Properties, ValueBox, dynamic input) accepts the same expression / unit / parameter syntax as FR-UXD-06 and shows the evaluated value. | UI over the core grammar | [R31] |
| FR-UXD-09 | MUST | **Units and precision display**: status-bar readout of the snapped cursor (absolute / relative / polar, click to switch), formatted at the document's display precision; angle display in degrees (decimal) with the precision setting; fractional / architectural formats COULD. | UI; precision is existing document data (`set_units`) | — |

### 5.3 Object snaps, tracking, inference

| Id | Pri | Requirement | Landing | Source |
| -- | --- | ----------- | ------- | ------ |
| FR-UXD-10 | MUST | **Running snap modes**, each toggled independently and persisted per user: Endpoint, Midpoint, Center, Geometric Center, Node, Quadrant, Intersection, Extension, Insertion, Perpendicular, Tangent, Nearest, Apparent Intersection, Parallel; master toggle (F3); "select all / clear all". | UI-only preference + snap engine | [R3] |
| FR-UXD-11 | MUST | **One-pick override**: Shift+right-click menu or typing the mode code (`end`, `mid`, `int`, `cen`, `qua`, `per`, `tan`, `nea`, `ext`, `par`, `nod`, `ins`, `gce`, `app`) at a point prompt restricts the next pick to that mode only. | UI | [R3] |
| FR-UXD-12 | MUST | **Snap feedback**: marker glyph + tooltip with the mode name; Tab cycles the candidates inside the aperture; aperture size in screen pixels is a user setting. | UI | [R3] |
| FR-UXD-13 | MUST | **Grid snap is a toggle** (F9), independent of the grid display; when off and no object snap is in the aperture, the point is the raw cursor. | UI | — |
| FR-UXD-14 | MUST | **Ortho** (F8, and held Shift as a temporary inversion) and **polar tracking** (F10) with increments 90 / 45 / 30 / 22.5 / 15 / 10 / 5° and user additional angles; ortho and polar are mutually exclusive; the tracking line and the angle are shown. | UI + snap engine | [R4] |
| FR-UXD-15 | MUST | **Object snap tracking** (F11): hovering a snap point acquires it (marker), alignment paths run from acquired points horizontally, vertically and at the polar angles; the cursor snaps to a path and to the intersection of two paths; acquired points clear on the next pick or by re-hovering. | UI + tracking engine (TR-UXD-04) | [R3][R15] |
| FR-UXD-16 | MUST | **3D snaps on true geometry**: B-rep / mesh vertices, edge midpoints, nearest on edge, circular-edge centres, face centroid, with the same toggles / tooltip / Tab cycling, used by the gizmo, 3D placement and sketch planes. | UI + BVH / topology query (TR-UXD-05) | — |
| FR-UXD-17 | SHOULD | **Sketch inference** while drawing on a sketch plane or in 2D with "infer constraints" on: horizontal, vertical, coincident, tangent, perpendicular, parallel, equal shown as dotted inference lines and glyphs; on commit the inferred constraints are dispatched **with** the geometry as one `build_project` (one undo step); Ctrl held suppresses. | `draw_*` + `add_constraint` in one plan | [R18] |

### 5.4 Selection

| Id | Pri | Requirement | Landing | Source |
| -- | --- | ----------- | ------- | ------ |
| FR-UXD-18 | MUST | **Window / crossing** by drag direction in 2D **and 3D** (3D: screen-space box over projected geometry, honouring the pick filter), distinct styling (solid / dashed), **click-click** box without dragging, lasso (COULD), fence (COULD). | `set_selection` | [R6][R32] |
| FR-UXD-19 | MUST | **Selection cycling** of overlapping candidates: Shift+Space or a badge + list under the cursor. | `set_selection` | [R7] |
| FR-UXD-20 | MUST | Modifiers and set operations: click replaces, Shift / Ctrl click toggles, Ctrl+A all visible unlocked, "previous selection", invert, deselect all; locked layers are not selectable. | `set_selection` | — |
| FR-UXD-21 | SHOULD | **Select similar / filter**: by kind, layer, colour, material, name pattern, numeric property range. | query commands `select_similar`, `select_by_filter` → `set_selection` | — |
| FR-UXD-22 | MUST | **Noun-verb and verb-noun**: every modify command accepts the current selection; with nothing selected it prompts "Select objects" (click, box, Enter to finish) and then continues. | prompt driver | — |
| FR-UXD-23 | SHOULD | **3D pick filters** (bodies / faces / edges / vertices / sketch geometry) and hover pre-highlight; edges and faces selectable outside the freeform edit modes; Ctrl / Shift multi-pick. | `set_selection` with sub-element references | — |

### 5.5 Grips and direct manipulation

| Id | Pri | Requirement | Landing | Source |
| -- | --- | ----------- | ------- | ------ |
| FR-UXD-24 | MUST | **2D grips** on selected entities: end / mid / vertex / centre / quadrant / text insertion / dimension points. A click makes a grip hot; the hot grip follows the cursor with snaps, tracking and typed values (FR-UXD-06/07); release / pick commits **one command**; hover shows a multifunctional menu (Stretch, Lengthen, Add vertex, Remove vertex, Convert to arc where valid); Space on a hot grip cycles Stretch → Move → Rotate → Scale → Mirror (each committing its existing command). | `edit_grip` (TR-UXD-08) or the existing move / rotate / scale / mirror commands | [R8][R14] |
| FR-UXD-25 | MUST | **Grips are a command-level concept**: `list_grips` (query) returns the grips of an entity with stable grip ids; `edit_grip` applies one grip operation; an agent can do every grip edit without a screen. | core commands | AF |
| FR-UXD-26 | SHOULD | **3D triad** (existing TransformGizmo): typed value during a drag, pivot moved to a snapped point, orientation World / Entity / Face normal. Sub-element sessions stay in pack 04 DIR. | `move_entities` / `rotate_entity` / `scale_entity` | — |

### 5.6 Draw and modify flows

| Id | Pri | Requirement | Landing | Source |
| -- | --- | ----------- | ------- | ------ |
| FR-UXD-27 | MUST | **Click flows** for copy (multiple, base point, with `@`/direct distance), rotate (base, angle or reference), scale (base, factor or reference), mirror (two points, keep / erase source), array preview, stretch (crossing + base / displacement); new commands `stretch_2d`, `break_2d`, `join_2d`, `lengthen_2d`; trim / extend "quick" mode (every visible object is a boundary; pick the part to remove). | existing commands + 4 new (TR-UXD-09) | — |
| FR-UXD-28 | MUST | **Arc tool** (3-point, start-centre-end, centre-start-end, tangent continuation from the last segment) and **dimension tools** (linear, aligned, angular, radius, diameter) placed by snapped picks. | `draw_arc`, `add_dimension` | — |
| FR-UXD-29 | SHOULD | **LINE chains** segment after segment until Enter / Esc, with keyword options Close and Undo; polyline adds Arc / Line segment modes. | `draw_polyline` (one per chain) | — |

### 5.7 Properties and layers

| Id | Pri | Requirement | Landing | Source |
| -- | --- | ----------- | ------- | ------ |
| FR-UXD-30 | MUST | **Properties for multi-selection**: common fields shown, differing ones as "*varies*"; an edit applies to all selected in **one** command; geometry fields (length, radius, width, height, start / end, centre) editable per kind; **quick properties** popup on selection (off / all / configured kinds). | existing set_* commands, `edit_grip`, batch via `build_project` | [R10] |
| FR-UXD-31 | MUST | **Match properties**: pick a source, choose which properties (layer, colour, line type / weight, material, text / dimension style), pick targets. | `match_properties` | [R11] |
| FR-UXD-32 | SHOULD | **Layer workflow**: current layer (new entities land on it), layer drop-down in the top bar showing the selection's layer, make-object's-layer-current, isolate / unisolate layer, **layer states** save / restore / delete. | `set_current_layer`, `update_layer`, `save_layer_state`, `restore_layer_state`, `delete_layer_state` | [R12] |

### 5.8 Keyboard and customisation

| Id | Pri | Requirement | Landing | Source |
| -- | --- | ----------- | ------- | ------ |
| FR-UXD-33 | MUST | **Customisable keymap**: every registered command and every UI action can be bound to a key or chord, per context (global, 2D, 3D, sketch, prompt); conflict detection; reset one / all; export / import JSON; presets "llull default", "AutoCAD-like", "SOLIDWORKS-like"; the shortcut sheet (`?`) and every tooltip render the live keymap. | UI-only preference | [R16][R21] |
| FR-UXD-34 | MUST | **Drafting toggles** F3 osnap, F8 ortho, F9 grid snap, F10 polar, F11 tracking, F12 dynamic input, each mirrored by a clickable status-bar button showing its state. | UI-only | [R4] |
| FR-UXD-35 | SHOULD | **Shortcut bar**: a key (default S) opens a customisable command bar at the cursor, content per context (2D, 3D, sketch, sheet). | UI | [R16] |
| FR-UXD-36 | COULD | **Mouse gestures**: right-drag in 4 or 8 directions runs the bound command; gesture guide shown after a short hold. | UI | [R17] |
| FR-UXD-37 | COULD | **Learning aids**: every tooltip and palette row shows key and alias; after a command is started by menu / palette N times, a non-blocking hint names its alias; local-only "commands you may want" from the user's own history (no network). | UI | [R34][R36] |

### 5.9 Navigation

| Id | Pri | Requirement | Landing | Source |
| -- | --- | ----------- | ------- | ------ |
| FR-UXD-38 | MUST | **Navigation presets** for orbit / pan / zoom: llull default, SOLIDWORKS-like, Fusion-like, AutoCAD-like (TECHNICAL_SPEC §5.9 table); middle-drag pan works in 2D at all times, including while a tool is armed; zoom to cursor in 2D and 3D. | UI-only (camera bridge) | [R20] |
| FR-UXD-39 | MUST | **View cube**: 6 faces, 12 edges, 8 corners clickable (26 directions), rotate 90° arrows, home; orbit about the picked point (or the selection centre); previous / next view; fit all / fit selection by key. | UI-only; named views stay commands | — |
| FR-UXD-40 | MUST | **3D mouse at certification level**: native 3Dconnexion Navigation Library integration on Windows and macOS, enabled by default, centre of rotation visualised, device buttons bound to llull commands through the action interface, frame rate during device navigation similar to 2D-mouse navigation; the existing WebHID path remains the fallback (Linux, no driver). | desktop main-process bridge (TR-UXD-11) | [R23] |

### 5.10 Preview and feedback

| Id | Pri | Requirement | Landing | Source |
| -- | --- | ----------- | ------- | ------ |
| FR-UXD-41 | MUST | **Preview / rubber band** for every click-driven tool before each commit: draw shapes, offset side, trim / extend highlight of the part affected, fillet / chamfer result, move / copy / rotate / scale ghost, grip stretch; previews never dispatch; slow previews show "previewing…" without blocking the cursor. | UI over pure dry runs (existing `src/ui/preview`) | — |
| FR-UXD-42 | MUST | **Prompt line**: current prompt, keyword options (click or type the capital letter), default in `<>`, the CLI equivalent of the pending command; announced to screen readers. | UI | [R13] |
| FR-UXD-43 | SHOULD | **Rollback marker** in the feature history: move it to a step to see and edit the model at that point, add steps there, roll to end; saved with the document. | `set_rollback` | [R19] |

### 5.11 Non-functional, agent and benchmark requirements

| Id | Pri | Requirement | Landing | Source |
| -- | --- | ----------- | ------- | ------ |
| FR-UXD-44 | MUST | **Latency budgets** on `office-min` (pack 03): snap query p95 ≤ 2 ms at 100k segments; rubber-band frame time p95 ≤ 16.7 ms on a 10k-entity drawing; hover highlight ≤ 1 frame; commit-to-paint and key-to-armed p95 ≤ 100 ms (local backend); command-line suggestions ≤ 50 ms per keystroke. | TECHNICAL_SPEC §8 | [R29] |
| FR-UXD-45 | MUST | **Accessibility** (WCAG 2.2 AA on the interaction surfaces): every non-path-dependent function reachable by keyboard (2.1.1; the command line is the keyboard path to every command), a single-pointer alternative to every drag (2.5.7), focus never hidden by the dynamic-input or quick-properties popups (2.4.11), prompts announced. | UI | [R32][R33] |
| FR-UXD-46 | MUST | **Agent parity**: every gesture of this pack dispatches registered commands only; the command-line text of a completed command and its CLI call are the same command + params; interaction preferences never enter the document or the undo stack. | architecture L1, L4, L5 | AF |
| FR-UXD-47 | MUST | **Benchmark**: on the 15 tasks of `validation/data/benchmark_tasks.json`, the shipped target method reaches each end state with no more keystrokes and clicks than the target KLM sequence, and the median measured expert time ratio llull / incumbent is ≤ 1.2 per task in the pilot. | validation | [R25][R26] |

## 6. Workflows

### 6.1 Desktop (primary surface of this pack)

1. Draw: `L` Enter → pick (running osnaps, tracking) → `@100<30` Enter → `200` Enter (direct distance along polar) → `C` Enter.
   One `draw_polyline` per chain (FR-UXD-29), one undo step.
2. Modify: window-select (left→right) or verb first (`M` Enter, "Select objects"), base point, `@50,0` Enter → one
   `move_entities`. Space repeats.
3. Grip: select a polyline, click a vertex grip, Tab into dynamic input, type `40` Enter → one `edit_grip`.
4. Properties: select five lines → layer drop-down → "Hidden" → one `set_entity_layer` for five ids.
5. 3D: pick filter Edges, Ctrl-pick four edges, `F` (fillet alias), `3` Enter → one `fillet_edge`.
6. Navigation at any time: middle-drag, wheel, view cube, SpaceMouse — no command, no tool lost.

### 6.2 CLI (agent; unchanged surface, new commands)

```bash
llull list_grips '{"id":"poly-6.1"}' --app
llull edit_grip '{"id":"poly-6.1","grip":"vertex:2","op":"move","to":[900,100]}' --app
llull match_properties '{"sourceId":"line-2.1","targetIds":["line-14.1"],"properties":["layer","color"]}' --app
llull run session-plan.json      # the UI's "Copy session as plan"
```

### 6.3 Settings

Snap modes, aperture, keymap, aliases, navigation preset, dynamic-input options and 3D-mouse settings live in the user profile
(`<userData>/llull/interaction.json`), are edited in Settings ▸ Drafting / Keyboard / Navigation, export / import as JSON, and
never change a document.

## 7. Acceptance criteria

| # | Given | When | Then | VC |
| - | ----- | ---- | ---- | -- |
| AC-1 | last point (10,20) | the user types `@100<30` Enter in the line tool | one `draw_polyline` ends at (96.6025403784, 70) | VC-UXD-01, -03 |
| AC-2 | the task fixture, AutoCAD-like preset | the user performs T01 with `REC`, a snap pick and `120,80` | one `draw_rectangle` 120 × 80 at (300,0); Space restarts it | VC-UXD-07 |
| AC-3 | grid snap off, no geometry nearby | the user clicks | the point is the raw cursor | VC-UXD-13 |
| AC-4 | three coincident lines | Shift+Space | the pick cycles through all three | VC-UXD-20 |
| AC-5 | a selected closed polyline | the user drags a vertex grip to a snap | exactly one `edit_grip`; Ctrl+Z restores the deep-equal document | VC-UXD-26, -27 |
| AC-6 | a 100k-segment drawing on `office-min` | the cursor moves | snap query p95 ≤ 2 ms; frame time p95 ≤ 16.7 ms on 10k | VC-UXD-45, -47 |
| AC-7 | the user rebinds a key to a chord already used | they confirm | `UXD_KEYMAP_CONFLICT` shown, the old binding is only replaced on explicit "replace" | VC-UXD-35 |
| AC-8 | any drag gesture | performed with click-click instead | same result | VC-UXD-19, -49 |
| AC-9 | the 15 benchmark tasks | performed by the harness with the target method | every end state reached with ≤ the target K and click counts | VC-UXD-52 |
| AC-10 | pilot users experienced in the incumbent | perform the tasks in both tools | median llull / incumbent time ≤ 1.2 per task | VC-UXD-53 |

## 8. Standards and alignment

- WCAG 2.2 AA (SC 2.1.1, 2.4.11, 2.5.7) on the interaction surfaces [R32][R33]; the axe scan of pack 06 (`observe.a11y`) is the
  automated part, the review case VC-UXD-49 the rest.
- 3Dconnexion certification requirements as the 3D-mouse acceptance definition [R23]; formal certification is an owner decision
  (§11 of the technical spec).
- Units: inch = 25.4 mm exactly [R31] for unit suffixes.
- No ISO / ANSI standard defines CAD interaction; parity is defined against the incumbents' documented behaviour (§2.1).

## 9. KPIs

| KPI | Today (2026-10-28) | Target | VC |
| --- | ------------------ | ------ | -- |
| Benchmark tasks completable to spec precision in the UI | 8 / 15 (derived: `benchmark_tasks.json` today methods) | 15 / 15 | VC-UXD-52 |
| KLM-predicted target time, all tasks | — | 157.92 s vs incumbent 159.34 s (derived) | VC-UXD-51 |
| Measured expert time ratio llull / incumbent, median per task | TBD — measure with the pack 01 pilot | ≤ 1.2 | VC-UXD-53 |
| Parity checklist MUST rows met | 0 met, 19 partial, 12 missing of 31 MUST rows (`parity_checklist.json`) | all met | VC-UXD-56 |
| Snap query p95 at 100k segments | TBD — measure with a vitest bench | ≤ 2 ms | VC-UXD-45 |
| Commands bindable in the keymap | ~30 fixed bindings (`hooks/shortcuts.ts`) | every registered command + UI action | VC-UXD-35 |

## 10. Risks and assumptions

| Risk / assumption | Mitigation |
| ----------------- | ---------- |
| KLM ignores errors, learning and the M placement is a judgement (RMS error 21 % [R26]) | M rules fixed and applied identically to every design (`klm_operators.json`); KLM only gates "target ≤ incumbent" on the same rules; human time comes from the pilot |
| Incumbent alias strings beyond `L C E P Z` are assumed (grade C) | the prediction changes by 0.28 s per alias character; the measured ratio (VC-UXD-53) uses each user's own setup |
| A command line plus palette plus toolbar overloads the UI | the command line is the palette's keyboard face (one registry, one search); toolbar unchanged |
| Snap engine speed on 100k segments in the renderer | spatial index + incremental update (TR-UXD-03); budget gated by VC-UXD-45 |
| 3Dconnexion SDK licence terms for a local-only product | owner question Q3 (TECHNICAL_SPEC §11); WebHID fallback stays |
| Keymap presets imitating vendors | presets reproduce key **assignments** only (not names, icons or text); see open question Q1 |

## 11. References

Full list with URLs, access method and grade: [validation/sources.md](validation/sources.md) (R1–R37, M1–M3).
