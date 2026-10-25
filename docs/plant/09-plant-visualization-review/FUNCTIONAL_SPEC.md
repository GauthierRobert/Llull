# Gap 09 VIS — Plant visualization and model review: functional specification

Status: proposed (2026-10-18). Pack: [`validation/`](validation/README.md). Technical design:
[`TECHNICAL_SPEC.md`](TECHNICAL_SPEC.md). Agent-first rules: [`../../aerospace/AGENT_FIRST.md`](../../aerospace/AGENT_FIRST.md).

## 1. Summary

A process unit modelled in AutoCAD Plant 3D, AVEVA E3D or Smart 3D holds 10⁵ to 10⁶ components: pipe segments,
fittings, flanges, bolts and nuts, valves, supports, steel and grating. Reviewers look at it in a dark viewport where
pipes are coloured by service (yellow, grey, green…), valves stand out in blue, and steel, concrete and equipment have
believable materials. They walk through the plant, cut it with section boxes, save viewpoints, draw redlines, comment,
and close clash issues ([R1]–[R6]).

llull already renders shaded solids with three.js and makes server-side images with `render_view`. It has one
`check_clashes` command and a layer colour per element category. It cannot yet do the plant-scale part:

- Instancing covers only identical boxes, cylinders and spheres, and the instancing key includes the colour.
- There is no level of detail (LOD) per component and no culling below the draw-call level.
- No colour comes from a property such as service, line, spec or DN.
- Camera bookmarks live in browser `localStorage`, outside the document. Section boxes, markups, comments and issues
  do not exist.
- `render_view` renders orthographic views only, with flat Lambert shading.

This gap brings llull to plant-review level. Everything a reviewer persists (colour profiles, viewpoints, section
boxes, markups, issues, comments, walkthrough paths) becomes document data, written only by commands. Every visual
judgement has a numeric equivalent an agent can check.

## 2. Plant context and value

| Who                                                       | Today's tool                                                                       | What they do in review                                                                                                                    |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| EPC design team, 30 / 60 / 90 % model reviews             | Navisworks Manage / Simulate, AVEVA Review / E3D, Intergraph Smart Review          | Walk the model with the client and operations. Record comments on viewpoints with redlines. Track them to closure.                        |
| Owner-operator (operations, maintenance, HSE)             | Navisworks Freedom, BCF viewers                                                     | Check access to valves and instruments, escape routes and lifting paths. Raise issues.                                                    |
| Piping designer                                           | Plant 3D colour by service / size ([R4]); E3D auto-colour rules ([R5])              | Colour the model by service, line or spec to spot wrong assignments. Isolate a line.                                                      |
| Coordination engineer                                     | Navisworks Clash Detective, Appearance Profiler ([R2], [R3])                        | Run clash tests. Turn clashes into issues with viewpoints. Colour objects by status or property. Export BCF to other tools.               |
| Project / visualization                                   | Plant Design Suite renders, Navisworks Presenter, 3ds Max                           | High-quality images and fly-throughs for the client: white columns, red steel portal, coloured pipe services, terrain.                    |

Facts that drive the requirements:

- **Navisworks** keeps a target frame rate by dropping small, distant items while the camera moves and drawing them
  once it stops. By default it skips objects smaller than 1 × 1 pixel. It culls against near and far planes and the
  back faces, and runs CPU occlusion culling by default ([R2]).
- The **Appearance Profiler** colours objects by property or by selection set. Selectors are ordered and can be saved
  to a file ([R3]).
- In Navisworks, **viewpoints, redlines and comments** are saved in the NWF file, independently of the model geometry.
  Realism settings (collision, gravity, crouch, third person) can be saved with a viewpoint ([R6]).
- **E3D auto-colour rules** are evaluated in order, and the first rule that matches decides the colour. Unmatched
  elements keep the default colour ([R5]).
- **Plant 3D** can put lines on layers by line number or by service and colour them by size, through the project's
  layer and colour settings ([R4]).
- **BCF** (BIM Collaboration Format, buildingSMART) is the open format for issues. A topic carries comments and
  viewpoints. A viewpoint has an orthogonal or perspective camera, clipping planes, visibility, colouring, 3D lines and
  bitmaps. Lengths are in metres and angles in degrees ([R7]).
