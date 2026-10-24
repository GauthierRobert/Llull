/** Body and space deformation (01 DEF, toolset 3d): per-axis scale, twist, taper, stretch, bend, lattice, point push, flow along a curve and onto a surface, and the analysis / check of the result. */

import { commandCatalog } from '../schema';
import { analyzeDeformation } from './analyzeDeformation';
import { bendBody } from './bendBody';
import { checkDeformation } from './checkDeformation';
import { deformByPoint } from './deformByPoint';
import { deformCurveToCurve } from './deformCurveToCurve';
import { deformLattice } from './deformLattice';
import { flowAlongCurve } from './flowAlongCurve';
import { flowOnSurface } from './flowOnSurface';
import { morphBodies } from './morphBodies';
import { scaleNonuniform } from './scaleNonuniform';
import { stretchBody } from './stretchBody';
import { taperBody } from './taperBody';
import { twistBody } from './twistBody';

export const deformCommands = commandCatalog(
  scaleNonuniform,
  twistBody,
  taperBody,
  stretchBody,
  bendBody,
  deformLattice,
  deformByPoint,
  flowAlongCurve,
  flowOnSurface,
  deformCurveToCurve,
  morphBodies,
  analyzeDeformation,
  checkDeformation,
);
