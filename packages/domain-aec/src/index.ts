/**
 * Public API of the AEC domain package: the plugins the composition root installs (`src/app/plugins.ts`) and the helpers the UI renders
 * with.
 */

// building: plugin, plan drawing, element model/helpers and cost types the UI renders
export { buildingPlugin } from './building/plugin';
export { buildPlanDrawing } from './building/drawings/planDrawing';
export { CATEGORY_LAYER } from './building/evaluate/entities';
export { buildingElementOf } from './building/evaluate/integrity';
export { fileSlug } from './building/model';
export {
  type BuildingModel,
  type BuildingElement,
  type EquipmentElement,
  type BuildingLevel,
  type GridElement,
  type SteelMemberElement,
  createEmptyBuilding,
  type ProjectInfo,
  type WallElement,
} from './building/types';
export { COPYABLE } from './building/elements/elements';

// building cost lines the quantities panel renders
export type { CostLine } from './building/quantities/costing';

// industrial: plugin, clash, evaluation, grid framing and pipe sizes for the UI panels
export { industrialPlugin } from './industrial/plugin';
export { type Clash } from './industrial/clash/clash';
export { boltSize } from './industrial/evaluate';
export { crossGridLines } from './industrial/framing/gridFraming';
export { PIPE_OUTSIDE_DIAMETER_MM } from './industrial/piping/pipeSizes';

// civil: plugin and the civil model types the UI panels read
export { civilPlugin } from './civil/plugin';
export {
  type AlignmentObject,
  type CivilModel,
  type CivilObject,
  type CivilCategory,
  type PlatformObject,
  CIVIL_CATEGORIES,
  type SurfaceObject,
} from './civil/types';

// plant: piping plugin
export { pipingPlugin } from './plant/piping/plugin';
export { pipingFabricationPlugin } from './plant/fabrication/plugin';
export { pipingCatalogPlugin } from './plant/catalog/plugin';
export { structuresPlugin } from './plant/structures/plugin';
export { plantEquipmentPlugin } from './plant/equipment/plugin';
export { plantDataPlugin } from './plant/data/plugin';

// plant: display plugin (service colour schemes, entity properties; plant 09 VIS)
export { plantDisplayPlugin } from './plant/display/plugin';

// scan: point-cloud plugin
export { scanPlugin } from './scan/plugin';

// steel: section profile catalogue for member editors
export { findProfile, STEEL_PROFILES } from './steel/profiles';