- **Pipe colour standards** identify contents: ASME A13.1 in the USA (marker colours by hazard class), ISO 14726 on
  ships, BS 1710 in the UK and DIN 2403 in Germany ([R8]–[R12]). They colour markers and bands, not whole pipes.
  Review tools borrow the categories to tint the whole pipe.

## 3. Personas and user stories

**Operator (primary): AI agent using the `llull` CLI.**

- US-1. As the agent, I map the free-text services of a model ("cooling water", "natural gas") to ASME A13.1
  categories and activate that colour profile. A JSON report then tells me which lines were coloured, with which
  category, and which were left unmatched.
- US-2. As the agent, I save viewpoints with a camera and a section box, attach redlines and raise issues. I export
  them to BCF so the owner's review tool shows the same views.
- US-3. As the agent, I turn every clash from `check_clashes` into a review issue with a framed viewpoint. Re-running
  this does not duplicate issues.
- US-4. As the agent, I render the plant offline in the review look (perspective, service colours, shadows, ambient
  occlusion, edges) to `view.svg`, and I check my own work on the image.
- US-5. As the agent, I can prove that the viewer will cope with the model. `render_stats` tells me the draw calls,
  the instances per LOD and how many are culled, before anyone opens the desktop app.

**Owner (non-engineer).**

- US-6. As the owner, I open the desktop app and see the plant as I know it from Plant 3D: dark background, pipes
  coloured by service, believable steel and concrete. The app stays fluid on a large unit.
- US-7. As the owner, I click a saved viewpoint, read the comments in plain language and see what is still open.

**Qualified reviewer (piping / HSE engineer).** Needed only where a colour scheme or an issue closure feeds a safety
decision.

- US-8. As the reviewer, I confirm the service-to-hazard-class mapping before the colour-coded model or its marker
  list is issued. llull shows `reviewRequired` until I sign.
- US-9. As the reviewer, I am the only one who can close or approve an issue. The agent can only mark it resolved.

## 4. Scope

| Phase  | In scope                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MVP** | Colour profiles (ordered first-match rules on entity properties) with the ASME A13.1 and ISO 14726 scheme tables. `colour_by_rule_report`. Viewpoints in the document (perspective / orthographic, section box, isolate, profile). Section boxes with a numeric report. Review issues, comments and markups (screen and world). `check_review`. Clash-to-issue. Instanced rendering keyed by prototype and material class, with colour per instance. 3-level LOD and 1-px cull. `render_stats`. `render_view` in perspective with viewpoint, profile and section box. |
| **V1** | BCF 3.0 import / export (bcfzip). BS 1710 and DIN 2403 tables. ASME A13.1 pipe markers (legend band from OD, flow arrows) with a check. PBR material classes. Environment lighting, shadows, SSAO and edges in the viewport, by quality tier. Review shading in `render_view` (sun shadows, ambient occlusion, edges, sky / ground). BVH frustum culling for 10⁵+ instances. Walk / fly navigation. Walkthrough paths rendered as frames. glTF export with `EXT_mesh_gpu_instancing`. |
| **V2** | 10⁶ components: tiled streaming, GPU occlusion culling, octahedral impostors, worker-built BVH. Terrain and site context (civil surfaces, sky, sun position from date and location). Colour by status or schedule (4D). Compact instance-array document storage, owned jointly with 08-plant-data-reports-interop.                                                                                                                                                 |

Out of scope:

- Clash detection algorithms. These belong to the industrial clash module and to 02-spec-driven-routing.
- P&ID colouring (04-pid-schematics).
- Point clouds (10-pointcloud-brownfield).
- VR headsets.
- Physically-based offline path tracing. `render_view` stays a deterministic rasteriser.

## 5. Functional requirements

