/** Exact (kernel) modelling: booleans, fillet / chamfer / shell, face operations (draft, push-pull, split, replace), topology and STEP. */

import { commandCatalog } from '../schema';
import { booleanOperation } from './boolean';
import { filletEdge, chamferEdge, shellSolid } from './modify3d';
import { inspectTopology } from './topology';
import { blendUnion } from './blend';
import { inspectFaces } from './faces';
import { draftFaces, pushPullFace, replaceFace, splitFace } from './faceOps';
import { deleteFaces, moveFaces } from './faceMoves';
import { splitBody } from './splitBody';
import { probeFillet } from './probeFillet';
import { filletFaces } from './filletFaces';
import { filletFullRound } from './filletFullRound';
import { checkBlends } from './checkBlends';

export const brepCommands = commandCatalog(
  booleanOperation,
  blendUnion,
  filletEdge,
  chamferEdge,
  probeFillet,
  filletFaces,
  filletFullRound,
  checkBlends,
  shellSolid,
  draftFaces,
  pushPullFace,
  splitFace,
  moveFaces,
  deleteFaces,
  replaceFace,
  splitBody,
  inspectTopology,
  inspectFaces,
);
