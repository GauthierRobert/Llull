# PHY-22 MOV — Motion video: render a moving mechanism to frames, APNG, GIF and MP4 — Functional specification

Status: specification (2026-11-02); MOV-M0 and MOV-M1 built (2026-11-06, `TECHNICAL_SPEC.md` §13): `render_animation` frames / APNG / timeline / sheet, exact `render_motion` instants; GIF / MP4 are MOV-M2. Gap id `MOV`. Template:
[`../../aerospace/TEMPLATE.md`](../../aerospace/TEMPLATE.md); operator model: [`../../aerospace/AGENT_FIRST.md`](../../aerospace/AGENT_FIRST.md);
pack conventions: [`../README.md`](../README.md) §6. Origin: analysis of the `teardown` Claude Code skill [R1] (2026-11-02), which
renders machine simulators to 60 fps video; this pack takes its useful ideas (time-pure frames, one input drives everything, a
still-per-beat review loop) onto llull's exact model and command layer.

## 1. Summary

llull can simulate a mechanism (`simulate_motion`, MuJoCo), sweep a kinematic joint (`motion_study`, `evaluate_motion`), play
declarative clips in the viewport (`animate`), and fly a camera between saved viewpoints (`render_walkthrough`). It cannot
**produce a moving picture of a mechanism**:

| #   | Limit (measured on main 02e38af9, 2026-11-02)                                                                                                                                                                                    | Consequence                                                           |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 1   | `render_motion` draws at most 12 frames, as one SVG grid                                                                                                                                                                         | no animation; an agent cannot show or review a full cycle             |
| 2   | `render_motion` snaps each requested instant to the nearest recorded sample: `times=[0.0114, 0.0314]` drew 0.01218 s and 0.03132 s on the slider-crank plan (0.78 ms off: 30 % of the 2.62 ms a 954 rpm crank takes to turn 15°) | the labelled time is not the asked time; readouts drift from pictures |
| 3   | `render_walkthrough` writes up to 600 PNG frames, but only moves the camera, never the parts                                                                                                                                     | no mechanism in motion                                                |
| 4   | `animate` clips are evaluated only in the React viewport (`src/ui/viewport/3d/animationMath.ts`)                                                                                                                                 | a CLI agent cannot render them; two evaluators would drift            |
| 5   | no video container (APNG, GIF, MP4) anywhere in llull; no encoder bundled                                                                                                                                                        | a user must screen-record the desktop app                             |
| 6   | a 954 rpm crank turns once in 0.063 s: real-time video at 30 fps shows 2 frames per revolution                                                                                                                                   | needs a playback rate (slow motion)                                   |

This pack specifies one read-only command, `render_animation`, that turns any motion source (physics simulation, kinematic
sweep, animation clips, camera path) into a time-exact frame sequence, a contact sheet and a timeline, and encodes it to APNG
(core, deterministic), GIF or MP4 (native `llull-media` encoder behind an injected port). It also fixes the `render_motion` instant
snapping and moves clip evaluation into core.

## 2. Context and value

- **Who needs it.** Design reviews of mechanisms (linkages, engines, landing gear, robot arms), customer and investor demos, manuals
  and training, bug reports on motion ("the coupler flips at 210°"), and the agent itself: a contact sheet of a cycle is the cheapest
  way for a CLI agent to check a mechanism visually (AF-21 review surface).
- **How incumbent tools do it.** SOLIDWORKS Motion / Animator saves an AVI or image sequence from a motion study [R2]; Fusion
  Animation workspace publishes video from storyboards [R3]; Onshape Animate exports a video from mate-driven motion [R4]; Creo
  Mechanism records frames of an analysis run and plays them back [R5]. All of them derive the frames from the motion result and
  never let the picture drift from the numbers. Teardown [R1] does the same with a single pure `render(t)` function.
- **Why now.** The motion sources and the native raster (`llull-raster`, RS-5) exist; the missing parts are small: a time base, an
  encoder and a port.

## 3. Personas and user stories

