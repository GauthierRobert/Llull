// Floats the lens card above the sole selected entity: name, kind, a Properties toggle, and its creating step's
// dimensions edited via edit_step_params (the entity stays selected after the replay).

import React, { useCallback, useState } from 'react';
import { rotatedEntityBounds } from '@core/geometry/rotatedBounds';
import { useLayoutStore, useStore, useToolStore } from '@ui/store';
import { useSoleSelectedEntity } from '@ui/store/selectionHooks';
import { useStepDimensionEdit } from '@ui/hooks/useStepDimensionEdit';
import { type LensDimension, lensTarget } from './lensDimensions';
import { LensPills } from './LensPills';
import { ScreenAnchor } from '../screenAnchor/ScreenAnchor';

export function DimensionLens(): React.ReactElement | null {
  const entity = useSoleSelectedEntity();
  const history = useStore((s) => s.document.featureHistory);
  const units = useStore((s) => s.document.units);
  const drawTool = useToolStore((s) => s.drawTool);
  const inspectorOpen = useLayoutStore((s) => s.inspectorOpen);
  const toggleInspector = useLayoutStore((s) => s.toggleInspector);
  const [refusal, setRefusal] = useState<{ entityId: string; summary: string } | null>(null);
  const entityId = entity?.id ?? '';
  const onRefused = useCallback((summary: string) => setRefusal({ entityId, summary }), [entityId]);
  const editDimension = useStepDimensionEdit(entityId, onRefused);

  if (entity === undefined || drawTool !== 'none') return null;
  const target = lensTarget(history, entity.id);

  const bounds = rotatedEntityBounds(entity);
  const anchor: [number, number, number] = [(bounds.min[0] + bounds.max[0]) / 2, (bounds.min[1] + bounds.max[1]) / 2, bounds.max[2]];
  const commit = (dimension: LensDimension, value: number): void => {
    if (target === null) return;
    setRefusal(null);
    editDimension(target, dimension, value);
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
