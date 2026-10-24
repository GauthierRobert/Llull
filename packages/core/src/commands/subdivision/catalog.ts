/** Subdivision-surface cages and their direct editing (04 DIR, toolsets 3d and freeform): creation, sculpting, creases, symmetry, topology tools, queries. */

import { commandCatalog } from '../schema';
import { addSubdivisionSolid } from './addSubdivisionSolid';
import { bevelCageEdges } from './bevelCageEdges';
import { bridgeCageFaces } from './bridgeCageFaces';
import { checkSubdivision } from './checkSubdivision';
import { deleteCageFaces } from './deleteCageFaces';
import { editSubdivisionCage } from './editSubdivisionCage';
import { evaluateSubdivision } from './evaluateSubdivision';
import { fillCageHole } from './fillCageHole';
import { extrudeCageFaces } from './extrudeCageFaces';
import { insetCageFaces } from './insetCageFaces';
import { loopCutCage } from './loopCutCage';
import { selectCageElements } from './selectCageElements';
import { setCageCrease } from './setCageCrease';
import { setCageSymmetry } from './setCageSymmetry';
import { slideCageEdges } from './slideCageEdges';
import { subdivisionToNurbs } from './subdivisionToNurbs';
import { weldCageVertices } from './weldCageVertices';

export const subdivisionCommands = commandCatalog(
  addSubdivisionSolid,
  editSubdivisionCage,
  setCageCrease,
  setCageSymmetry,
  extrudeCageFaces,
  insetCageFaces,
  loopCutCage,
  bridgeCageFaces,
  bevelCageEdges,
  deleteCageFaces,
  fillCageHole,
  weldCageVertices,
  slideCageEdges,
  selectCageElements,
  evaluateSubdivision,
  checkSubdivision,
  subdivisionToNurbs,
);