| Persona              | Story                                                                                                                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI agent (operator) | As an agent, I render a 4-second slow-motion video of the slider-crank with one command and attach it to my report; I review the contact sheet first and fix the camera before encoding. |
| CLI agent            | As an agent, I read `data.timeline` and know which pose, time and readout every frame shows, without decoding pixels.                                                                    |
| Owner (non-engineer) | As the owner, I click "Export animation…" in the desktop app and get an MP4 I can drop into a slide deck or a chat.                                                                      |
| Reviewer             | As a reviewer, I trust that the piston drawn in frame 45 is where `simulate_motion` says it is at t = 0.015 s.                                                                           |

## 4. Scope

| Phase                    | In scope                                                                                                                                                                                                                                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MVP (M0–M2)              | `render_animation` with sources `simulation`, `sweep`, `clips`; fixed camera (view / direction); overlays time, trace, readouts, highlight; outputs frames (PNG), APNG, timeline, contact sheet; `render_motion` exact instants; clip math in core; GIF + MP4 (AV1) through `llull-media` + `ctx.media`; CLI `--save` of a video file |
| V1 (M3–M4)               | camera paths (viewpoint, walkthrough, orbit) combined with motion; desktop "Export animation…" dialog; `llull-cli` skill recipe for the review loop                                                                                                                                                                                   |
| V1+ (with PHY-23 DRV-M3) | drive readouts (motor current / torque / temperature, ledger) and the synced plot strip with limit lines and the truth badge (FR-MOV-20/21)                                                                                                                                                                                           |
| V2                       | H.264 through the operating system encoder (OQ-MOV-02); section / x-ray / isolate per frame (after plant 09 VIS-M4b section boxes); presentation look mode on the native raster                                                                                                                                                       |

Out of scope: sound, an auto-playing tour in the app, standalone HTML players, a keyframe animation editor, any network upload.

## 5. Functional requirements

