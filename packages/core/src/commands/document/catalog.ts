/** Document settings: units, layers, materials (and their property models), camera, clear. */

import { commandCatalog } from '../schema';
import { setUnits } from './units';
import { addLayer, updateLayer, setEntityLayer, deleteLayer } from './layers';
import { createMaterial, assignMaterial } from './materials';
import { clearDocument } from './clearDocument';
import { setCamera, fitView } from './camera';
import { definePropertyModel, removePropertyModel } from './propertyModels';
import { evaluateProperty, sampleProperty } from './propertyQueries';
import { fitPropertyModel } from './fitPropertyModel';
import { checkPropertyModels } from './checkPropertyModels';

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
  definePropertyModel,
  removePropertyModel,
  evaluateProperty,
  sampleProperty,
  fitPropertyModel,
  checkPropertyModels,
);
