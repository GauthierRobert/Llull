import type { CadDocument } from './types';

/**
 * Optional viewport-capture port (ASC M6a, TR-ASC-17): `ctx.viewportCapture` asks the host for one frame of the open desktop viewport
 * drawn with a TEMPORARY camera (never the user's) and returns its PNG. Synchronous like every port: a host whose frame comes from another
 * process answers from the frames it already holds or asks to be run again (`VIEWPORT_PENDING`, `server/src/native/deferredRun.ts`).
 */

/** Named view of a capture (the render_view names). */
type ViewportCaptureView = 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right' | 'iso';

/** One frame asked of the viewport; every camera field is a temporary pose, the user's camera is not touched. */
export interface ViewportCaptureRequest {
  readonly view: ViewportCaptureView;
  /** Direction from the scene toward the camera (Z-up); overrides `view`. */
  readonly direction?: readonly [number, number, number];
  /** World point looked at; default the centre of the visible bounds. */
  readonly target?: readonly [number, number, number];
  /** Magnification of the framed scene (1 = the whole scene fits). */
  readonly zoom: number;
  readonly width: number;
  readonly height: number;
  /** CSS colour of the background; absent = the viewport's own. */
  readonly background?: string;
  /** Layer ids not drawn in this frame only (the document's visibility is not changed). */
  readonly hideLayers: readonly string[];
}

export type ViewportCaptureOutcome =
  | { readonly ok: true; readonly png: Uint8Array; readonly width: number; readonly height: number }
  | { readonly ok: false; readonly code: string; readonly message: string };

export interface ViewportCapturePort {
  /**
   * @failure no desktop renderer connected -> VIEWPORT_UNAVAILABLE; the frame is still being drawn -> VIEWPORT_PENDING (the host runs the command again);
   * no answer in time -> VIEWPORT_TIMEOUT; the renderer could not draw it -> VIEWPORT_CAPTURE_FAILED; `doc` (the document of this run) is not the one the
   * viewport shows (a plan with earlier steps, an uncommitted run, a renderer that has not caught up) -> VIEWPORT_STALE; stopped by the caller -> VIEWPORT_CANCELLED
   */
  capture(request: ViewportCaptureRequest, doc: CadDocument): ViewportCaptureOutcome;
}
