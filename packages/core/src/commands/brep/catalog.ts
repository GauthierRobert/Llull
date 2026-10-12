/** Exact (kernel) modelling: booleans, fillet / chamfer / shell, topology and STEP. */

import { commandCatalog } from '../schema';
import { booleanOperation } from './boolean';
import { filletEdge, chamferEdge, shellSolid } from './modify3d';
import { inspectTopology, exportStepExact } from './topology';
import { blendUnion } from './blend';

export const brepCommands = commandCatalog(
  booleanOperation,
  blendUnion,
  filletEdge,
  chamferEdge,
  shellSolid,
  inspectTopology,
  exportStepExact,
);
