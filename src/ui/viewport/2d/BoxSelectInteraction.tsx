/**
 * @layer ui/viewport/2d
 *
 * Shift + drag in the 2D view while no draw or modify tool is armed: a rubber-band box selects
 * entities — drag left -> right = window (solid outline, fully inside), right -> left = crossing
 * (dashed outline, touching). The selection is ADDED to the current one (Shift = additive).
 * Shift is the gesture because MapControls ignore a Shift-press with rotation disabled, so the
 * drag never pans; a plain drag still pans and a plain click still selects (SelectPickInteraction
 * ignores clicks that travelled).
 *
 * Presentation only — selection is view state set through the store's `select` (R1).
 */

import { useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import type { Entity, Vec2 } from '@core/model/types';
import { useStore, useViewportStore } from '@ui/store';
import { isEntityVisible } from '../entityVisibility';
import { useDisposable } from '../useDisposable';
import { useOverlayMaterial } from '../useOverlayMaterial';
import { anchoredGeometry } from '../lineGeometry';
import { boxSelectMode, entitiesInBox } from './boxSelect';
import { pixelsToWorld } from './gridHelpers';
import { GroundPlane, toDocumentPoint } from './GroundPlane';

const BOX_COLOR = '#60a5fa';
const DASH_PX = 6;

interface BoxSelectInteractionProps {
  /** Current ortho camera zoom (px per world unit) — scales the dash length. */
  zoom: number;
}

interface RubberBandProps {
  start: Vec2;
  end: Vec2;
  zoom: number;
}

function RubberBand({ start, end, zoom }: RubberBandProps): React.ReactElement {
  const crossing = boxSelectMode(start, end) === 'crossing';
  const solid = useOverlayMaterial(BOX_COLOR, 0.9);
  const dash = pixelsToWorld(DASH_PX, zoom);
  const dashed = useDisposable(
    () =>
      new THREE.LineDashedMaterial({
        color: BOX_COLOR,
        depthTest: false,
        transparent: true,
        opacity: 0.9,
        dashSize: dash,
        gapSize: dash,
      }),
    [dash],
  );
  const anchored = useMemo(
    () =>
      anchoredGeometry(
        [
          [start[0], start[1]],
          [end[0], start[1]],
          [end[0], end[1]],
          [start[0], end[1]],
        ],
        0.2,
      ),
    [start, end],
  );
  useEffect(() => () => anchored.geometry.dispose(), [anchored]);
  return (
    <lineLoop
      geometry={anchored.geometry}
      position={anchored.anchor}
      material={crossing ? dashed : solid}
      renderOrder={999}
      onUpdate={(line: THREE.LineLoop) => line.computeLineDistances()}
    />
  );
}

export function BoxSelectInteraction({ zoom }: BoxSelectInteractionProps): React.ReactElement {
  const [drag, setDrag] = useState<{ start: Vec2; end: Vec2 } | null>(null);
  const dragging = drag !== null;

  // Esc cancels the box in progress (and only that): the release then selects nothing.
  useEffect(() => {
    if (!dragging) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setDrag(null);
    };
    // Capture phase: runs before the global shortcut handler, which skips consumed keys.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [dragging]);

  return (
    <>
      <GroundPlane
        z={0.003}
        onPointerDown={(e) => {
          if (!e.shiftKey) return;
          const point = toDocumentPoint(e.point);
          setDrag({ start: point, end: point });
        }}
        onPointerMove={(e) => {
          if (drag === null) return;
          setDrag({ start: drag.start, end: toDocumentPoint(e.point) });
        }}
        onPointerUp={(e) => {
          if (drag === null) return;
          const end = toDocumentPoint(e.point);
          setDrag(null);
          if (Math.hypot(end[0] - drag.start[0], end[1] - drag.start[1]) * zoom < 4) return;
          const state = useStore.getState();
          const { hiddenLayerIds, hiddenEntityIds } = useViewportStore.getState();
          const { layers } = state.document;
          const ids = entitiesInBox(state.document, drag.start, end, (entity: Entity) =>
            isEntityVisible(entity, layers, hiddenLayerIds, hiddenEntityIds),
          );
          state.select([...new Set([...state.document.selection, ...ids])]);
        }}
      />
      {drag !== null && <RubberBand start={drag.start} end={drag.end} zoom={zoom} />}
    </>
  );
}
