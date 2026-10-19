// Row click of the Analysis panel: highlight the item on the model (its parts selected, a beacon with the value at each point it sits on).

import { useCallback } from 'react';
import { useFocusItem } from '@ui/hooks/useFocusItem';
import type { SetupItem } from './analysisItems';

export function useFocusSetupItem(): (item: SetupItem) => void {
  const focusItem = useFocusItem();
  return useCallback(
    (item: SetupItem) =>
      focusItem({
        key: item.key,
        label: item.group === 'part' ? item.name : `${item.name}: ${item.label}`,
        color: item.color,
        entityIds: item.entityIds,
        markers: item.group === 'part' ? [] : item.points.map((position) => ({ position, label: item.label })),
      }),
    [focusItem],
  );
}
