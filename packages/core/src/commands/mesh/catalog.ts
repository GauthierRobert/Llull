/** Mesh modelling (07 MSH, toolset `mesh`): import, inspect and check triangle meshes; hull, Minkowski, offset, hollow, wrap and subdivision through the mesh-engine port. */

import { commandCatalog } from '../schema';
import { analyzeMesh } from './analyzeMesh';
import { checkMesh } from './checkMesh';
import { convexHull } from './convexHull';
import { importMeshFile } from './importMeshFile';
import { hollowMesh, offsetMesh, repairMesh } from './levelSetCommands';
import { minkowskiSum } from './minkowskiSum';
import { subdivideMesh } from './subdivideMesh';

export const meshCommands = commandCatalog(
  importMeshFile,
  analyzeMesh,
  checkMesh,
  convexHull,
  minkowskiSum,
  offsetMesh,
  hollowMesh,
  repairMesh,
  subdivideMesh,
);