| Id        | Pri    | Requirement                                                                                                                                                                                                                                                                                                                                            | Rationale                                                                                         | Source                                        |
| --------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| FR-MOV-01 | MUST   | One read-only command `render_animation` renders a motion source to a frame sequence; it never changes the document and records no history step                                                                                                                                                                                                        | L1, L3, AF-01                                                                                     | llull laws                                    |
| FR-MOV-02 | MUST   | Source `simulation`: runs `simulate_motion` (same engine and parameters) and draws every frame at an exact simulated instant `t_k = k · playbackRate / fps`                                                                                                                                                                                            | limits 2, 6                                                                                       | measured baseline                             |
| FR-MOV-03 | MUST   | Source `sweep`: drives one joint or parameter from `start` to `end` over the frames (optionally there and back), poses from the same evaluator as `motion_study`                                                                                                                                                                                       | kinematic mechanisms have no forces                                                               | `docs/MECHANISMS.md`                          |
| FR-MOV-04 | MUST   | Source `clips`: evaluates the document's `animate` clips at `t_k`, with the same function the viewport player uses (one implementation, in core)                                                                                                                                                                                                       | limit 4                                                                                           | —                                             |
| FR-MOV-05 | MUST   | `playbackRate` (simulated seconds per video second) for slow and fast motion; default 1                                                                                                                                                                                                                                                                | limit 6                                                                                           | —                                             |
| FR-MOV-06 | MUST   | The camera is fixed by default and framed once on the union of all frames' bounds, so nothing leaves the picture and nothing jitters                                                                                                                                                                                                                   | readable motion                                                                                   | `render_motion` precedent                     |
| FR-MOV-07 | MUST   | Overlays: time label, centre-of-mass trace of named bodies, a readout panel of named joints / bodies / parameters, highlight of moving parts in one accent colour                                                                                                                                                                                      | numbers next to the picture                                                                       | [R1] "real numbers, one source", "one accent" |
| FR-MOV-08 | MUST   | Every overlay value and every pose of frame k comes from the same source sample; `data.timeline[k]` lists `t`, the sample index and the readouts                                                                                                                                                                                                       | the picture never drifts from the numbers                                                         | [R1]                                          |
| FR-MOV-09 | MUST   | Output formats `frames` (PNG files), `apng`, `gif`, `mp4`; `timeline.json` always; optional contact sheet `sheet.png` of every n-th frame, labelled                                                                                                                                                                                                    | sharing + agent review                                                                            | [R1] review loop                              |
| FR-MOV-10 | MUST   | `frames` and `apng` work in every host with no native tool; `gif` and `mp4` need the native encoder and otherwise refuse with `NATIVE_TOOL_MISSING` and a remediation naming `format: "apng"`                                                                                                                                                          | AF-41, AF-11                                                                                      | —                                             |
| FR-MOV-11 | MUST   | Reference renderer frames carry sha256 digests and the APNG a file digest, stable per `rendererVersion`; native frames and non-deterministic encoders carry none and say so                                                                                                                                                                            | determinism contract of `render_walkthrough`                                                      | RS1 §2 rule 3                                 |
| FR-MOV-12 | MUST   | Budgets refuse instead of hanging: at most 1800 frames, size limits per format, pixel budget for the PNG outputs; every refusal has a stable code                                                                                                                                                                                                      | AF-11, AF-40                                                                                      | —                                             |
| FR-MOV-13 | MUST   | `render_motion` draws the requested instants exactly (pose interpolation between samples), not the nearest sample                                                                                                                                                                                                                                      | limit 2                                                                                           | measured baseline                             |
| FR-MOV-14 | MUST   | The MP4 plays in the default player of Windows 11 and in Chromium-based browsers without extra codecs; GIF and APNG loop forever                                                                                                                                                                                                                       | owner use                                                                                         | OQ-MOV-01                                     |
| FR-MOV-15 | MUST   | The encoder is bundled with the desktop app, works offline and uses only permissive licences; no GPL / LGPL code and no patent-encumbered codec is shipped                                                                                                                                                                                             | AF-41, licensing                                                                                  | D-MOV-01                                      |
| FR-MOV-16 | SHOULD | Camera paths: a saved viewpoint, a walkthrough (same interpolation as `render_walkthrough`) or an orbit of n turns, combined with any motion source                                                                                                                                                                                                    | presentation                                                                                      | VIS-M9                                        |
| FR-MOV-17 | SHOULD | Desktop "Export animation…" dialog gathers the parameters, shows the contact sheet as a preview and saves the file through the File dialog; it dispatches `render_animation` only                                                                                                                                                                      | L1, owner use                                                                                     | —                                             |
| FR-MOV-18 | SHOULD | The `llull-cli` skill documents the review loop: contact sheet, check, fix, then encode                                                                                                                                                                                                                                                                | agent workflow                                                                                    | [R1]                                          |
| FR-MOV-19 | MAY    | H.264 MP4 through the operating system encoder (Media Foundation on Windows) when present                                                                                                                                                                                                                                                              | widest compatibility                                                                              | OQ-MOV-02                                     |
| FR-MOV-20 | SHOULD | Drive readouts (PHY-23 DRV): `readouts` accept `<motor>.<quantity>` (current, voltage, torque, speed, power, windingTemperature) and `ledger.<element>`; the values come from the same `simulate_motion` run (`detail: 'poses'` includes the drive series)                                                                                             | motor behaviour visible next to the motion                                                        | PHY-23 FR-DRV-23                              |
| FR-MOV-21 | SHOULD | Synced plot strip: `overlays.plot { quantities[≤ 3], heightPx }` draws, under the frame, the chosen series over the whole run with a cursor at `t_k`; limit lines (motor continuous / peak torque, max winding temperature) when the quantity has one; the truth verdict of PHY-23 `check_motion_truth` as a corner badge when `overlays.truth` is set | the convention of Adams / SOLIDWORKS result plots synced with the animation, plus llull's verdict | PHY-23, [R2]                                  |

## 6. Workflows

**CLI (primary).**

