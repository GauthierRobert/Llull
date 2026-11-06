/** The time base of render_animation (TR-MOV-01): frame k shows simulated time k · playbackRate / fps. */

/**
 * Number of frames of a run of `sourceDurationS` simulated seconds shown at `playbackRate` simulated seconds per video second.
 * @invariant floor(duration · fps / playbackRate + 1e-9) + 1
 */
export function frameCountOf(sourceDurationS: number, fps: number, playbackRate: number): number {
  return Math.floor((sourceDurationS * fps) / playbackRate + 1e-9) + 1;
}

/** Simulated time (seconds) of frame `frame`. */
export const frameTime = (frame: number, fps: number, playbackRate: number): number => (frame * playbackRate) / fps;
