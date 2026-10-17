/** Aerospace material records, libraries, allowables and the export gate (08 MAT M2 / M3 / M8). */

import { commandCatalog } from '../schema';
import { checkMaterials } from './checkMaterials';
import { convertQuantity } from './convertQuantity';
import { defineMaterialRecord } from './defineMaterialRecord';
import { diffMaterialLibraries } from './diffMaterialLibraries';
import { getMaterial } from './getMaterial';
import { getMaterialAllowable } from './getMaterialAllowable';
import { importMaterialLibrary, removeMaterialLibrary } from './importMaterialLibrary';
import { resolveMaterialLibraries } from './resolveMaterialLibraries';
import { setExportMarking } from './setExportMarking';
import { setMaterialProperty } from './setMaterialProperty';

export const materialCommands = commandCatalog(
  defineMaterialRecord,
  setMaterialProperty,
  getMaterial,
  getMaterialAllowable,
  convertQuantity,
  importMaterialLibrary,
  removeMaterialLibrary,
  diffMaterialLibraries,
  resolveMaterialLibraries,
  setExportMarking,
  checkMaterials,
);