| Id        | Pri    | Requirement                                                                                                                                                                                                                                                                       | Rationale                                                         | Source         | AF                      |
| --------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | -------------- | ----------------------- |
| FR-VIS-01 | MUST   | **Colour profiles.** An ordered list of rules (predicate on entity properties → colour, transparency, legend label) plus a default colour. The first matching rule wins. Profiles are stored in the document and written only by commands. Switching profiles never changes geometry. | Appearance Profiler / E3D auto-colour semantics                   | [R3], [R5]     | AF-01, AF-05            |
| FR-VIS-02 | MUST   | **Service colour schemes as sourced data.** ASME A13.1 (field and letter colour per hazard category), ISO 14726 (main colours per medium), BS 1710 (basic colours) and DIN 2403 (group colours, documentation only). Each row carries its source and grade. The agent gives the service-to-category map explicitly. llull never guesses a hazard class from a service name. | Safety meaning of colours                                         | [R8]–[R12]     | AF-30, AF-31            |
| FR-VIS-03 | MUST   | **Numeric colour report.** `colour_by_rule_report` gives, per entity or per line, the matched rule, category, field and letter colour names and display hex, the legend counts, and the unmatched ids. The display hex is flagged `approximate`.                                    | AF-21 numeric equivalent of a colour-coded view                   | —              | AF-10, AF-21            |
| FR-VIS-04 | SHOULD | **ASME A13.1 pipe markers.** Legend band length and letter height from the outside diameter, insulation included. Flow arrows. Placement at valves, flanges, direction changes, penetrations and straight-run intervals. Generated as decals / annotations and checked by `check_pipe_markers`. | Real marker lists for construction                                | [R8], [R13]    | AF-20, AF-31            |
| FR-VIS-05 | MUST   | **Viewpoints.** Save, update, delete, apply and list. A viewpoint holds a perspective camera (eye, direction, up, vertical FOV) or an orthographic one (view height), an optional section box, isolated / hidden ids, a colour profile and its markups. Stored in the document; the round trip is exact. | NWF / BCF viewpoints                                              | [R6], [R7]     | AF-05, AF-13            |
| FR-VIS-06 | MUST   | **Section boxes and planes.** An axis-aligned box (with an optional Z rotation) or 1–6 planes, saved with a viewpoint. `section_box_report` lists the ids inside, crossing and outside.                                                                                                | Navisworks sectioning, BCF clipping planes                        | [R6], [R7]     | AF-21                   |
| FR-VIS-07 | MUST   | **Review issues and comments.** The BCF topic model: title, type, priority, status, assignee, labels, due date, linked viewpoints and entities, comments linked to at most one viewpoint. Status workflow `open → in_progress → resolved → closed`. `closed` and `approved` are human gates. | Review to closure                                                 | [R7]           | AF-34, AF-34a           |
| FR-VIS-08 | MUST   | **Markups (redlines).** Screen-space shapes on a viewpoint (line, arrow, cloud, ellipse, text; normalised image coordinates) and world-space 3D lines (BCF `Lines`). Colour and text. Stored in the document.                                                                       | Navisworks redline, BCF lines                                     | [R6], [R7]     | AF-05                   |
| FR-VIS-09 | SHOULD | **BCF 3.0 import / export** (bcfzip with markup, visinfo, snapshot). Units converted (metres ↔ document unit). llull ids mapped to IFC GUIDs when the 08 DAT IFC export assigned them.                                                                                              | Interop with every BCF-capable review tool                        | [R7]           | AF-12                   |
| FR-VIS-10 | MUST   | **`check_review`** (read-only): open issues; issues waiting for approval; viewpoints, issues or markups that reference deleted entities, missing viewpoints or profiles; markups outside the image.                                                                                    | Agent ends every review job with a check                          | —              | AF-20, AF-11            |
| FR-VIS-11 | MUST   | **Clash review.** `create_clash_issues` turns the pairs of a clash query (`check_clashes`, `check_assembly`) into issues, each with a viewpoint framed on the clash (section box = clash AABB + margin, both elements highlighted). Idempotent on the clash key.                          | Clash Detective workflow                                          | [R2]           | AF-13                   |
| FR-VIS-12 | MUST   | **Plant-scale viewport (10⁵ components).** Repeated components draw as one instanced batch per (prototype, LOD); service colour, selection and highlight are per-instance attributes. 3-level LOD (full, reduced, box). Items under 1 px are culled. Opaque model draw calls are bounded by prototypes × LODs, not by component count. | Plant models are 10⁵–10⁶ parts                                    | [R2], [R14]    | —                       |
| FR-VIS-13 | MUST   | **`render_stats`** (read-only query): for a camera and viewport size, returns draw calls, buckets, instances per LOD, culled counts, triangles and estimated GPU bytes. The same pure plan drives the viewport.                                                                      | AF-21: the agent proves performance without a GPU                 | [R14]          | AF-10, AF-21            |
| FR-VIS-14 | SHOULD | **10⁶ components.** BVH frustum culling, tiled streaming, GPU occlusion culling and impostors. The frame-time budget is met on the reference machine (values TBD — measure).                                                                                                          | Large units / whole plants                                        | [R2]           | AF-40                   |
| FR-VIS-15 | MUST   | **Realistic display.** PBR material classes (painted steel, galvanized, stainless, insulation cladding, concrete, grating, cast valve body, bolting, FRP). Environment lighting, shadows, ambient occlusion and edges, chosen by quality tier. Dark and light review backgrounds.        | The reference images' look                                        | —              | —                       |
| FR-VIS-16 | MUST   | **Offline render at review quality.** `render_view` gains `projection: perspective`, `viewpointId`, `colourProfileId`, `sectionBoxId` and `shading: 'review'` (sun shadow, ambient occlusion, edges, sky / ground). Output is byte-deterministic per renderer version, with an `svgSha256` digest. | Agent sees what it built (AF-22); goldens                         | —              | AF-13, AF-22            |
| FR-VIS-17 | SHOULD | **Walkthrough.** Walk and fly navigation in the UI (eye height, gravity, collision, crouch). Persisted walkthrough paths (ordered viewpoints with durations) rendered offline as frames.                                                                                              | Navisworks walk / realism                                         | [R6]           | AF-22                   |
| FR-VIS-18 | COULD  | **Site context.** Civil surfaces (TIN) rendered with a terrain material, ground plane, sky, sun from date and location.                                                                                                                                                              | Plant Design Suite renders show terrain                           | —              | —                       |
| FR-VIS-19 | SHOULD | **glTF instancing.** `export_gltf` writes repeated components with `EXT_mesh_gpu_instancing`. An import of the Khronos SimpleInstancing sample yields 125 instances.                                                                                                                 | Hand-off to external viewers                                      | [R15]          | AF-12                   |
| FR-VIS-20 | MUST   | **Everything from the CLI.** Every capability above is a registry command. Images and BCF files are written with `--save`. The UI only gathers parameters, renders and dispatches.                                                                                                 | L1, AGENT_FIRST §1                                                | —              | AF-01..05, AF-12        |

