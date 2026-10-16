/** Read-only queries: scene, find, measure, check. */

import { commandCatalog } from '../schema';
import { findEntities } from './query';
import { describeScene } from './scene';
import { measureDistance, measureAngle } from './measureDistanceAngle';
import { measureArea, measurePerimeter } from './measureAreaPerimeter';
import { measureBoundingBox, massProperties } from './measureSolid';
import { checkModel } from './checkModel';
import { checkAssembly } from './checkAssembly';

export const inspectCommands = commandCatalog(
  findEntities,
  describeScene,
  measureDistance,
  measureAngle,
  measureArea,
  measurePerimeter,
  measureBoundingBox,
  massProperties,
  checkModel,
  checkAssembly,
);
