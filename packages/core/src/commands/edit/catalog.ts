/** Move, delete, transform, duplicate, group and lay out entities. */

import { commandCatalog } from '../schema';
import { move, deleteEntity } from './moveDelete';
import { rotateEntity, scaleEntity, mirrorEntity, arrayLinear, arrayPolar } from './transform';
import { duplicateEntity, groupEntities, ungroupEntities, setEntityName } from './basic';
import { align, distribute, stackOn } from './place';
import { arrayAlongPath, distributeOnArc } from './arrayAlongPath';
import { patternAlongPath } from './patternAlongPath';
import { distributeAlongPath } from './distribute';
import { deleteEntities, moveEntities, duplicateEntities } from './batch';

export const editCommands = commandCatalog(
  move,
  deleteEntity,
  rotateEntity,
  scaleEntity,
  mirrorEntity,
  arrayLinear,
  arrayPolar,
  duplicateEntity,
  groupEntities,
  ungroupEntities,
  setEntityName,
  align,
  distribute,
  stackOn,
  arrayAlongPath,
  patternAlongPath,
  distributeOnArc,
  distributeAlongPath,
  deleteEntities,
  moveEntities,
  duplicateEntities,
);
