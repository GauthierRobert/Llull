/** Subdivision-surface cages and their direct editing (04 DIR, toolsets 3d and freeform): creation, sculpting, creases, symmetry, topology tools, queries. */

import { commandCatalog } from '../schema';
import { addSubdivisionSolid } from './addSubdivisionSolid';
import { checkSubdivision } from './checkSubdivision';
import { editSubdivisionCage } from './editSubdivisionCage';
import { evaluateSubdivision } from './evaluateSubdivision';
import { extrudeCageFaces } from './extrudeCageFaces';
import { insetCageFaces } from './insetCageFaces';
import { loopCutCage } from './loopCutCage';
import { selectCageElements } from './selectCageElements';
import { setCageCrease } from './setCageCrease';
import { setCageSymmetry } from './setCageSymmetry';

export const subdivisionCommands = commandCatalog(
  addSubdivisionSolid,
  editSubdivisionCage,
  setCageCrease,
  setCageSymmetry,
  extrudeCageFaces,
  insetCageFaces,
  loopCutCage,
  selectCageElements,
  evaluateSubdivision,
  checkSubdivision,
);
