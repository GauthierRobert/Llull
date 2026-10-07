/**
 * @layer ui/viewport/2d
 *
 * ZoomExtents2D — frames the whole document in the orthographic 2D view on mount and whenever
 * the document camera changes (fit_view / set_camera / look_at). The extents come from the
 * read-only `measure_bounding_box` command; only the three.js camera is touched (view state).
 */

import { useEffect } from 'react';
import type * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import type { MapControls as MapControlsImpl } from 'three-stdlib';
import { useStore } from '@ui/store';
import { execute } from '@core/commands/registry';
import { isBoundsData } from '@ui/resultData';

const PADDING = 1.15;

export function ZoomExtents2D(): null {
  const { camera, controls, size, invalidate } = useThree();
  const docCamera = useStore((s) => s.document.camera);

  useEffect(() => {
    const { document, renderOrigin } = useStore.getState();
    if (document.order.length === 0) return;
    const { data: bounds } = execute(document, 'measure_bounding_box', {});
    if (!isBoundsData(bounds)) return;
    const width = Math.max(bounds.max[0] - bounds.min[0], 1e-6);
    const height = Math.max(bounds.max[1] - bounds.min[1], 1e-6);
    const centerX = (bounds.min[0] + bounds.max[0]) / 2 - renderOrigin[0];
    const centerY = (bounds.min[1] + bounds.max[1]) / 2 - renderOrigin[1];
    const ortho = camera as THREE.OrthographicCamera;
    ortho.zoom = Math.min(size.width / (width * PADDING), size.height / (height * PADDING));
    ortho.position.set(centerX, centerY, ortho.position.z);
    ortho.updateProjectionMatrix();
    const map = controls as MapControlsImpl | null;
    if (map) {
      map.target.set(centerX, centerY, 0);
      map.update();
    }
    invalidate();
    // Re-fit only on mount and on document-camera changes, not on every edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docCamera, controls]);

  return null;
}
