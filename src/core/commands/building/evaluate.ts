/**
 * Evaluates the constructive building model into ordinary document entities (architecture L8).
 *
 * @layer core/commands/building
 * @pure
 * @invariant evaluated entity ids are deterministic: `<elementId>:<part>`
 * @invariant no new entity kinds — walls/slabs/… become box / cylinder / extrusion / 2D shapes
 */

export {
  wallFrame,
  pointAlong,
  openingsOf,
  endAdjustment,
  wallExtent,
  wallPieces,
} from './wallGeometry';
export type { WallFrame, WallExtent } from './wallGeometry';
export { slabMesh, regenerateBuilding } from './evaluateElements';
export { CATEGORY_LAYER, colorForMaterial, layerIdFor } from './entities';
