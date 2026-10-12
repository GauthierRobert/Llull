/** Document settings: units, layers, materials, camera, clear. */

import { commandCatalog } from '../schema';
import { setUnits } from './units';
import { addLayer, updateLayer, setEntityLayer, deleteLayer } from './layers';
import { createMaterial, assignMaterial } from './materials';
import { clearDocument } from './clearDocument';
import { setCamera, fitView } from './camera';

export const documentCommands = commandCatalog(
  setUnits,
  addLayer,
  updateLayer,
  setEntityLayer,
  deleteLayer,
  createMaterial,
  assignMaterial,
  clearDocument,
  setCamera,
  fitView,
);
