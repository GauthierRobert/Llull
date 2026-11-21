/**
 * `ctx.viewportCapture` of the backend (ASC M6a): answers from the frame the resolve already holds, or asks the host for one frame of the desktop
 * renderer (`deferredRun.ts`: the job is awaited on the event loop, then the command runs again) and answers VIEWPORT_PENDING.
 * @invariant a frame is of ONE document state: the run's document must be the live document (else VIEWPORT_STALE: a plan's earlier steps are not committed), the job key
 *   holds that state's hash, and the renderer draws only once its own document has the same hash (it answers VIEWPORT_STALE when it never does)
 * @invariant outside a resolve (a plain synchronous run) a frame cannot be awaited: VIEWPORT_UNAVAILABLE
 */

import { createHash } from 'node:crypto';
import type { CadDocument } from '@core/model/types';
import type { ViewportCapturePort, ViewportCaptureOutcome, ViewportCaptureRequest } from '@core/model/viewportCapture';
import { noteDeferral } from '@core/geometry/mesh/engine';
import { documentHash } from '@protocol/liveSync';
import { getLiveDoc } from '../liveDocument';
import { currentScope, type DeferredScope } from '../native/deferredRun';
import { captureTimeoutMs, hasRenderer, requestFrame } from './captureBroker';

const keyOf = (request: ViewportCaptureRequest, hash: string): string =>
  `viewport:${createHash('sha256')
    .update(JSON.stringify([request, hash]))
    .digest('hex')}`;

const refused = (code: string, message: string): ViewportCaptureOutcome => ({ ok: false, code, message });

function heldOutcome(held: NonNullable<ReturnType<DeferredScope['lookup']>>): ViewportCaptureOutcome {
  if ('frame' in held) return { ok: true, ...held.frame };
  if ('code' in held) return refused(held.code.startsWith('VIEWPORT_') ? held.code : 'VIEWPORT_CAPTURE_FAILED', held.message);
  return refused('VIEWPORT_CAPTURE_FAILED', 'unexpected job result');
}

export function createViewportCapturePort(): ViewportCapturePort {
  return {
    capture: (request, doc: CadDocument) => {
      const scope = currentScope();
      const hash = documentHash(doc);
      const key = keyOf(request, hash);
      const held = scope?.lookup(key);
      if (held !== undefined) return heldOutcome(held);
      if (!hasRenderer())
        return refused('VIEWPORT_UNAVAILABLE', 'no desktop viewport is connected (the app is not open or not on this backend)');
      if (scope === null) return refused('VIEWPORT_UNAVAILABLE', 'this host run cannot wait for the desktop viewport');
      if (hash !== documentHash(getLiveDoc()))
        return refused(
          'VIEWPORT_STALE',
          'the document of this run is not the one the viewport shows (steps of a plan before the capture, or an uncommitted run)',
        );
      if (scope.cancelled) return refused('VIEWPORT_CANCELLED', 'the capture was cancelled');
      if (!scope.deferring)
        scope.request({
          key,
          op: 'capture_viewport',
          heartbeatMs: 2000,
          start: (signal) => requestFrame(request, hash, signal, captureTimeoutMs()),
        });
      noteDeferral();
      return refused('VIEWPORT_PENDING', 'the viewport frame is still being drawn');
    },
  };
}
