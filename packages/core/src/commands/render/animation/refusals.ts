/** The stable refusals of render_animation (TECHNICAL_SPEC §7) with the one-line fix each carries. */

import { tableRejection } from '../../noop';

const REMEDIATION: Readonly<Record<string, string>> = {
  MOV_NO_MOTION: 'add rigid bodies and joints (add_rigid_body, add_body_joint), a joint or parameter to sweep, or an auto clip (animate)',
  MOV_SOURCE_FAILED: 'run simulate_motion (or motion_study) on its own and fix what it reports',
  MOV_UNKNOWN_ID: 'name existing ids: rigid body or joint ids (simulation), joint or parameter ids (sweep), clip / entity ids (clips)',
  MOV_FRAME_BUDGET: 'lower fps or the duration, raise playbackRate (simulation), or raise maxFrames (at most 1800)',
  MOV_RENDER_BUDGET: 'use a smaller width / height or fewer frames; format "mp4" streams frames and has no pixel budget',
  MOV_CAMERA_INVALID: 'give either view or a finite non-zero direction, not both',
  MOV_RENDER_INVALID: 'colours are #rgb or #rrggbb',
  MOV_ENCODE_FAILED: 'retry with format "apng" or "frames" (or a smaller size); the summary names the encoder error',
  NATIVE_TOOL_MISSING:
    'this host has no video encoder / native raster: use format "apng" (or "frames") and renderer "reference", or run in the llull CLI / desktop app with llull-compute built',
  NATIVE_JOB_FAILED: 'retry with renderer "reference"; the job log is in the summary',
};

export const animationRejection = tableRejection(REMEDIATION);
