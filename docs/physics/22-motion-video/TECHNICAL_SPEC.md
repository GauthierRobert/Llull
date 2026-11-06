# PHY-22 MOV — Motion video — Technical specification

Status: specification only (2026-11-02). Functional side: [`FUNCTIONAL_SPEC.md`](FUNCTIONAL_SPEC.md). Validation:
[`validation/README.md`](validation/README.md).

## 1. Current state in llull (measured on main 02e38af9, 2026-11-02)

| Piece                | File                                                                                                                     | What it does                                                                                                                          | Limit for video                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `render_motion`      | `packages/core/src/commands/render/renderMotion.ts`                                                                      | runs `simulate_motion` (`ctx.registry`, detail `poses`), draws ≤ 12 instants as one SVG grid, trace, springs                          | 12 frames; `nearestSample` snaps times (baseline: 0.0114 → 0.01218 s); SVG overlays only |
| `render_walkthrough` | `commands/render/renderWalkthrough.ts`                                                                                   | ≤ 600 PNG frames of a camera path; reference raster + `frameSha256`, or `ctx.raster` native frames; `VIS_RENDER_BUDGET` at 10⁸ pixels | camera only, parts never move; no overlays                                               |
| frame raster         | `commands/render/frames.ts` (`renderCameraPng`), `raster.ts`, `rasterScene.ts`, `rendererProvenance.ts`                  | one camera → opaque PNG, reference (`llull-ts-raster/1`) or native pixel stage                                                        | needs a fixed-view entry point; draws solids and sketches, no text                       |
| poses                | `packages/core/src/geometry/bodyPose.ts` (`documentAtPose`, `posesAtSample`)                                             | rigid-body member entities moved to a recorded sample                                                                                 | sample index only, no time interpolation                                                 |
| `simulate_motion`    | `packages/domain-dynamics/src/commands/simulate.ts`                                                                      | MuJoCo; `detail` summary / series / poses; `MAX_SAMPLES = 6001`, samples at whole steps                                               | one detail per run: poses and joint series not together                                  |
| kinematics           | `commands/motion/jointsKinematics.ts` (`evaluateMotionInternal`), `motionStudy.ts`, `jointsDrive.ts` (`evaluate_motion`) | per-step instance transforms for a joint / parameter sweep                                                                            | read-only data, no pictures                                                              |
| clips                | `commands/motion/animation.ts` (`animate`); evaluator `src/ui/viewport/3d/animationMath.ts` (three.js)                   | declarative spin / oscillate clips                                                                                                    | evaluated only in the UI                                                                 |
| PNG                  | `packages/core/src/lib/png.ts` (`encodePng`)                                                                             | RGBA → PNG                                                                                                                            | no APNG                                                                                  |
| fonts                | `packages/core/src/lib/font/` (03 WRP, DES-3c)                                                                           | glyph outlines from bundled fonts                                                                                                     | not used by renders                                                                      |
| native raster port   | `model/raster.ts`, `commands/rasterPort.ts`, `server/src/native/rasterPort.ts`                                           | sync port, `llull-compute raster` job folder                                                                                          | —                                                                                        |
| process runner       | `server/src/processRunner.ts`, `server/src/native/computeJob.ts`                                                         | sync jobs, tree kill on timeout                                                                                                       | —                                                                                        |
| CLI save             | `server/src/cli/saveFiles.ts`                                                                                            | writes `data.files[]` / svg / png to a file or directory                                                                              | picks no file by extension when several                                                  |

Measured: `render_motion frames=12 640×360` on the slider-crank plan costs ≈ 45 ms per frame above a ≈ 1.65 s CLI start
(2 runs: 2176 / 2191 ms for 12 frames, 1625 / 1718 ms for 1 frame), SVG path rasterised by resvg.

## 2. Target architecture

```
render_animation (core, read-only, toolset render)
  ├─ source adapter            commands/render/animation/sources.ts
  │    simulation → ctx.registry('simulate_motion') once, detail 'poses' + named joint series
  │    sweep      → evaluateMotionInternal per frame (core)
  │    clips      → geometry/animationPose.ts (core; the UI player imports it)
  │    → FrameState[k] = { t, document at pose, readouts }
  ├─ camera                    fixed (framed on union bounds) | viewpoint | walkthrough | orbit
  ├─ overlays → RasterScene    commands/render/animation/overlays.ts (strokes, fills, glyph outlines from lib/font)
  ├─ pixel stage               reference raster (digest) | ctx.raster (native GPU picture)
  └─ output
       frames / apng / sheet   core (lib/apng.ts, pure)                → data.files, sha256
       gif / mp4               ctx.media (MediaPort) session          → host → llull-compute media (Rust llull-media)
```

