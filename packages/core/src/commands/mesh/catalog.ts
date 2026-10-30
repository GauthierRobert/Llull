/** Mesh modelling (07 MSH, toolset `mesh`): import, inspect and check triangle meshes; hull, Minkowski, offset, hollow, wrap and subdivision through the mesh-engine port; repair, hole filling, decimation, remeshing, smoothing and plane cuts; quad remeshing; fitting a subdivision cage and a B-spline patch to a mesh. */

import { commandCatalog } from '../schema';
import { analyzeMesh } from './analyzeMesh';
import { attachMeshAsset } from './attachMeshAsset';
import { checkMesh } from './checkMesh';
import { convexHull } from './convexHull';
import { importMeshFile } from './importMeshFile';
import { cutMesh } from './cutMesh';
import { decimateMesh } from './decimateMesh';
import { fillMeshHoles } from './fillMeshHoles';
import { fitSubdivisionToMesh } from './fitSubdivisionToMesh';
import { fitSurfaceToMesh } from './fitSurfaceToMesh';
import { hollowMesh, offsetMesh } from './levelSetCommands';
import { meshToBrep } from './meshToBrep';
import { addGridMesh, addIcosphereMesh } from './addGeneratedMesh';
import { sculptMesh } from './sculptMesh';
import { displaceMesh } from './displaceMesh';
import { shrinkwrapMesh } from './shrinkwrapMesh';
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
  shrinkwrapMesh,
  displaceMesh,
  addGridMesh,
  addIcosphereMesh,
  subdivideMesh,
  quadRemesh,
  fitSubdivisionToMesh,
  fitSurfaceToMesh,
);