## 6. Workflows

### 6.1 CLI (operator, complete)

```bash
# 1. Colour by service (scheme rows are sourced; mapping is an explicit input)
llull --doc unit.llull list_service_colour_schemes --json            # categories + grades
llull --doc unit.llull apply_service_colour_scheme scheme=asme_a13_1 profileId=services \
      serviceMap=@service_map.json activate=true
llull --doc unit.llull colour_by_rule_report profileId=services groupBy=property groupProperty=line --json

# 2. Review set-up
llull --doc unit.llull run review.json --validate && llull --doc unit.llull run review.json
#    (save_viewpoint, set_section_box, add_markup, create_review_issue, add_review_comment)
llull --doc unit.llull check_clashes --json
llull --doc unit.llull create_clash_issues source=check_clashes margin=500

# 3. Look at it, prove it scales, check, hand off
llull --doc unit.llull render_view viewpointId=vp-12.1 shading=review width=1920 height=1080 --save vp12.svg
llull --doc unit.llull render_stats viewpointId=vp-12.1 width=1920 height=1080 --json
llull --doc unit.llull check_review --json                           # exit 1 on fail codes
llull --doc unit.llull export_bcf --save review.bcf
```

The agent ends with `check_review` and `check_display`. Its report to the owner says what is coloured, what is
unmatched, which issues are open, and which issues need a human to close them.

### 6.2 MCP

The same commands are exposed in toolsets `review` (core) and `plant-display` (domain-aec). Images and BCF files
return a size and a digest, never inline bytes over the cap (AF-12).

### 6.3 UI (review and approval surface)

