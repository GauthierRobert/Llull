// Floats the lens card above the sole selected entity: name, kind, a Properties toggle, and its creating step's
// dimensions edited via edit_step_params (the entity stays selected after the replay).

import React, { useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import { rotatedEntityBounds } from '@core/geometry/rotatedBounds';
import { useLayoutStore, useStore, useToolStore } from '@ui/store';
import { useSoleSelectedEntity } from '@ui/store/selectionHooks';
import { useDispatchThen } from '@ui/hooks/useDispatchThen';
import { type LensDimension, lensTarget, withDimension } from './lensDimensions';
import { LensPills } from './LensPills';

export function DimensionLens(): React.ReactElement | null {
  const entity = useSoleSelectedEntity();
  const history = useStore((s) => s.document.featureHistory);
  const units = useStore((s) => s.document.units);
  const drawTool = useToolStore((s) => s.drawTool);
  const select = useStore((s) => s.select);
  const inspectorOpen = useLayoutStore((s) => s.inspectorOpen);
  const toggleInspector = useLayoutStore((s) => s.toggleInspector);
  const dispatchThen = useDispatchThen();
  // drei's Html attaches to the canvas parent when it mounts: a lens mounting together with the canvas (a view switch
  // with a selection) would stay detached, so it waits for the first rendered frame.
  const [sceneReady, setSceneReady] = useState(false);
  useFrame(() => {
    if (!sceneReady) setSceneReady(true);
  });
  const [refusal, setRefusal] = useState<{ entityId: string; summary: string } | null>(null);

  if (!sceneReady || entity === undefined || drawTool !== 'none') return null;
  const target = lensTarget(history, entity.id);

  const bounds = rotatedEntityBounds(entity);
  const anchor: [number, number, number] = [(bounds.min[0] + bounds.max[0]) / 2, (bounds.min[1] + bounds.max[1]) / 2, bounds.max[2]];
  const commit = (dimension: LensDimension, value: number): void => {
    if (target === null) return;
    setRefusal(null);
    dispatchThen(
      'edit_step_params',
      { stepId: target.stepId, params: withDimension(target, dimension, value) },
      // Replay clears the selection; ids are step-scoped, so the same entity can be re-selected to keep editing.
      () => {
        if (entity.id in useStore.getState().document.entities) select([entity.id]);
      },
      (summary) => setRefusal({ entityId: entity.id, summary }),
    );
  };

  return (
    <Html position={anchor} zIndexRange={[24, 12]} className="lens-anchor">
      <LensPills
        name={entity.name ?? entity.id}
        kind={entity.kind}
        unit={units}
        dimensions={target?.dimensions ?? []}
        propertiesOpen={inspectorOpen}
        onToggleProperties={toggleInspector}
        refusal={refusal?.entityId === entity.id ? refusal.summary : null}
        onCommit={commit}
      />
    </Html>
  );
}
