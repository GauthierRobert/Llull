// Floats the lens card above the sole selected entity: name, kind, a Properties toggle, and its creating step's
// dimensions edited via edit_step_params (the entity stays selected after the replay).

import React, { useState } from 'react';
import { rotatedEntityBounds } from '@core/geometry/rotatedBounds';
import { useLayoutStore, useStore, useToolStore } from '@ui/store';
import { useSoleSelectedEntity } from '@ui/store/selectionHooks';
import { useDispatchThen } from '@ui/hooks/useDispatchThen';
import { type LensDimension, lensTarget, withDimension } from './lensDimensions';
import { LensPills } from './LensPills';
import { ScreenAnchor } from '../screenAnchor/ScreenAnchor';

export function DimensionLens(): React.ReactElement | null {
  const entity = useSoleSelectedEntity();
  const history = useStore((s) => s.document.featureHistory);
  const units = useStore((s) => s.document.units);
  const drawTool = useToolStore((s) => s.drawTool);
  const select = useStore((s) => s.select);
  const inspectorOpen = useLayoutStore((s) => s.inspectorOpen);
  const toggleInspector = useLayoutStore((s) => s.toggleInspector);
  const dispatchThen = useDispatchThen();
  const [refusal, setRefusal] = useState<{ entityId: string; summary: string } | null>(null);

  if (entity === undefined || drawTool !== 'none') return null;
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
    <ScreenAnchor id="dimension-lens" position={anchor} zIndex={24} className="lens-anchor">
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
    </ScreenAnchor>
  );
}
