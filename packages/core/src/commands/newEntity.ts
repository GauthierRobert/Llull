import type { BaseEntity, Entity, Vec3 } from '../model/types';
import { DEFAULT_LAYER_ID } from '../model/types';

/**
 * A fresh entity on the default layer: `geometry` is the kind-specific part, the shared base
 * fields (`position`, `rotation`, `layerId`, `color`, non-empty `name`) are filled in.
 * @pure
 */
export function newEntity<K extends Entity['kind']>(
  kind: K,
  id: string,
  geometry: Omit<Extract<Entity, { kind: K }>, keyof BaseEntity>,
  position: Vec3,
  color: string,
  { rotation = [0, 0, 0], name }: { rotation?: Vec3; name?: string | undefined } = {},
): Entity {
  return {
    id,
    kind,
    ...geometry,
    position,
    rotation,
    layerId: DEFAULT_LAYER_ID,
    color,
    ...(name !== undefined && name !== '' ? { name } : {}),
  } as Entity;
}
