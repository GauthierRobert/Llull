/** Exact (kernel) modelling: booleans, fillet / chamfer / shell, topology and STEP. */

import { commandCatalog } from '../schema';
import { booleanUnion, booleanSubtract, booleanIntersect } from './boolean';
import { filletEdge, chamferEdge, shellSolid } from './modify3d';
import { inspectTopology, exportStepExact } from './topology';

export const brepCommands = commandCatalog(
  booleanUnion,
  booleanSubtract,
  booleanIntersect,
  filletEdge,
  chamferEdge,
  shellSolid,
  inspectTopology,
  exportStepExact,
);
