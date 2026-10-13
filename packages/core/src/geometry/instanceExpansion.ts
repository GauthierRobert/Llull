/**
 * Instance expansion: bake an `InstanceEntity` into world-space copies of its component's entities
 * (scale -> rotate about origin -> translate; keep in sync with `scene.ts` `instanceBoundsFromDoc`).
 */

import { type CadDocument, type Component, type Entity, type InstanceEntity, type Vec3, is3D } from '../model/types';
import { solidTriangles } from './solidTriangles';
import { isZeroRotation } from '../lib/eulerRotation';
import { add3 } from '../lib/vec3';
import { instanceToWorld } from './instanceTransform';
import { scaleGeometry } from './scaleGeometry';
import { soupIndices } from './meshVolume';

export const UNIT_SCALE: Vec3 = [1, 1, 1];

/**
 * The instance transform cannot stay parametric on `child` and is baked into a mesh: a negative or
 * zero scale component, or a non-uniform scale on anything but an unrotated box/wedge.
 * 2D shapes and nested instances never bake (they keep the `scaledChild` path).
 */
function needsMeshBake(child: Entity, scale: Vec3): boolean {
  if (!is3D(child) || child.kind === 'instance') return false;
  const [sx, sy, sz] = scale;
  if (sx <= 0 || sy <= 0 || sz <= 0) return true;
  if (sx === sy && sy === sz) return false;
  return !((child.kind === 'box' || child.kind === 'wedge') && isZeroRotation(child.rotation));
}

/**
 * `child` (a 3D solid in component space) as a world-space `mesh`: its triangles mapped through the
 * full instance affine (scale -> rotate about origin -> translate). A mirroring scale (negative
 * determinant) reverses the winding so normals stay outward and the volume positive.
 * @invariant result.position = result.rotation = [0, 0, 0] (mesh positions are world-space)
 */
function bakedMeshChild(child: Entity, instance: InstanceEntity, scale: Vec3, id: string): Entity {
  const { rotation, position } = instance;
  const mirrored = scale[0] * scale[1] * scale[2] < 0;
  const toWorld = instanceToWorld(scale, rotation, position);
  const positions: number[] = [];
  for (const [a, b, c] of solidTriangles(child)) {
    for (const corner of mirrored ? [a, c, b] : [a, b, c]) positions.push(...toWorld(corner));
  }
  return {
    id,
    kind: 'mesh',
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    layerId: child.layerId,
    color: child.color,
    ...(child.name !== undefined ? { name: child.name } : {}),
    ...(child.tags !== undefined ? { tags: child.tags } : {}),
    ...(child.materialId !== undefined ? { materialId: child.materialId } : {}),
    mesh: { positions, indices: soupIndices(positions) },
  };
}

/**
 * `entity` resized parametrically by the instance's `scale`: exact for a uniform positive scale and
 * for a per-axis scale on an unrotated box/wedge (everything else 3D is baked by `bakedMeshChild`).
 * 2D shapes and nested instances under a non-uniform scale use the geometric mean (approximation).
 */
function scaledChild(entity: Entity, scale: Vec3): Entity {
  const [ax, ay, az] = [Math.abs(scale[0]), Math.abs(scale[1]), Math.abs(scale[2])];
  if (ax === 1 && ay === 1 && az === 1) return entity;
  if ((entity.kind === 'box' || entity.kind === 'wedge') && ax > 0 && ay > 0 && az > 0)
    return { ...entity, size: [entity.size[0] * ax, entity.size[1] * ay, entity.size[2] * az] };
  const factor = ax === ay && ay === az ? ax : Math.cbrt(ax * ay * az);
  return factor > 0 ? scaleGeometry(entity, factor).scaled : entity;
}

function expandedId(instanceId: string, sourceEntityId: string): string {
  return `expanded::${instanceId}::${sourceEntityId}`;
}

/**
 * Bake an instance into world-space copies of the component's entities (ids `expanded::<instance>::<source>`).
 * Child rotations add the instance's Euler angles (additive, as elsewhere in the command layer).
 * A 3D child the scale cannot resize exactly (`needsMeshBake`) becomes a world-space `mesh`.
 * @invariant rotation semantics differ by path (N-F, tracked): the parametric path ADDS the
 *   instance's Euler angles to the child's (`child.rotation + instance.rotation`), while the
 *   baked-mesh path COMPOSES them (child rotation applied by `solidTriangles`, then the instance
 *   rotation). They agree only when one of the two rotations is zero or both share one axis.
 */
export function expandInstance(instance: InstanceEntity, component: Component): Entity[] {
  const [sx, sy, sz] = instance.scale ?? UNIT_SCALE;
  const rot = instance.rotation;
  const pos = instance.position;
  const toWorld = instanceToWorld([sx, sy, sz], rot, pos);

  return component.order
    .map((cid) => component.entities[cid])
    .filter((e): e is Entity => e !== undefined)
    .map((childEntity): Entity => {
      if (needsMeshBake(childEntity, [sx, sy, sz])) {
        return bakedMeshChild(childEntity, instance, [sx, sy, sz], expandedId(instance.id, childEntity.id));
      }
      return {
        ...scaledChild(childEntity, [sx, sy, sz]),
        id: expandedId(instance.id, childEntity.id),
        position: toWorld(childEntity.position),
        rotation: add3(childEntity.rotation, rot),
      } as Entity;
    });
}

/**
 * What an entity's expanded geometry depends on beyond the entity object itself: an instance's
 * whole component map (nested instances reach any component), nothing for other entities. Caches
 * keyed by the (immutable) entity compare it to stay correct.
 */
export function expansionDependency(entity: Entity, doc: Pick<CadDocument, 'components'>): CadDocument['components'] | undefined {
  return entity.kind === 'instance' ? doc.components : undefined;
}
