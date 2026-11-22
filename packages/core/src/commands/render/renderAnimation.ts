/**
 * render_animation (PHY-22 MOV-M1): a motion source (physics simulation, joint / parameter sweep, animation clips) turned into a time-exact frame
 * sequence through ONE fixed camera, with overlays drawn as raster primitives, a timeline of the numbers behind every frame and an optional contact
 * sheet. Frames and APNG are built here (the reference raster: digests); gif / mp4 go through the host encoder `ctx.media` (MOV-M2).
 */

import type { CommandResult } from '../types';
import { defineCommand } from '../schema';
import { renderAnimationParams } from './renderAnimationSchema';
import { runRenderAnimation } from './renderAnimationRun';

/**
 * @affects nothing — read-only; data { frames, fps, videoDurationS, sourceDurationS, playbackRate, width, height, format, camera (frame 0), cameraMode, files[{ fileName, base64 }], timeline[{ frame, tS, sample?, readouts }], moving, traces?{ id: { path (all samples, 6 decimals), at (per frame, exact) } }, renderer, rendererVersion?, frameSha256?, fileSha256?, sheet?, sampleIntervalS?, warnings[{ code, message }] }
 * @invariant frames = floor(sourceDuration · fps / playbackRate + 1e-9) + 1; timeline[k].tS = k · playbackRate / fps; pose, readouts and trace dot of frame k come from the same source state; the camera is one value for all frames unless camera.walkthroughId / camera.orbit (then data.timeline[k].camera)
 * @invariant the input document is deep-equal before and after; no FeatureStep is appended; reference frames are byte-deterministic per rendererVersion (frameSha256, APNG fileSha256)
 * @failure no motion -> MOV_NO_MOTION; unknown id -> MOV_UNKNOWN_ID; frames > maxFrames -> MOV_FRAME_BUDGET; frames × pixels > 1e8 (frames / apng) -> MOV_RENDER_BUDGET; bad camera -> MOV_CAMERA_INVALID; bad colour -> MOV_RENDER_INVALID
 * @failure gif / mp4 without ctx.media, or renderer native without ctx.raster -> NATIVE_TOOL_MISSING; simulation refused -> MOV_SOURCE_FAILED; APNG writer or video encoder failure -> MOV_ENCODE_FAILED
 * @invariant an mp4 has even sides (odd width / height rounded down by 1, MOV_SIZE_ROUNDED); a video fileSha256 is set only for the reference renderer and a deterministic encoder
 */
export const renderAnimation = defineCommand({
  name: 'render_animation',
  annotations: { readOnly: true },
  description:
    'RENDER A MOVING MECHANISM as a time-exact frame sequence, a timeline of the numbers behind each frame and a contact sheet. Sources: ' +
    '"simulation" (runs simulate_motion ONCE, then draws each frame at its exact instant t = k · playbackRate / fps by interpolating the recorded poses; use ' +
    'playbackRate < 1 for slow motion, e.g. 0.01 shows a 0.06 s crank turn as 6 s), "sweep" (drives a joint or parameter from start to end, optionally and back, with the poses of motion_study) ' +
    '"clips" (the document\'s animate clips, evaluated exactly as the viewport plays them) or "still" (nothing moves: a camera-only film). By default the camera is fixed: framed once on every frame\'s bounds so nothing leaves the picture. ' +
    'CAMERA PATHS (`camera`): `viewpointId` (a saved viewpoint, as saved), `walkthroughId` (the render_walkthrough camera at t = k / fps) or `orbit` {turns, axis?, loop?} (a turntable about the scene centre), combined with any source; a still source needs walkthroughId or orbit; the camera of each frame is in data.timeline[k].camera. ' +
    'Overlays are drawn into the picture: `time` label, `trace` (centre-of-mass path of named bodies with a dot at the current position), `readouts` (joint values, body positions, parameters or clip values as "name = value unit"; the same numbers are in data.timeline[k].readouts), data.traces[id] = { path, at[k] } gives the traced positions, `highlight: "moving"` (moving parts in the accent colour). ' +
    'With a site context (set_site_context) every frame is lit by the site sun with its shadows and, when the site has groundElevation, a ground plane at that height fitted to the motion bounds (the same in every frame); sky is not drawn. ' +
    'REVIEW LOOP: first render format "frames" with `sheet` {every: n} and look at sheet.png (one image of every n-th frame, labelled #k t = … s) to check camera, overlays and motion; then render the format you want to keep. ' +
    'Formats: "frames" (PNG files frame-0001.png …), "apng" (animation.apng, loops forever), "gif" / "mp4" (animation.gif / animation.mp4 through the native video encoder, AV1 in MP4; a host without it refuses with NATIVE_TOOL_MISSING: use "apng"; `quality` draft | standard | high applies to mp4 only; a gif is made at most 50 fps, MOV_GIF_FPS_CLAMPED). The default is "mp4", so set `format` explicitly in a host without the encoder. ' +
    'Always in data.files: timeline.json (and sheet.png with `sheet`). The reference renderer (default) gives data.frameSha256[] (and fileSha256 for apng), stable per rendererVersion; renderer "native" draws on the GPU through llull-compute (no digests). ' +
    'Budgets (stable codes): MOV_FRAME_BUDGET (more than maxFrames, at most 1800), MOV_RENDER_BUDGET (frames × width × height over 1e8 for frames / apng). Other refusals: MOV_ENCODE_FAILED (the encoder failed; nothing is returned), MOV_NO_MOTION, MOV_UNKNOWN_ID, MOV_SOURCE_FAILED, MOV_CAMERA_INVALID, MOV_RENDER_INVALID, NATIVE_TOOL_MISSING. ' +
    'Warnings in data.warnings: MOV_SAMPLES_SPARSE (the simulation samples are further apart than a frame; poses are interpolated), MOV_SIZE_ROUNDED (odd mp4 size rounded down to even), MOV_GIF_FPS_CLAMPED (gif above 50 fps made at 50), MOV_CLICK_CLIPS_SKIPPED, MOV_CAMERA_PATH_DURATION (walkthrough and video lengths differ), MOV_LOOP_OPEN, MOV_OVERLAY_TEXT_SKIPPED (no bundled font: labels not drawn). ' +
    'Read-only: the document is never changed. CLI: `--save dir/` writes all files, `--save out.mp4` (or .gif, .apng) writes that one file and out.timeline.json.',
  params: renderAnimationParams,
  run: (doc, params, ctx): CommandResult => runRenderAnimation(doc, params, ctx),
});