- The viewport renders the active profile, viewpoints, section box, markups and LOD batches.
- The Review panel lists issues and comments. A click applies the viewpoint (dispatch `apply_viewpoint`).
- Redline tools gather points and dispatch `add_markup`.
- Walk / fly modes are navigation only. Saving a path dispatches `create_walkthrough`.
- A human closes an issue in the panel with a signature (AF-34a).
- Camera bookmarks are document viewpoints (`namedViewStore.ts` is retired at VIS-M2; old localStorage bookmarks are not imported).

## 7. Acceptance criteria

| #     | Given                                                                    | When                                                                                    | Then                                                                                                                                                                                | VC                    |
| ----- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| AC-01 | 7 pipe runs with free-text services and a 6-entry service map             | `apply_service_colour_scheme scheme=asme_a13_1` then `colour_by_rule_report --json`     | each mapped line reports the A13.1 category and field / letter colour of `service_colour_schemes.json`; the unmapped line is listed with `VIS_COLOUR_UNMATCHED`                   | VC-VIS-01, VC-VIS-03  |
| AC-02 | the same model                                                           | a second profile from `iso_14726` is activated                                          | every line reports the ISO 14726 main colour of its medium; entity geometry is deep-equal before and after                                                                         | VC-VIS-02, VC-VIS-03  |
| AC-03 | pipes of DN20, DN25, DN100, DN100 + 50 mm insulation, DN150, DN300       | `add_pipe_markers` / `check_pipe_markers --json`                                        | legend field length and letter height match the A13.1 rows; ODs in a band gap get the next larger row with `VIS_MARKER_BAND_INTERPOLATED`                                          | VC-VIS-04             |
| AC-04 | the BCF 3.0 documentation example camera                                 | `save_viewpoint` → `get_viewpoint` → `export_bcf_viewpoint` → `import_bcf_viewpoint`    | eye, direction, up and view height round-trip to 1e-12 relative; metres ↔ mm exact                                                                                                 | VC-VIS-10             |
| AC-05 | that viewpoint                                                           | `apply_viewpoint`                                                                        | `document.camera.azimuth` = 2.1402772048541396 and `polar` = 1.2728948190113956 within 1e-9                                                                                        | VC-VIS-11             |
| AC-06 | three solids and a section box                                           | `section_box_report`                                                                    | inside / crossing / outside lists equal the exact AABB classification                                                                                                              | VC-VIS-12             |
| AC-07 | an issue linked to an entity that is then deleted                         | `check_review --json`                                                                   | `VIS_ISSUE_ENTITY_MISSING` names the issue; after `resolved`, `VIS_ISSUE_AWAITING_APPROVAL`; an agent `closed` is refused with `VIS_HUMAN_GATE`                                    | VC-VIS-13, VC-VIS-14  |
| AC-08 | SYN-RACK-v1 at 8 / 44 / 437 / 4367 bays                                   | `render_stats --json`                                                                   | `componentCount` = 227 n + 8 ⌊n/4⌋; `opaqueModelCalls` ≤ 30 at every size and identical with and without service colours; drawn + culled = N                                    | VC-VIS-20, 21, 23     |
| AC-09 | one stud M16 prototype (bbox diagonal 92.8009 mm), 1080 px, FOV 45°      | the instance is at 2520.4 / 2520.6 / 15122.9 / 120982.3 mm                              | LOD0 / LOD1 / LOD2 / culled; with hysteresis 0.1, a visible LOD1 stays LOD1 down to 2268.4 mm                                                                                      | VC-VIS-22             |
| AC-10 | the same document and params                                             | `render_view` twice (orthographic and review perspective)                               | `svgSha256` identical                                                                                                                                                               | VC-VIS-30             |
| AC-11 | a pipe through a vessel                                                  | `check_clashes`, then `create_clash_issues` twice                                       | 1 hard clash → 1 issue; second run creates 0; the issue viewpoint's section box = clash AABB + margin                                                                              | VC-VIS-40, VC-VIS-41  |
| AC-12 | the Khronos SimpleInstancing glTF                                        | `import_gltf` then `export_gltf`                                                        | 125 instances, translations within [0, 10], scales within [1, 2]; the export keeps one mesh plus `EXT_mesh_gpu_instancing`                                                         | VC-VIS-25             |
| AC-13 | SYN-RACK-v1 M and L on the reference machine                             | the Playwright perf script                                                              | median / p95 frame time recorded against the stored baseline; fail on +20 %                                                                                                        | VC-VIS-24 (TBD)       |

