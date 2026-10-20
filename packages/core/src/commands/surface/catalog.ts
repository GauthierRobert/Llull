/** Freeform surfacing (02 SRF): NURBS curves, conics, surface sheets, analysis and the surface toolkit. Listed in toolset `3d`. */

import { commandCatalog } from '../schema';
import { analyzeDraft, analyzeSurfaceCurvature } from './analyzeSurface';
import { createNurbsSurface, surfaceFromPoints } from './buildSurface';
import { checkContinuity, measureDeviation } from './checkJoints';
import { createConic, createNurbsCurve, interpolateCurve } from './createCurve';
import { approximateCurve } from './approximateCurve';
import { editNurbs } from './editNurbs';
import { sewSurfaces, thickenSurface, trimSurface } from './editSurface';
import { fillSurface, loftSurface } from './loftSurface';
import { analyzeCurveCurvature, inspectNurbs } from './queryCurve';

export const surfaceCommands = commandCatalog(
  createNurbsCurve,
  interpolateCurve,
  approximateCurve,
  createConic,
  editNurbs,
  inspectNurbs,
  analyzeCurveCurvature,
  createNurbsSurface,
  surfaceFromPoints,
  loftSurface,
  fillSurface,
  trimSurface,
  sewSurfaces,
  thickenSurface,
  analyzeSurfaceCurvature,
  checkContinuity,
  measureDeviation,
  analyzeDraft,
);