Laws: L1 (one command, both callers), L2 (core imports no plugin: the simulation is reached through `ctx.registry`, as
`render_motion` does today), L3 (read-only, the input document is never changed; `annotations: { readOnly: true }`, no history
step), L5 (schema from zod), L9 pattern for ports (`ctx.media` injected by the composition root / host, never imported by core).
C7: encoders in Rust (`solver/crates/llull-media`), APNG in TypeScript because it is a few chunks around the existing
`encodePng` and must stay the pure, digest-pinned reference path (same reasoning as the reference raster).

### Technical requirements

| Id        | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- | ---------------------------------------------- |
| TR-MOV-01 | `t_k = k · playbackRate / fps`, `frames = floor(simDuration · fps / playbackRate + 1e-9) + 1`; for `clips` and `sweep`, `playbackRate` is 1 and `simDuration` is `duration`                                                                                                                                                                                                                                                                                                                                                                                  |
| TR-MOV-02 | Pose at an arbitrary time: `posesAtTime(poses, t)` in `geometry/bodyPose.ts`, positions linear and orientations slerp between the bracketing samples; exact sample when `t` hits one (`                                                                                                                                                                                                                                                                                                                                                                      | t − t_i | ≤ 1e-12`). `render_motion` uses it (FR-MOV-13) |
| TR-MOV-03 | Simulation sample density: request `sampleRate = 1 / timestep` (every step) while `duration / timestep + 1 ≤ 6001`, else the largest rate under the cap; record `sampleIntervalS` in `data`, warn `MOV_SAMPLES_SPARSE` when the interval exceeds one frame interval `playbackRate / fps`                                                                                                                                                                                                                                                                     |
| TR-MOV-04 | `simulate_motion` returns poses and the named joints' series from one run (new `detail: 'poses+series'`, domain-dynamics); the simulation runs once per command                                                                                                                                                                                                                                                                                                                                                                                              |
| TR-MOV-05 | Clip evaluation moves to `packages/core/src/geometry/animationPose.ts` (pure, no three.js): `animationPoseAt(doc, t) → Record<entityId, { position, rotation }>`; `src/ui/viewport/3d/animationMath.ts` keeps only the three.js adapters and calls it. Only `trigger: 'auto'` clips play; `click` clips are listed in a warning `MOV_CLICK_CLIPS_SKIPPED`                                                                                                                                                                                                    |
| TR-MOV-06 | Fixed camera framed once on `mergeBounds` of every frame's scene bounds and every trace point; the camera is identical in all frames (`data.camera`)                                                                                                                                                                                                                                                                                                                                                                                                         |
| TR-MOV-07 | Overlays are raster primitives, not SVG: trace = stroke segments, current dot = filled polygon, labels = glyph outlines (`lib/font`, bundled sans) as even-odd fills; drawn last with depth bias so they stay on top; same primitives in reference and native raster                                                                                                                                                                                                                                                                                         |
| TR-MOV-08 | Highlight: an entity colour override in the render options (`options.ts`, new `colorOverrides: Record<entityId, '#rrggbb'>`), accent `#ff9f1c` default; "moving" = entities whose pose differs between any two frames by more than 1e-9 × scene size                                                                                                                                                                                                                                                                                                         |
| TR-MOV-09 | Readouts: joint value (rad shown in degrees, m / mm in document units), body CoM position, parameter value; label `name = value unit`; the same numbers go to `data.timeline[k].readouts`                                                                                                                                                                                                                                                                                                                                                                    |
| TR-MOV-10 | APNG (`packages/core/src/lib/apng.ts`): `acTL(num_frames, num_plays = 0)`, per frame `fcTL` (full canvas, `delay_num = 1`, `delay_den = fps`, `dispose_op = NONE`, `blend_op = SOURCE`) then `IDAT` (frame 0) / `fdAT` (others) with sequence numbers 0, 1, 2…; zlib through the existing PNG encoder; byte-identical output for identical frames                                                                                                                                                                                                            |
| TR-MOV-11 | `MediaPort` (`packages/core/src/model/media.ts`): `open(spec: { format: 'gif' \| 'mp4'; width; height; fps; quality: 'draft' \| 'standard' \| 'high'; frames }) → MediaSession \| MediaFailure`; `MediaSession.add(png: Uint8Array): MediaFailure \| null`; `finish(): { ok: true; bytes; encoder: { name, version, deterministic } } \| MediaFailure`; `abort()`. Synchronous like `RasterPort`. Getter / setter `commands/mediaPort.ts`; `ctx.media` in `context.ts` / `types.ts`                                                                          |
| TR-MOV-12 | Host transport `server/src/native/mediaPort.ts`: a job folder; `add` writes `frame-%05d.png` (memory stays one frame); `finish` runs `llull-compute media` (`job.json` kind `media`) through `runComputeSync` with a timeout of 30 s + 0.5 s per frame; reads `out.mp4` / `out.gif`; folder removed unless `LLULL_NATIVE_KEEP=1`. Installed by the CLI and the backend only when the binary exists                                                                                                                                                           |
| TR-MOV-13 | `llull-media` (Rust): GIF = one global palette (NeuQuant over frames 0, n/4, n/2, 3n/4), ordered 8×8 Bayer dither (no temporal flicker), changed-rectangle frames with transparency, delays by the cumulative rule of `generate_mov_reference.py`, NETSCAPE2.0 loop 0. MP4 = AV1 (`rav1e`, 4:2:0, BT.709 limited range, keyframe every 2 s, speed preset by quality) muxed by an own ISOBMFF writer (`ftyp` isom / iso6 / av01 / mp41, `moov` with one `trak`, `av1C`, `stts` delta 1 at timescale fps, `stss` keyframes, `mdat` after `moov` for streaming) |
| TR-MOV-14 | Even sizes for MP4 (4:2:0): odd width / height rounded down by 1 with warning `MOV_SIZE_ROUNDED`                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| TR-MOV-15 | Determinism: reference frames → `frameSha256[]` and, for APNG, `fileSha256`; GIF → `fileSha256` (palette and dither are deterministic by construction); MP4 → `fileSha256` only if the encoder reports `deterministic: true` (OQ-MOV-03); native frames → no digests, `deterministic: false` (existing provenance rule)                                                                                                                                                                                                                                      |
| TR-MOV-16 | Contact sheet: every `every`-th frame plus the last, columns ≤ 6, cell = frame scaled to ≤ 320 px wide, label `#k t = … s` in glyph outlines, one PNG (`sheet.png`), reference raster always (cheap, digestible)                                                                                                                                                                                                                                                                                                                                             |
| TR-MOV-17 | CLI `saveFiles`: a target with an extension picks the file of that extension from `data.files` (`.mp4`, `.gif`, `.apng`, `.png` → sheet) and writes `timeline.json` next to it as `<name>.timeline.json`; a directory target writes all files                                                                                                                                                                                                                                                                                                                |
| TR-MOV-18 | Drive readouts (FR-MOV-20, PHY-23): a readout id `<motorId>.<quantity>` resolves against `simulate_motion` drive series (PHY-23 TR-DRV-20) interpolated linearly at `t_k` (the series are sampled like joint series); `ledger.<element>` reads the cumulative ledger. Unknown motor or quantity → `MOV_UNKNOWN_ID`                                                                                                                                                                                                                                           |
| TR-MOV-19 | Plot strip (FR-MOV-21): raster primitives under the frame (the canvas grows by `heightPx`, default 160, ≤ 40 % of the height); polyline per quantity from all samples, shared time axis = the source duration, cursor at `t_k`, limit lines from the motor data (continuous torque, peak torque, max winding temperature); labels in glyph outlines (TR-MOV-07); `overlays.truth` draws the PHY-23 verdict text from one `check_motion_truth level: quick` run per command (reported in `data.truth`)                                                        |

