import { type Bounds, entityBounds, entityBoundsInDoc } from '@core/geometry/bounds';
import { assignedMaterialClass, materialClassPlanKey } from '@core/geometry/materialClasses';
import { entityToTriangles } from '@core/geometry/entityTriangles';
import { type PlanInstance, type PlanScene, prototypeKeyOf } from '@core/geometry/renderPlan';
import { applyEulerXYZ, isZeroRotation } from '@lib/eulerRotation';
import { type CadDocument, type Entity, is3D } from '@core/model/types';

const diagonalOf = ({ min, max }: Bounds): number => Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);

/** The closed-form rotated cylinder / cone / sphere / torus box exactly as `bounds.ts` wrote it before VIS-M8i (no memo, no inlining). */
function referenceAnalyticBounds(e: Entity): Bounds | undefined {
  if (e.kind !== 'cylinder' && e.kind !== 'cone' && e.kind !== 'sphere' && e.kind !== 'torus') return undefined;
  const axis = applyEulerXYZ([0, 0, 1], [0, 0, 0], e.rotation);
  const extent = (i: 0 | 1 | 2): [number, number] => {
    const n = axis[i];
    const spread = Math.sqrt(Math.max(0, 1 - n * n));
    switch (e.kind) {
      case 'cylinder': {
        const half = (e.height / 2) * Math.abs(n) + e.radius * spread;
        return [-half, half];
      }
      case 'cone': {
        const rim = e.radius * spread;
        return [Math.min(-rim, e.height * n), Math.max(rim, e.height * n)];
      }
      case 'sphere':
        return [-e.radius, e.radius];
      default: {
        const half = e.ringRadius * spread + e.tubeRadius;
        return [-half, half];
      }
    }
  };
  const [x, y, z] = [extent(0), extent(1), extent(2)];
  const p = e.position;
  return { min: [p[0] + x[0], p[1] + y[0], p[2] + z[0]], max: [p[0] + x[1], p[1] + y[1], p[2] + z[1]], oriented: true };
}

const referenceBounds = (doc: CadDocument, entity: Entity): Bounds =>
  entity.kind === 'instance' || isZeroRotation(entity.rotation)
    ? entityBoundsInDoc(doc, entity)
    : (referenceAnalyticBounds(entity) ?? entityBoundsInDoc(doc, entity));

/** `planScene` as it was before VIS-M8i: one reference `prototypeKeyOf` per entity, two box computations, no memo. The oracle of the equivalence test. */
export function referencePlanScene(doc: CadDocument): PlanScene {
  const prototypeIndex = new Map<string, number>();
  const classIndex = new Map<string, number>();
  const prototypeTriangles: number[] = [];
  const prototypeCounts: number[] = [];
  const instances: PlanInstance[] = [];
  let hiddenCount = 0;
  for (const id of doc.order) {
    const entity = Object.hasOwn(doc.entities, id) ? doc.entities[id] : undefined;
    if (entity === undefined || !is3D(entity)) continue;
    if (doc.layers[entity.layerId]?.visible === false) {
      hiddenCount++;
      continue;
    }
    const key = prototypeKeyOf(entity);
    let prototype = prototypeIndex.get(key);
    if (prototype === undefined) {
      prototype = prototypeIndex.size;
      prototypeIndex.set(key, prototype);
      prototypeTriangles.push(entityToTriangles(entity, doc).length);
      prototypeCounts.push(0);
    }
    prototypeCounts[prototype] = (prototypeCounts[prototype] ?? 0) + 1;
    const assigned = assignedMaterialClass(doc, entity.id);
    const className = assigned === undefined ? (entity.materialId ?? 'unassigned') : materialClassPlanKey(assigned.id);
    let materialClass = classIndex.get(className);
    if (materialClass === undefined) {
      materialClass = classIndex.size;
      classIndex.set(className, materialClass);
    }
    const aabb = referenceBounds(doc, entity);
    const diagonal = entity.kind === 'instance' ? diagonalOf(aabb) : diagonalOf(entityBounds(entity));
    instances.push({ id, prototype, materialClass, aabb, diagonal });
  }
  return {
    instances,
    prototypeKeys: [...prototypeIndex.keys()],
    materialClasses: [...classIndex.keys()],
    prototypeTriangles,
    prototypeCounts,
    hiddenCount,
  };
}
