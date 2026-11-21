// The one function that draws a `capture_viewport` frame: set by the mounted 3D canvas (CaptureRig), called by the backend channel (useViewportCapture).

import type { ViewportCaptureRequest } from '@core/model/viewportCapture';

export interface CapturedPng {
  readonly png: Uint8Array;
  readonly width: number;
  readonly height: number;
}

export type ViewportCapturer = (request: ViewportCaptureRequest) => Promise<CapturedPng>;

let capturer: ViewportCapturer | null = null;

/** Install (or with null remove) the capturer of the mounted 3D viewport. */
export function setViewportCapturer(next: ViewportCapturer | null): void {
  capturer = next;
}

/** @failure no 3D canvas mounted (2D view, sheet) -> rejects with VIEWPORT_CAPTURE_FAILED text */
export function captureFrame(request: ViewportCaptureRequest): Promise<CapturedPng> {
  if (capturer === null)
    return Promise.reject(new Error('the 3D viewport is not shown (switch the app to the 3D view and close any sheet)'));
  return capturer(request);
}