## 3. Data model

No document change. Types (core):

```ts
// packages/core/src/model/media.ts
export type MediaFormat = 'gif' | 'mp4';
export interface MediaSpec {
  readonly format: MediaFormat;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly quality: 'draft' | 'standard' | 'high';
  readonly frames: number;
}
export interface MediaEncoder {
  readonly name: string;
  readonly version: string;
  readonly deterministic: boolean;
}
export type MediaFailure = { readonly ok: false; readonly code: string; readonly message: string };
export interface MediaSession {
  add(png: Uint8Array): MediaFailure | null;
  finish(): { ok: true; bytes: Uint8Array; encoder: MediaEncoder } | MediaFailure;
  abort(): void;
}
export interface MediaPort {
  open(spec: MediaSpec): MediaSession | MediaFailure;
}

// render_animation data
interface AnimationTimelineEntry {
  frame: number;
  tS: number;
  sample?: { before: number; after: number; weight: number };
  readouts: Record<string, { value: number; unit: string }>;
}
interface RenderAnimationData {
  frames: number;
  fps: number;
  videoDurationS: number;
  sourceDurationS: number;
  playbackRate: number;
  width: number;
  height: number;
  format: 'frames' | 'apng' | 'gif' | 'mp4';
  camera: ViewpointCamera;
  files: { fileName: string; base64: string }[]; // frames | video, timeline.json, sheet.png
  timeline: AnimationTimelineEntry[];
  renderer: 'reference' | 'native';
  rendererVersion?: string;
  frameSha256?: string[];
  fileSha256?: string;
  encoder?: MediaEncoder;
  sampleIntervalS?: number;
  warnings: { code: string; message: string }[];
}
```

