/** Document settings: units, layers, materials, camera, clear. */

import { commandCatalog } from '../schema';
import { setUnits } from './units';
import {
  addLayer,
  renameLayer,
  setLayerVisibility,
  setLayerLock,
  setEntityLayer,
  deleteLayer,
} from './layers';
import { createMaterial, assignMaterial } from './materials';
import { clearDocument } from './clearDocument';
import { setCamera, lookAt, fitView } from './camera';

export const documentCommands = commandCatalog(
  setUnits,
  addLayer,
  renameLayer,
  setLayerVisibility,
  setLayerLock,
  setEntityLayer,
  deleteLayer,
  createMaterial,
  assignMaterial,
  clearDocument,
  setCamera,
  lookAt,
  fitView,
);
