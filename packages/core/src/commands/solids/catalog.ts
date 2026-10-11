/** 3D primitives, profile solids (extrude / revolve / sweep), gears and composite solids. */

import { commandCatalog } from '../schema';
import { addBox, extrude } from './basic';
import { addCylinder, addSphere, addCone, addTorus } from './round';
import { addWedge, addPyramid } from './prismatic';
import { extrudeSketch, revolveProfile } from './profile';
import { sweepProfile } from './sweep';
import { makeTubeBetween } from './composite';
import { addSpurGear } from './gears';
import { addHelixSpring } from './helixSpring';
import { addBearing } from './bearings';

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
  makeTubeBetween,
  addSpurGear,
  addHelixSpring,
  addBearing,
);
