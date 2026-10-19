// Colours the members of the last structural check on the model by utilisation (green < 0.7, amber < 1, red ≥ 1): in 3D the members'
// own solids take the colour (tintStore — exact for diagonals); the 2D plan draws a translucent hull per member. "UR 1.12" pills on the
// worst ones. Inside the floating-origin group; toggled in Building › Structural check.

import React, { useEffect, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { boundsCenter, entityBoundsInDoc, type Bounds } from '@core/geometry/bounds';
import type { Vec3 } from '@core/model/types';
import { useDocumentWithoutSelection } from '@ui/store/useDocumentWithoutSelection';
import { useGhostStore } from '@ui/store/ghostStore';
import { useTintStore } from '@ui/store/tintStore';
import { useStructuralOverlayStore, type UtilisationMark } from '@ui/store/structuralOverlayStore';
import { utilisationColor } from '@ui/panels/building/utilisationColor';
import { CLADDING_LAYER_NAME } from '@ui/panels/building/claddingLayer';
import { useDisposable } from '../../useDisposable';
import { ProjectedLabel } from '../ProjectedLabel';

const RENDER_ORDER = 997;
/** Worst members that get a value pill (the rest are read from the colour). */
const LABELLED = 5;

function MemberHull({ bounds, color }: { bounds: Bounds; color: string }): React.ReactElement {
  const sx = bounds.max[0] - bounds.min[0];
  const sy = bounds.max[1] - bounds.min[1];
  const sz = bounds.max[2] - bounds.min[2];
  const fill = useDisposable(
    () => new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.32, depthTest: false, depthWrite: false }),
    [color],
  );
  const edge = useDisposable(() => new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95, depthTest: false }), [color]);
  const box = useMemo(() => new THREE.BoxGeometry(sx, sy, sz), [sx, sy, sz]);
  const edges = useMemo(() => new THREE.EdgesGeometry(box), [box]);
  useEffect(
    () => () => {
      box.dispose();
      edges.dispose();
    },
    [box, edges],
  );
  const centre = boundsCenter(bounds);
  return (
    <group position={centre}>
      <mesh geometry={box} material={fill} renderOrder={RENDER_ORDER} />
      <lineSegments geometry={edges} material={edge} renderOrder={RENDER_ORDER + 1} />
    </group>
  );
}

/** `hulls`: draw a box per member (the 2D plan, whose members are not solids); 3D tints the member solids instead. */
export function StructuralOverlay({ hulls = false }: { hulls?: boolean }): React.ReactElement | null {
  const document = useDocumentWithoutSelection();
  const shown = useStructuralOverlayStore((s) => s.shown);
  const marks = useStructuralOverlayStore((s) => s.marks);
  const invalidate = useThree((state) => state.invalidate);
  useEffect(() => invalidate(), [shown, marks, document, invalidate]);
  // See through the envelope (cladding, slabs, everything not checked) so the coloured members read at a glance.
  const { building, layers, entities } = document;
  useEffect(() => {
    const { setGhosted } = useGhostStore.getState();
    if (!shown || marks.length === 0 || building === undefined) {
      setGhosted('structural', new Set());
      return;
    }
    const checked = new Set(marks.flatMap((mark) => mark.entityIds));
    const others = Object.values(building.elements).flatMap((element) => element.entityIds.filter((id) => !checked.has(id)));
    // The generated envelope sits on its own layer, outside the element lists.
    const claddingLayerIds = new Set(Object.values(layers).flatMap((layer) => (layer.name === CLADDING_LAYER_NAME ? [layer.id] : [])));
    const cladding = Object.values(entities).flatMap((entity) => (claddingLayerIds.has(entity.layerId) ? [entity.id] : []));
    setGhosted('structural', new Set([...others, ...cladding]));
    return () => setGhosted('structural', new Set());
  }, [shown, marks, building, layers, entities]);
  useEffect(() => {
    const { setTints } = useTintStore.getState();
    if (hulls || !shown) {
      setTints(new Map());
      return;
    }
    setTints(
      new Map(marks.flatMap((mark) => mark.entityIds.map((id) => [id, utilisationColor(mark.utilisation, !mark.failing)] as const))),
    );
    return () => setTints(new Map());
  }, [hulls, shown, marks]);

  const drawn = useMemo(
    () =>
      marks.map((mark) => {
        const boxes = mark.entityIds.flatMap((id) => {
          const entity = document.entities[id];
          return entity === undefined ? [] : [entityBoundsInDoc(document, entity)];
        });
        return { mark, boxes, color: utilisationColor(mark.utilisation, !mark.failing) };
      }),
    [marks, document],
  );
  const worst = useMemo(
    () =>
      new Set(
        [...marks]
          .sort((a, b) => b.utilisation - a.utilisation)
          .slice(0, LABELLED)
          .map((m) => m.key),
      ),
    [marks],
  );

  if (!shown || marks.length === 0) return null;
  const labelPosition = (boxes: readonly Bounds[]): Vec3 | null => {
    const top = boxes.reduce<Vec3 | null>((best, box) => {
      const centre = boundsCenter(box);
      const candidate: Vec3 = [centre[0], centre[1], box.max[2]];
      return best === null || candidate[2] > best[2] ? candidate : best;
    }, null);
    return top;
  };
  return (
    <group name="structural-utilisation">
      {drawn.map(({ mark, boxes, color }: { mark: UtilisationMark; boxes: Bounds[]; color: string }) => {
        const position = worst.has(mark.key) ? labelPosition(boxes) : null;
        return (
          <React.Fragment key={mark.key}>
            {hulls && boxes.map((bounds, index) => <MemberHull key={index} bounds={bounds} color={color} />)}
            {position !== null && (
              <ProjectedLabel
                position={position}
                text={`UR ${mark.utilisation.toFixed(2)}`}
                className="load-label"
                borderColor={color}
                opacity={1}
                testId={`ur-label-${mark.key}`}
              />
            )}
          </React.Fragment>
        );
      })}
    </group>
  );
}
