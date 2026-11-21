/**
 * `ctx.viewportCapture` of the backend (ASC M6a): answers from the frame the resolve already holds, or asks the host for one frame of the desktop
 * renderer (`deferredRun.ts`: the job is awaited on the event loop, then the command runs again) and answers VIEWPORT_PENDING.
 * @invariant outside a resolve (a plain synchronous run) a frame cannot be awaited: VIEWPORT_UNAVAILABLE
 */

import { createHash } from 'node:crypto';
import type { ViewportCapturePort, ViewportCaptureRequest } from '@core/model/viewportCapture';
import { noteDeferral } from '@core/geometry/mesh/engine';
import { currentScope } from '../native/deferredRun';
import { captureTimeoutMs, hasRenderer, requestFrame } from './captureBroker';

const keyOf = (request: ViewportCaptureRequest): string => `viewport:${createHash('sha256').update(JSON.stringify(request)).digest('hex')}`;

const unavailable = (message: string): { readonly ok: false; readonly code: string; readonly message: string } => ({
  ok: false,
  code: 'VIEWPORT_UNAVAILABLE',
  message,
});

export function createViewportCapturePort(): ViewportCapturePort {
  return {
    capture: (request) => {
      const scope = currentScope();
      if (!hasRenderer()) return unavailable('no desktop viewport is connected (the app is not open or not on this backend)');
      if (scope === null) return unavailable('this host run cannot wait for the desktop viewport');
      const key = keyOf(request);
      const held = scope.lookup(key);
      if (held !== undefined) {
        if ('frame' in held) return { ok: true, ...held.frame };
        if ('code' in held)
          return { ok: false, code: held.code.startsWith('VIEWPORT_') ? held.code : 'VIEWPORT_CAPTURE_FAILED', message: held.message };
        return { ok: false, code: 'VIEWPORT_CAPTURE_FAILED', message: 'unexpected job result' };
      }
      if (scope.cancelled) return { ok: false, code: 'MESH_CANCELLED', message: 'the capture was cancelled' };
      if (!scope.deferring)
        scope.request({
          key,
          op: 'capture_viewport',
          heartbeatMs: 2000,
          start: (signal) => requestFrame(request, signal, captureTimeoutMs()),
        });
      noteDeferral();
      return { ok: false, code: 'VIEWPORT_PENDING', message: 'the viewport frame is still being drawn' };
    },
  };
}
