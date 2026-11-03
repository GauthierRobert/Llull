// The plan scene of the document (memoized on the entity bag, order, layers and components: not on selection or camera) and the ids the
// plant batch renderer owns. Below `PLANT_BATCH_MIN_INSTANCES` visible 3D entities there is no scene and nothing is covered.

import { useMemo } from 'react';
import type { CadDocument, Entity, EntityId } from '@core/model/types';
import { type PlanScene, planScene } from '@core/geometry/renderPlan';
import { PLANT_BATCH_MIN_INSTANCES, plantCoveredIds } from './plantBatchPlan';

const NOTHING: ReadonlySet<EntityId> = new Set();

export interface PlantCoverage {
  readonly scene: PlanScene | null;
  readonly covered: ReadonlySet<EntityId>;
}

/** `needsOwnPath` must be referentially stable between renders that do not change its answers. */
export function usePlantCoverage(document: CadDocument, needsOwnPath: (entity: Entity) => boolean): PlantCoverage {
  const { order, entities, layers, components } = document;
  const scene = useMemo(() => {
    if (order.length < PLANT_BATCH_MIN_INSTANCES) return null;
    const planned = planScene({ ...document, order, entities, layers, components });
    return planned.instances.length >= PLANT_BATCH_MIN_INSTANCES ? planned : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only these slices feed the plan; selection / camera changes must not replan
  }, [order, entities, layers, components]);
  const covered = useMemo(
    () => (scene === null ? NOTHING : plantCoveredIds(scene, entities, needsOwnPath)),
    [scene, entities, needsOwnPath],
  );
  return { scene, covered };
}
