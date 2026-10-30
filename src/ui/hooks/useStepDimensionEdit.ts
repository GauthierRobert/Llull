// Commit one dimension of an entity's creating step through edit_step_params (the parametric path), then re-select the entity:
// replay clears the selection, and step-scoped ids let the same entity be selected again to keep editing.

import { useCallback } from 'react';
import { useStore } from '@ui/store';
import { useDispatchThen } from '@ui/hooks/useDispatchThen';
import { type LensDimension, type LensTarget, withDimension } from '@ui/viewport/3d/lensDimensions';

export function useStepDimensionEdit(
  entityId: string,
  onRefused: (summary: string) => void,
): (target: LensTarget, dimension: LensDimension, value: number) => void {
  const dispatchThen = useDispatchThen();
  const select = useStore((s) => s.select);
  return useCallback(
    (target, dimension, value) =>
      dispatchThen(
        'edit_step_params',
        { stepId: target.stepId, params: withDimension(target, dimension, value) },
        () => {
          if (entityId in useStore.getState().document.entities) select([entityId]);
        },
        onRefused,
      ),
    [dispatchThen, entityId, onRefused, select],
  );
}
