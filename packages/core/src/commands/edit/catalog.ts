/** Batch move/delete/duplicate, transform, group and lay out entities. */

import { commandCatalog } from '../schema';
import { rotateEntity, scaleEntity, mirrorEntity, arrayLinear, arrayPolar } from './transform';
import { groupEntities, ungroupEntities, setEntityName } from './basic';
import { align, distribute, stackOn } from './place';
import { patternAlongPath } from './patternAlongPath';
import { addDecal, removeDecal } from './decals';
import { deleteEntities, moveEntities, duplicateEntities } from './batch';
import { setEntityColor, setFaceColor } from './colors';

export const editCommands = commandCatalog(
  rotateEntity,
  scaleEntity,
  mirrorEntity,
  arrayLinear,
  arrayPolar,
  groupEntities,
  ungroupEntities,
  setEntityName,
  align,
  distribute,
  stackOn,
  patternAlongPath,
  addDecal,
  removeDecal,
  deleteEntities,
  moveEntities,
  duplicateEntities,
  setEntityColor,
  setFaceColor,
);
