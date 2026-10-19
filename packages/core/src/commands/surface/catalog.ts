/** Freeform surfacing (02 SRF): NURBS curves, conics, interpolation and curvature analysis. Toolset `surface`. */

import { commandCatalog } from '../schema';
import { createConic, createNurbsCurve, interpolateCurve } from './createCurve';
import { editNurbs } from './editNurbs';
import { analyzeCurveCurvature, inspectNurbs } from './queryCurve';

export const surfaceCommands = commandCatalog(
  createNurbsCurve,
  interpolateCurve,
  createConic,
  editNurbs,
  inspectNurbs,
  analyzeCurveCurvature,
);
