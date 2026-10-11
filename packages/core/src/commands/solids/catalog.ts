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
import { makeTubeBetween } from './composite';
import { addSpurGear } from './gears';

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
  makeTubeBetween,
  addSpurGear,
);
