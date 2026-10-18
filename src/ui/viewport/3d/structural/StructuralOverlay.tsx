// Colours the members of the last structural check on the model by utilisation (green < 0.7, amber < 1, red ≥ 1): a translucent
// hull and outline over each member, "UR 1.12" pills on the worst ones. Inside the floating-origin group; toggled in Building › Structural check.

import React, { useEffect, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { boundsCenter, entityBoundsInDoc, type Bounds } from '@core/geometry/bounds';
import type { Vec3 } from '@core/model/types';
import { useDocumentWithoutSelection } from '@ui/store/useDocumentWithoutSelection';
import { useStructuralOverlayStore, type UtilisationMark } from '@ui/store/structuralOverlayStore';
import { utilisationColor } from '@ui/panels/building/utilisationColor';
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

export function StructuralOverlay(): React.ReactElement | null {
  const document = useDocumentWithoutSelection();
  const { shown, marks } = useStructuralOverlayStore();
  const invalidate = useThree((state) => state.invalidate);
  useEffect(() => invalidate(), [shown, marks, document, invalidate]);

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
            {boxes.map((bounds, index) => (
              <MemberHull key={index} bounds={bounds} color={color} />
            ))}
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
