// Minor + major XY grids: viewport-sized patches (localGridPatch) re-centred on the step-snapped camera each frame, so
// they look infinite with bounded line counts; geometry rebuilt only on step / division changes.

import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { adaptiveGridStep, majorGridStep, localGridPatch } from './gridHelpers';

interface AdaptiveGrid2DProps {
  minorColor: number;
  majorColor: number;
  /** Render-space z of the lowest drawn plane. */
  baseZ: number;
}

function createFlatGrid(extent: number, divisions: number, color: number): THREE.GridHelper {
  const grid = new THREE.GridHelper(extent, divisions, color, color);
  grid.rotation.x = Math.PI / 2;
  grid.renderOrder = -1;
  return grid;
}

function disposeGrid(grid: THREE.GridHelper): void {
  grid.geometry.dispose();
  (grid.material as THREE.Material).dispose();
}

/** The helper keeps its own material. */
function resizeGrid(grid: THREE.GridHelper, extent: number, divisions: number, color: number): void {
  const scratch = new THREE.GridHelper(extent, divisions, color, color);
  grid.geometry.dispose();
  grid.geometry = scratch.geometry;
  (scratch.material as THREE.Material).dispose();
}

export function AdaptiveGrid2D({ minorColor, majorColor, baseZ }: AdaptiveGrid2DProps): React.ReactElement {
  const minorGrid = useMemo(() => createFlatGrid(100, 10, minorColor), [minorColor]);
  const majorGrid = useMemo(() => createFlatGrid(100, 10, majorColor), [majorColor]);
  const lastBuilt = useRef({ step: 0, minorDivisions: 0, majorDivisions: 0 });
  const { camera, size } = useThree();

  useEffect(
    () => () => {
      disposeGrid(minorGrid);
      disposeGrid(majorGrid);
    },
    [minorGrid, majorGrid],
  );

  useFrame(() => {
    const ortho = camera as THREE.OrthographicCamera;
    const zoom = ortho.zoom > 0 ? ortho.zoom : 50;
    const step = adaptiveGridStep(zoom);
    const visibleWorld = Math.max(size.width, size.height) / zoom;
    const minorPatch = localGridPatch(visibleWorld, step);
    const majorPatch = localGridPatch(visibleWorld, majorGridStep(step));

    const built = lastBuilt.current;
    if (step !== built.step || minorPatch.divisions !== built.minorDivisions || majorPatch.divisions !== built.majorDivisions) {
      lastBuilt.current = { step, minorDivisions: minorPatch.divisions, majorDivisions: majorPatch.divisions };
      resizeGrid(minorGrid, minorPatch.extent, minorPatch.divisions, minorColor);
      resizeGrid(majorGrid, majorPatch.extent, majorPatch.divisions, majorColor);
    }

    // Step-snapped: lines stay on world-step multiples (the snap grid).
    const snapX = Math.round(ortho.position.x / step) * step;
    const snapY = Math.round(ortho.position.y / step) * step;
    minorGrid.position.set(snapX, snapY, baseZ - 0.01);
    majorGrid.position.set(snapX, snapY, baseZ - 0.02);
  });

  return (
    <>
      <primitive object={minorGrid} />
      <primitive object={majorGrid} />
    </>
  );
}