```bash
llull run plans/mov_slider_crank_base.plan.json --doc sc.llull.json
# 1. review: contact sheet of every 15th frame, no encoding
llull render_animation source='{"kind":"simulation","duration":0.0628,"playbackRate":0.01}' fps=30 \
  camera='{"view":"front"}' overlays='{"trace":["piston"],"readouts":["j_crank","j_slide"]}' format=frames \
  sheet='{"every":15}' --doc sc.llull.json --save review/
# 2. encode once the sheet looks right
llull render_animation … format=mp4 --doc sc.llull.json --save slider-crank.mp4
```

`--save dir/` writes `frame-0001.png …`, `timeline.json`, `sheet.png`; `--save x.mp4|x.gif|x.apng` writes the one video file
(and `x.timeline.json` next to it). `--app` renders what the open desktop app holds.

**Desktop UI (review surface).** Transport bar → "Export animation…" → source (simulation / sweep / clips, prefilled from the
document), duration, playback rate, fps, size, camera, overlays, format → Preview (contact sheet) → Save. The dialog only gathers
parameters and dispatches the command.

## 7. Acceptance criteria

| #    | Given                          | When                                                     | Then                                                                                          | VC            |
| ---- | ------------------------------ | -------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------- |
| AC-1 | the slider-crank plan          | `render_animation` simulation, playbackRate 0.01, fps 30 | 189 frames; frame k at t = k/3000 s; piston x in `timeline` within 0.01 mm of the closed form | VC-MOV-01, 02 |
| AC-2 | the same plan                  | `render_motion times=[0.0114,0.0314]`                    | `frames[].time` = 0.0114, 0.0314 exactly                                                      | VC-MOV-03     |
| AC-3 | a box with a spin clip         | `render_animation` clips, fps 10, 2 s                    | 21 frames; frame 5 shows the box turned 90°                                                   | VC-MOV-04     |
| AC-4 | any source                     | two runs with the reference renderer                     | identical frame and APNG digests                                                              | VC-MOV-07     |
| AC-5 | a host without `llull-compute` | `format: "mp4"`                                          | `NATIVE_TOOL_MISSING` with remediation `format: "apng"`; `format: "apng"` succeeds            | VC-MOV-13     |
| AC-6 | the desktop app                | Export animation → MP4                                   | the file plays in the Windows 11 Media Player                                                 | VC-MOV-10     |

## 8. Standards alignment

Containers and codecs only: PNG 3rd edition with APNG chunks [R6], GIF89a [R7], ISO base media file format (MP4, ISO/IEC 14496-12)
[R8], AV1 bitstream and its ISOBMFF binding [R9][R10]. No engineering standard governs mechanism animations.

## 9. KPIs

| KPI                                                 | Target                                                                                    |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Time from a built mechanism to a shareable MP4, CLI | one command, ≤ 60 s for 300 frames at 1280×720 on the native renderer (reference machine) |
| Frame-to-number agreement                           | 0 frames whose pose differs from `data.timeline` (by construction, checked by VC-MOV-02)  |
| Agent review cost                                   | one contact sheet image per check instead of n frames                                     |

## 10. Risks and assumptions

| Risk                                                                             | Mitigation                                                                                                              |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| AV1 MP4 does not play in an older Windows / PowerPoint without the AV1 extension | M0 measures playback on the reference machine; V2 H.264 through the OS encoder (OQ-MOV-02); GIF / APNG always available |
| AV1 encoding is slow on CPU                                                      | encoder speed preset fixed for short clips; measured in M0 (VC-MOV-20); frames stream to disk, memory bounded           |
| Encoder output not bit-reproducible across machines                              | digest only when the encoder declares itself deterministic (FR-MOV-11); frame digests remain the contract               |
| Large outputs in `data` (base64)                                                 | frame budget, video files carried once; CLI writes them to disk and elides payloads in its reply (existing `saveFiles`) |
| Simulation time dominates                                                        | the simulation runs once per command; the video samples it, never re-runs per frame                                     |

## 11. References

[R1]–[R11]: grades and extracts in [`validation/sources.md`](validation/sources.md).