## 8. Standards and regulatory alignment

| Standard / spec                                                       | Use in this gap                                                                       | Public facts used                                                     |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| ASME A13.1 Scheme for the Identification of Piping Systems [R8]       | hazard categories → marker field and letter colours; legend size by OD; placement      | category list, colour pairs, size rows (vendor extracts, graded)       |
| ISO 14726:2008 (ships) [R9]                                           | main colour per medium group; RAL references                                           | Table 2 media list, Table B.1 RAL codes (extracts)                     |
| BS 1710 [R10]                                                         | UK basic identification colours with BS 4800 references                               | 8 basic colours + 3 safety colours                                     |
| DIN 2403 / TRGS 201 Anh. 3 [R11]                                      | German group colours (documentation only, grade B)                                     | group colour per medium                                                |
| ANSI Z535.1 [R12]                                                     | physical definition of the safety colours A13.1 uses; why llull's hex is approximate   | scope, Munsell / CIE definitions exist; not reproduced                 |
| BCF 3.0 (buildingSMART) [R7]                                          | issue / viewpoint interchange                                                          | schemas and documentation (CC BY-ND 4.0, kept verbatim)                |
| glTF 2.0 + EXT_mesh_gpu_instancing (Khronos) [R15]                    | instanced export / import                                                              | sample model (CC0)                                                     |

Colour schemes are identification conventions. A colour-coded model does **not** replace the physical marking an
owner must install. Outputs that feed marking lists carry `reviewRequired: true` (AF-33).

## 9. KPIs

| KPI                                                          | Target                                                                         | How measured                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------ | ---------------------------------------------------- |
| Opaque model draw calls, SYN-RACK-v1, any size               | ≤ 30 (closed form 2 × 13 + 4)                                                  | `render_stats` (VC-VIS-21)                           |
| Median frame time, orbit, 1920 × 1080, SYN-RACK S / M / L     | targets 16.7 / 16.7 / 33.3 ms; actual TBD — measure                             | Playwright perf script (VC-VIS-24)                   |
| First frame after open, SYN-RACK M                           | TBD — measure (baseline today; ratchet −20 %)                                  | gate 2 `loadMs` ([`QUALITY_GATES.md`](../../QUALITY_GATES.md)) |
| Viewpoint round-trip error                                   | ≤ 1e-12 relative                                                               | VC-VIS-10                                            |
| Unmatched entities after a profile is applied                | reported 100 % (never silently default-coloured)                               | VC-VIS-03                                            |
| `render_view` determinism                                    | 100 % identical digests across 2 runs                                          | VC-VIS-30                                            |
| Clash-issue duplication on re-run                            | 0                                                                              | VC-VIS-40                                            |

## 10. Risks and assumptions

| Risk                                                                                                                | Mitigation                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The A13.1 tables are known only from vendor extracts, which conflict on some rows (flammable, letter colours, size-row lengths, spacing). | Only rows where ≥ 2 extracts agree gate (grade A). Conflicts are listed in the data file. A qualified reviewer confirms against a purchased edition before marker lists are issued (US-8). |
| No standard gives sRGB values; the only RAL table found is internally inconsistent.                                  | Gate on colour **names**; the display palette is a named llull default flagged `approximate` and replaceable by the owner.                                                                     |
| A document with 10⁶ entities as JSON is very large (today ≈ 350 B / triangle for STEP imports, QUALITY_GATES gate 2). | Plant components as instances of catalogue prototypes; a compact instance-array storage in V2 with 08-plant-data-reports-interop.                                                              |
| Float maths (`Math.sin`, `Math.cos`…) can differ between JS engine versions, so `render_view` digests can drift.      | Digests pinned per `rendererVersion` + Node major; a re-pin is a reviewed golden diff.                                                                                                         |
| BatchedMesh without `WEBGL_multi_draw` issues one call per instance ([R14] fact T3).                                  | The renderer uses InstancedMesh for repeated prototypes. BatchedMesh only for unique geometry, with the fallback count reported by `render_stats`.                                               |
| GPU differences make frame times noisy.                                                                              | Per-machine baselines, median of 3 runs, +20 % regression gate (no absolute gate).                                                                                                              |
| Mapping a service to a hazard class is an engineering decision.                                                      | Explicit `serviceMap` input, never inferred; `reviewRequired` until a human signs.                                                                                                              |
| Navisworks clash statuses (New / Active / Reviewed / Approved / Resolved) are known from memory, not a fetched source. | llull uses the BCF open status list and maps to Navisworks names only on export, as a documented open question.                                                                               |

