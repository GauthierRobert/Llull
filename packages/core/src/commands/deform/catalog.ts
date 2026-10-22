/** Body and space deformation (01 DEF, toolset 3d): per-axis scale, twist, taper, stretch, bend, and the analysis / check of the result. */

import { commandCatalog } from '../schema';
import { analyzeDeformation } from './analyzeDeformation';
import { bendBody } from './bendBody';
import { checkDeformation } from './checkDeformation';
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
  analyzeDeformation,
  checkDeformation,
);
