/**
 * @layer ui/viewport/2d
 *
 * Click-to-select for the 2D view while no draw or modify tool is armed.
 * Plain click selects the entity under the cursor (nearest outline, else the smallest closed
 * shape containing the point), Shift/Ctrl/Meta-click toggles it, a click on empty
 * space clears the selection. A drag (pan) is not a click. Selection is local view state.
 * The capture plane sits in front of the snap plane: the snap plane stops pointer propagation,
 * which would otherwise occlude this one; having no move handler, this plane lets moves through.
 */

import { useCallback, useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import type { Vec2 } from '@core/model/types';
import { useStore } from '@ui/store';
import { pickEntityId } from './modifyHelpers';

/** Pick radius in screen pixels. */
const PICK_RADIUS_PX = 10;

/** Pointer travel (px) above which a press is a pan, not a click. */
const CLICK_MAX_TRAVEL_PX = 4;

interface SelectPickInteractionProps {
  /** Current ortho camera zoom (px per world unit) — scales the pick radius. */
  zoom: number;
}

export function SelectPickInteraction({ zoom }: SelectPickInteractionProps): React.ReactElement {
  const geo = useMemo(() => new THREE.PlaneGeometry(1e8, 1e8), []);
  const mat = useMemo(
    () => new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide }),
    [],
  );

  useEffect(() => {
    return () => {
      geo.dispose();
      mat.dispose();
    };
  }, [geo, mat]);

  const handleClick = useCallback(
    (e: ThreeEvent<MouseEvent>) => {
      if (e.delta > CLICK_MAX_TRAVEL_PX) return;
      const state = useStore.getState();
      const [originX, originY] = state.renderOrigin;
      const worldPick: Vec2 = [e.point.x + originX, e.point.y + originY];
      const tolerance = PICK_RADIUS_PX / (zoom > 0 ? zoom : 1);
      const id = pickEntityId(state.document, worldPick, tolerance);
      const additive = e.shiftKey || e.ctrlKey || e.metaKey;
      if (id === null) {
        if (!additive) state.clearSelection();
      } else if (additive) {
        state.toggleSelection(id);
      } else {
        state.select([id]);
      }
    },
    [zoom],
  );

  return <mesh geometry={geo} material={mat} position={[0, 0, 0.002]} onClick={handleClick} />;
}
