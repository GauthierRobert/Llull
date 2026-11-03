// The plan scene of the document (memoized on the entity bag, order, layers and components: not on selection or camera) and the ids the
// plant batch renderer owns. Active only when at least `PLANT_BATCH_MIN_INSTANCES` entities are really coverable (visible, plain solids):
// below it there is no scene and nothing is covered.

import { useMemo } from 'react';
import type { CadDocument, Entity, EntityId } from '@core/model/types';
import { type PlanScene, planScene } from '@core/geometry/renderPlan';
import { PLANT_BATCH_MIN_INSTANCES, plantCoveredIds } from './plantBatchPlan';

const NOTHING: ReadonlySet<EntityId> = new Set();

export interface PlantCoverage {
  readonly scene: PlanScene | null;
  readonly covered: ReadonlySet<EntityId>;
}

const OFF: PlantCoverage = { scene: null, covered: NOTHING };

/** `needsOwnPath` must be referentially stable between renders that do not change its answers. */
export function usePlantCoverage(document: CadDocument, needsOwnPath: (entity: Entity) => boolean): PlantCoverage {
  const { order, entities, layers, components } = document;
  const scene = useMemo(
    () => (order.length < PLANT_BATCH_MIN_INSTANCES ? null : planScene({ ...document, order, entities, layers, components })),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only these slices feed the plan; selection / camera changes must not replan
    [order, entities, layers, components],
  );
  return useMemo(() => {
    if (scene === null) return OFF;
    const covered = plantCoveredIds(scene, entities, needsOwnPath);
    return covered.size >= PLANT_BATCH_MIN_INSTANCES ? { scene, covered } : OFF;
  }, [scene, entities, needsOwnPath]);
}
