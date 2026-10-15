/**
 * Shift + drag (no tool armed): rubber-band box ADDED to the selection — left→right window (solid, fully inside),
 * right→left crossing (dashed, touching). Shift because MapControls ignore it with rotation off, so it never pans;
 * a plain drag pans and a plain click selects (SelectPickInteraction ignores travelled clicks).
 */

import { useCallback, useState } from 'react';
import * as THREE from 'three';
import type { Entity, Vec2 } from '@core/model/types';
import { useStore, useViewportStore } from '@ui/store';
import { isEntityOnLockedLayer, isEntityVisible } from '../entityVisibility';
import { useAnchoredGeometry, useDisposable } from '../useDisposable';
import { useOverlayMaterial } from '../useOverlayMaterial';
import { OVERLAY_ACCENT } from '../viewportPalette';
import { boxSelectMode, entitiesInBox } from './boxSelect';
import { pixelsToWorld } from './gridHelpers';
import { GroundPlane, toDocumentPoint } from './GroundPlane';
import { useCaptureKeydown } from '@ui/hooks/useCaptureKeydown';

const DASH_PX = 6;

interface BoxSelectInteractionProps {
  /** Px per world unit; scales the dash. */
  zoom: number;
}

function RubberBand({ start, end, zoom }: { start: Vec2; end: Vec2; zoom: number }): React.ReactElement {
  const crossing = boxSelectMode(start, end) === 'crossing';
  const solid = useOverlayMaterial(OVERLAY_ACCENT, 0.9);
  const dash = pixelsToWorld(DASH_PX, zoom);
  const dashed = useDisposable(
    () =>
      new THREE.LineDashedMaterial({
        color: OVERLAY_ACCENT,
        depthTest: false,
        transparent: true,
        opacity: 0.9,
        dashSize: dash,
        gapSize: dash,
      }),
    [dash],
  );
  const anchored = useAnchoredGeometry(
    () => [
      [start[0], start[1]],
      [end[0], start[1]],
      [end[0], end[1]],
      [start[0], end[1]],
    ],
    0.2,
    [start, end],
  );
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

  // Esc cancels only the box in progress: the release then selects nothing.
  const cancelOnEscape = useCallback((e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    setDrag(null);
  }, []);
  useCaptureKeydown(dragging ? cancelOnEscape : null);

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
          const ids = entitiesInBox(
            state.document,
            drag.start,
            end,
            (entity: Entity) => isEntityVisible(entity, layers, hiddenLayerIds, hiddenEntityIds) && !isEntityOnLockedLayer(entity, layers),
          );
          state.select([...new Set([...state.document.selection, ...ids])]);
        }}
      />
      {drag !== null && <RubberBand start={drag.start} end={drag.end} zoom={zoom} />}
    </>
  );
}
