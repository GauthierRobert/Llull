/** Mesh modelling (07 MSH, toolset `mesh`): import, inspect and check triangle meshes; hull, Minkowski, offset, hollow, wrap and subdivision through the mesh-engine port; repair, hole filling, decimation, remeshing, smoothing and plane cuts; quad remeshing. */

import { commandCatalog } from '../schema';
import { analyzeMesh } from './analyzeMesh';
import { attachMeshAsset } from './attachMeshAsset';
import { checkMesh } from './checkMesh';
import { convexHull } from './convexHull';
import { importMeshFile } from './importMeshFile';
import { cutMesh } from './cutMesh';
import { decimateMesh } from './decimateMesh';
import { fillMeshHoles } from './fillMeshHoles';
import { hollowMesh, offsetMesh } from './levelSetCommands';
import { meshToBrep } from './meshToBrep';
import { addGridMesh, addIcosphereMesh } from './addGeneratedMesh';
import { sculptMesh } from './sculptMesh';
import { minkowskiSum } from './minkowskiSum';
import { quadRemesh } from './quadRemesh';
import { remeshMesh } from './remeshMesh';
import { repairMesh } from './repairMesh';
import { segmentMesh } from './segmentMesh';
import { smoothMesh } from './smoothMesh';
import { subdivideMesh } from './subdivideMesh';

export const meshCommands = commandCatalog(
  importMeshFile,
  attachMeshAsset,
  analyzeMesh,
  checkMesh,
  convexHull,
  minkowskiSum,
  offsetMesh,
  hollowMesh,
  repairMesh,
  fillMeshHoles,
  decimateMesh,
  remeshMesh,
  smoothMesh,
  cutMesh,
  segmentMesh,
  meshToBrep,
  sculptMesh,
  addGridMesh,
  addIcosphereMesh,
  subdivideMesh,
  quadRemesh,
);
