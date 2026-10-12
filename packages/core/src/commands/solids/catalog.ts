/** 3D primitives, profile solids (extrude / revolve / sweep), gears and composite solids. */

import { commandCatalog } from '../schema';
import { addBox, extrude } from './basic';
import { addCylinder, addSphere, addCone, addTorus } from './round';
import { addWedge, addPyramid } from './prismatic';
import { extrudeSketch, revolveProfile } from './profile';
import { sweepProfile } from './sweep';
import { loftSections } from './loft';
import { addSubdivisionSolid } from './subdivision';
import { editSubdivisionCage } from './subdivisionCage';
import { surfaceFromCurves } from './surfaceFromCurves';
import { addSpurGear } from './gears';
import { addHelixSpring } from './helixSpring';
import { addBearing } from './bearings';
import { addInternalGear } from './gearsInternal';
import { addPlanetaryGearset } from './gearsPlanetary';
import { addBevelGear, addBevelGearPair } from './gearsBevel';
import { addSplineShaft, addKeyedShaft } from './shafts';

export const solidsCommands = commandCatalog(
  addBox,
  addCylinder,
  addSphere,
  addCone,
  addTorus,
  addWedge,
  addPyramid,
  extrude,
  extrudeSketch,
  revolveProfile,
  sweepProfile,
  loftSections,
  addSubdivisionSolid,
  editSubdivisionCage,
  surfaceFromCurves,
  addSpurGear,
  addHelixSpring,
  addBearing,
  addInternalGear,
  addPlanetaryGearset,
  addBevelGear,
  addBevelGearPair,
  addSplineShaft,
  addKeyedShaft,
);
