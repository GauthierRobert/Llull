import { useMemo } from 'react';
import type { BuildingLevel } from '@aec/index';
import { useStore } from '@ui/store';
import { orderedValues } from '@ui/panels/orderedValues';

const NO_LEVELS: ReadonlyArray<BuildingLevel> = [];

export function useBuildingLevels(): ReadonlyArray<BuildingLevel> {
  const building = useStore((s) => s.document.building);
  return useMemo(() => (building ? orderedValues(building.levelOrder, building.levels) : NO_LEVELS), [building]);
}