## 4. Commands

### 4.1 `render_animation` (new, core, `commands/render/renderAnimation.ts` + `render/animation/*`, toolset `render`)

```ts
params: z.object({
  source: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('simulation'),
      duration: z.number().positive().max(600),
      timestep: z.number().min(1e-5).max(0.01).optional(),
      playbackRate: z.number().positive().max(100).optional(),
    }),
    z.object({
      kind: z.literal('sweep'),
      mode: z.enum(['joint', 'parameter']),
      target: z.string(),
      start: z.number(),
      end: z.number(),
      duration: z.number().positive().max(600),
      pingPong: z.boolean().optional(),
    }),
    z.object({ kind: z.literal('clips'), duration: z.number().positive().max(600) }),
    z.object({ kind: z.literal('still'), duration: z.number().positive().max(600) }), // camera-only (orbit / walkthrough)
  ]),
  fps: z.number().int().min(1).max(60).optional(), // default 30
  width: z.number().optional(),
  height: z.number().optional(), // default 1280×720; clamp [64, 1920] × [64, 1080]
  camera: z
    .object({
      view: z.enum([...views]).optional(),
      direction: vec3().optional(),
      viewpointId: z.string().optional(),
      walkthroughId: z.string().optional(),
      orbit: z.object({ turns: z.number(), axis: vec3().optional() }).optional(),
    })
    .optional(),
  overlays: z
    .object({
      time: z.boolean().optional(),
      trace: z.array(z.string()).max(4).optional(),
      readouts: z.array(z.string()).max(8).optional(),
      highlight: z.enum(['moving', 'none']).optional(),
      accent: z.string().optional(),
    })
    .optional(),
  format: z.enum(['frames', 'apng', 'gif', 'mp4']).optional(), // default 'mp4' (D-MOV-03)
  quality: z.enum(['draft', 'standard', 'high']).optional(),
  sheet: z.object({ every: z.number().int().min(1) }).optional(),
  maxFrames: z.number().int().min(1).max(1800).optional(),
  background: z.string().optional(),
  renderer: z.enum(['reference', 'native']).optional(),
});
```

```
@affects nothing — read-only; data: RenderAnimationData (§3)
@invariant frames = floor(sourceDuration · fps / playbackRate + 1e-9) + 1; timeline[k].tS = k · playbackRate / fps;
           every pose and readout of frame k comes from the same source state; the camera is identical in every frame (fixed mode)
@invariant the input document is deep-equal before and after; no FeatureStep is appended
@failure no motion for the source (no rigid bodies / unknown joint or parameter / no auto clip) -> MOV_NO_MOTION
@failure unknown id in trace / readouts / camera -> MOV_UNKNOWN_ID (ids listed)
@failure frames > maxFrames -> MOV_FRAME_BUDGET; frames × pixels > 1e8 for frames / apng -> MOV_RENDER_BUDGET
@failure camera fields combined illegally or degenerate -> MOV_CAMERA_INVALID; bad colour -> MOV_RENDER_INVALID
@failure gif / mp4 without ctx.media, or renderer native without ctx.raster -> NATIVE_TOOL_MISSING (remediation: format "apng" / renderer "reference")
@failure encoder failure or timeout -> MOV_ENCODE_FAILED (no partial file in data); simulation refusal -> MOV_SOURCE_FAILED with the simulate_motion summary
```

