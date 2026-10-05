/**
 * @layer ui/viewport
 *
 * Calls r3f `invalidate()` whenever the CAD document or renderOrigin change, so the
 * 2D and 3D Canvases repaint under `frameloop="demand"` (architecture L7: one model,
 * two views). Subscribes outside React (no re-render); commands are pure (L3), so
 * reference equality is a sufficient change test. Mount inside a Canvas.
 */

import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import { useStore } from '@ui/store';

export function StoreInvalidator(): null {
  const invalidate = useThree((s) => s.invalidate);

  useEffect(
    () =>
      useStore.subscribe((state, previous) => {
        if (state.document !== previous.document || state.renderOrigin !== previous.renderOrigin) {
          invalidate();
        }
      }),
    [invalidate],
  );

  return null;
}