Assumptions:

- 02-spec-driven-routing and 01-piping-specs-catalog supply real pipe components as instances of catalogue prototypes,
  with properties `service`, `line`, `spec` and `dn`. Until then, `add_pipe_run` elements carry service, line and DN.
- 08-plant-data-reports-interop assigns IFC GUIDs that BCF can reference.

## 11. References

- [R1] AVEVA E3D Design documentation (docs.aveva.com, e3d-design bundle) — https://docs.aveva.com/bundle/e3d-design/page/945887.html (accessed 2026-10, search extract)
- [R2] Autodesk Navisworks Help, "Display Page" (culling, guarantee frame rate, drop-out) — https://help.autodesk.com/cloudhelp/2024/ENU/Navisworks/files/GUID-B470F105-8626-44FF-B531-8864FBD79CDA.htm (accessed 2026-10, search extract)
- [R3] Autodesk Navisworks Help, "Appearance Profiler" / "To Color-code Models by Property Values" — https://help.autodesk.com/cloudhelp/2020/ENU/Navisworks/files/GUID-37A831D3-AE33-45AE-9679-6A8610023E10.htm (accessed 2026-10)
- [R4] Autodesk AutoCAD Plant 3D 2017 User Guide, layer and colour settings — https://help.autodesk.com/cloudhelp/2017/ENU/Plant3D-UserGuide/files/GUID-9E580DD7-22DC-488A-A081-00F0A74F595C.htm (accessed 2026-10)
- [R5] AVEVA E3D, auto colour rules (first matching rule decides) — https://docs.aveva.com/bundle/e3d-design/page/926196.html (accessed 2026-10, search extract)
- [R6] Autodesk Navisworks Help, "Overview of Viewpoints" and Review / Realism tools — https://help.autodesk.com/cloudhelp/2019/ENU/Navisworks/files/GUID-7FDFB8F2-B361-4234-B67B-263B8DC2D361.htm (accessed 2026-10)
- [R7] buildingSMART, BCF-XML 3.0 schemas and documentation — https://github.com/buildingSMART/BCF-XML/tree/release_3_0 (accessed 2026-10, downloaded)
- [R8] ASME A13.1 Scheme for the Identification of Piping Systems (catalogue) — https://www.asme.org/codes-standards/find-codes-standards/a13-1-scheme-identification-piping-systems ; extracts: J.J. Keller, Brimar, Brady, Project Materials (see validation/sources.md)
- [R9] ISO 14726:2008 Ships and marine technology — Identification colours for the content of piping systems — https://www.iso.org/standard/44744.html
- [R10] BS 1710 Specification for identification of pipelines and services — extracts: Duralabel, Wikipedia "Pipe marking"
- [R11] DIN 2403 / TRGS 201 Anhang 3 — https://vorschriften.bgn-branchenwissen.de/daten/tr/trgs201/anh3.htm
- [R12] ANSI Z535.1 Safety Colors — https://blog.ansi.org/ansi-z535-1-2022-safety-colors-standard/
- [R13] Brimar, ASME A13.1 guide (placement, arrows) — https://www.pipemarker.com/asme-guide
- [R14] three.js r186 source (npm `three@0.186.1`, MIT): `InstancedMesh`, `BatchedMesh`, `LOD`, `WebGLInfo`, `SceneOptimizer` — https://registry.npmjs.org/three/-/three-0.186.1.tgz (downloaded)
- [R15] Khronos glTF-Sample-Assets, SimpleInstancing (`EXT_mesh_gpu_instancing`, CC0) — https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/SimpleInstancing (downloaded)