Description (AF-02) names the review loop: "render `format: 'frames'` with `sheet` first, look at `sheet.png`, then encode".

### 4.2 `render_motion` (changed)

`nearestSample` replaced by `posesAtTime` (TR-MOV-02); `frames[].time` is the requested time; trace drawing moves to the shared
`render/animation/overlays.ts` helpers (SVG emitter kept for this command's SVG output). Tool-schema snapshot unchanged (params
unchanged); description sentence "Frames show the nearest recorded sample" replaced.

### 4.3 `simulate_motion` (changed, domain-dynamics)

`detail: 'poses+series'` returns both `poses` and `series` (TR-MOV-04). Snapshot updated.

## 5. Algorithms

- **Pose interpolation:** for `t` in `[t_i, t_{i+1}]`, `w = (t − t_i) / (t_{i+1} − t_i)`; position `p_i + w (p_{i+1} − p_i)`; orientation
  `slerp(q_i, q_{i+1}, w)` on the shorter arc (negate `q_{i+1}` when the dot product is negative); `w ∈ {0, 1}` returns the sample
  itself (bit-exact).
- **Sweep:** value at frame k: `start + (end − start) · s_k`, `s_k = k / (frames − 1)`; `pingPong`: `s_k = 1 − |1 − 2k / (frames − 1)|`.
  Pose via `evaluateMotionInternal` with the value override (same code path as `motion_study`, so loop closure and contact limits
  agree).
- **Clips:** spin `θ = speed · t`; oscillate `θ = amplitude · sin(2π · frequency · t)`; rotation about `axis` through `pivot` (default:
  target position) premultiplied in clip order, position channel adds `axiŝ · θ` — the formulas of today's `animationMath.ts`,
  re-implemented on core `Vec3` / quaternion helpers.
- **Orbit camera:** eye rotated about `axis` (default +Z) through the framed centre by `2π · turns · k / (frames − 1)`.
- **GIF timing:** delay_k = `round(100 (k + 1) / fps) − round(100 k / fps)` with round-half-up; cumulative error < 1 cs.
- **MP4 timing:** timescale = fps, every sample duration 1, `mvhd` / `mdhd` duration = frames; exact for integer fps.

## 6. Interop and persistence

Nothing is stored in the document. Files: PNG frames `frame-0001.png …`, `animation.apng` (served with `image/apng`, also valid
`.png`), `animation.gif`, `animation.mp4` (`video/mp4`, `av01` sample entry), `timeline.json` (`{ fps, playbackRate, frames,
timeline[] }`), `sheet.png`. The CLI `--save` rules are in TR-MOV-17.

## 7. Surfaces and stable error codes

| Code                                        | Raised by        | Meaning / fix                                                                          |
| ------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------- |
| `MOV_NO_MOTION`                             | render_animation | the source moves nothing: add rigid bodies / a joint / an `animate` clip               |
| `MOV_SOURCE_FAILED`                         | render_animation | the simulation or sweep refused; its summary is quoted                                 |
| `MOV_UNKNOWN_ID`                            | render_animation | a trace / readout / camera id does not exist (ids listed)                              |
| `MOV_FRAME_BUDGET`                          | render_animation | more frames than `maxFrames` (≤ 1800): lower fps, duration or raise playbackRate       |
| `MOV_RENDER_BUDGET`                         | render_animation | frames × pixels > 10⁸ for `frames` / `apng`: use `mp4` or a smaller size               |
| `MOV_CAMERA_INVALID` / `MOV_RENDER_INVALID` | render_animation | bad camera combination / colour                                                        |
| `MOV_ENCODE_FAILED`                         | render_animation | the encoder failed or timed out; nothing written                                       |
| `MOV_SIZE_ROUNDED` (warn)                   | render_animation | odd MP4 size rounded down to even                                                      |
| `MOV_SAMPLES_SPARSE` (warn)                 | render_animation | the simulation sample interval is longer than a frame interval; poses are interpolated |
| `MOV_CLICK_CLIPS_SKIPPED` (warn)            | render_animation | `trigger: 'click'` clips do not play in a render                                       |
| `NATIVE_TOOL_MISSING`                       | render_animation | existing code: no `llull-compute` for gif / mp4 / native frames                        |

CLI: no special case (AF-01); `--save` per TR-MOV-17. UI: "Export animation…" in the transport controls
(`src/ui/viewport/3d/ViewportControls.tsx` `AnimationTransportControls`), a dialog in `src/ui/panels/`, preview = `sheet.png`,
save through the desktop File dialog.

## 8. Performance and robustness budgets (reference machine: the owner's Windows 11 workstation)

| Operation                                                        | Today              | Budget                                       |
| ---------------------------------------------------------------- | ------------------ | -------------------------------------------- |
| Frame, 640×360, slider-crank, SVG path                           | ≈ 45 ms (measured) | —                                            |
| 300 frames 1280×720 slider-crank, native raster + MP4 `standard` | —                  | ≤ 60 s total                                 |
| 300 frames 1280×720, reference raster, `frames`                  | —                  | ≤ 300 s                                      |
| MP4 encode alone, 300 frames 1280×720 `standard`                 | —                  | ≤ 20 s (measured in M0, budget revised once) |
| Peak memory of the host during encoding                          | —                  | ≤ 1 frame RGBA + encoder state (≤ 512 MB)    |
| Simulation                                                       | once per command   | never re-run per frame                       |

Robustness: the encoder job runs through `runComputeSync` (tree kill on timeout); a failed `add` aborts the session and the job
folder; the command stays pure whatever happens.

## 9. Test strategy

| Level                              | What                                                                                                                    | VC                              |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| unit (core)                        | timeline, poses vs closed form, `posesAtTime`, sweep, clips, purity, camera, budgets, codes, overlays, highlight, sheet | VC-MOV-01…08, 11, 12, 15…18, 24 |
| unit (core lib)                    | APNG writer: chunk order, sequence numbers, CRC, delays, byte-identical rerun                                           | VC-MOV-07, 09                   |
| contract                           | tool-schema snapshot (new command, `simulate_motion` detail), `isolatedSuites` if a suite installs a fake `MediaPort`   | —                               |
| golden                             | `mov_clip_spin` and a sweep plan: timeline + frame digests pinned per `rendererVersion`                                 | VC-MOV-07                       |
| native (`solver/`, `native:check`) | `llull-media` unit tests: GIF delays / loop / palette determinism, MP4 box tree, AV1 config, frame count                | VC-MOV-09, 10, 25               |
| server (`server/tests`)            | `mediaPort` with the real binary: mp4 / gif from 30 frames, timeout kill, missing binary, `--save` picking              | VC-MOV-10, 13, 14, 22           |
| component (`tests/component`)      | Export dialog dispatches the same params; UI player and core clip pose equal                                            | VC-MOV-19                       |
| independent oracle                 | `validation/check_media.py` on every produced file (stdlib parser, no shared code)                                      | VC-MOV-09, 10                   |
| human                              | MP4 plays in Windows 11 Media Player and PowerPoint (M0, then each release)                                             | VC-MOV-10                       |
| performance                        | `scripts/` timing run on the reference machine                                                                          | VC-MOV-20                       |

## 10. Delivery plan

| Milestone | Content                                                                                                                                                                                                         | Lane                                            | Depends on            | Effort (agent-days) |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | --------------------- | ------------------- |
| MOV-M0    | spike: rav1e speed / determinism / Windows playback, licence audit (decides OQ-MOV-01..03); `posesAtTime` + `render_motion` exact instants                                                                      | 1                                               | —                     | 1                   |
| MOV-M1    | `render_animation` frames / apng / timeline / sheet, sources simulation + sweep + clips, fixed camera, overlays as raster primitives, highlight override, clip math into core, `simulate_motion` `poses+series` | 1 (+2 for the `animationMath.ts` import switch) | MOV-M0                | 4                   |
| MOV-M2    | `llull-media` crate + `llull-compute media`, `MediaPort` + `ctx.media`, server transport, desktop bundling, CLI save by extension                                                                               | 1 (crate, port) + 4 (server, CLI)               | MOV-M0                | 4                   |
| MOV-M3    | camera paths (viewpoint, walkthrough, orbit, `still` source), `llull-cli` skill review-loop recipe, golden plans                                                                                                | 1                                               | MOV-M1                | 2                   |
| MOV-M4    | desktop "Export animation…" dialog + preview, verified in the app                                                                                                                                               | 2                                               | MOV-M2, MOV-M3        | 2                   |
| MOV-M5    | drive readouts + plot strip + truth badge (TR-MOV-18/19)                                                                                                                                                        | 1                                               | MOV-M1, PHY-23 DRV-M3 | 1.5                 |
| MOV-V2    | H.264 via the OS encoder, section / x-ray per frame, presentation look mode                                                                                                                                     | 1/2                                             | VIS-M4b               | later               |

Total MVP + V1 ≈ 13 agent-days. Order: M0 → (M1 ∥ M2) → M3 → M4. Each milestone: `cad-reviewer`, `npm run check:coverage`
(core changed), server suite for M2, `native:check` for M2.

## 11. Open questions and proposed decisions

| #         | Question                                                                                                                                                                                                                                                                      | Proposed                                                                                                                                                                                                                                            |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-MOV-01  | Encoder technology                                                                                                                                                                                                                                                            | Rust `llull-media` in `solver/`, bundled in `llull-compute` (C7 Rust default, offline, permissive licences). ffmpeg is not bundled (size, GPL / LGPL build variants, patent-encumbered codecs) and not called even when on `PATH` (one tested path) |
| D-MOV-02  | MP4 codec                                                                                                                                                                                                                                                                     | AV1 (royalty-free [R9], pure-Rust encoder [R11]); H.264 only through the OS encoder (V2, OQ-MOV-02)                                                                                                                                                 |
| D-MOV-03  | Default `format`                                                                                                                                                                                                                                                              | `mp4` (what a user wants to share); without `ctx.media` it refuses with a remediation instead of silently writing another format                                                                                                                    |
| D-MOV-04  | MP4 muxer                                                                                                                                                                                                                                                                     | own ISOBMFF writer (≈ 300 lines, deterministic, no dependency) instead of a muxing crate                                                                                                                                                            |
| D-MOV-05  | Where `render_animation` lives                                                                                                                                                                                                                                                | core `commands/render/` (needs only core + `ctx.registry` + ports), not the dynamics plugin: clips and sweeps are core motion                                                                                                                       |
| OQ-MOV-01 | Does an AV1 MP4 play on the reference machine's Windows 11 Media Player and in PowerPoint without installs?                                                                                                                                                                   | measure in M0; if not, V2 H.264 moves into V1                                                                                                                                                                                                       |
| OQ-MOV-02 | H.264 through Media Foundation (Windows) / VideoToolbox (macOS): licence covered by the OS, but platform code paths                                                                                                                                                           | V2; port stays the same, encoder `system`                                                                                                                                                                                                           |
| OQ-MOV-03 | Is `rav1e` bit-reproducible for the same input, settings and thread count?                                                                                                                                                                                                    | measure in M0 (two runs, single and multi-thread); digest only if yes                                                                                                                                                                               |
| OQ-MOV-06 | rav1e's default `asm` feature needs NASM ≥ 2.14.02 on x86_64 [R11]; without it (`RAV1E_CPU_TARGET=rust`) encoding is slower                                                                                                                                                   | M0 measures both; if asm is needed, add NASM to the Windows solver toolchain (`docs/decisions/SV1-solver-toolchain-windows.md`) and to `native:check`'s prerequisites                                                                               |
| OQ-MOV-04 | Progress for long renders (AF-40): commands are synchronous today                                                                                                                                                                                                             | report per-frame progress through the host's existing progress channel if one is available to commands; otherwise rely on `--timeout` and budgets (decide in M1)                                                                                    |
| OQ-MOV-05 | Related gaps raised by the teardown comparison (2026-11-02), not in this pack: presentation-quality look mode on the native raster; review against reference photos (beyond `drawing-to-model`); `.lld` expressiveness (functions, comprehensions, modules: 08 ASC M4b / M4c) | separate packs / board items, owner to prioritise                                                                                                                                                                                                   |

## 12. References

[R1]–[R11] as in [`FUNCTIONAL_SPEC.md`](FUNCTIONAL_SPEC.md) §11; grades and extracts in [`validation/sources.md`](validation/sources.md).
