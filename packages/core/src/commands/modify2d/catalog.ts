/** 2D modify: explode, offset, trim, extend, fillet, chamfer. */

import { commandCatalog } from '../schema';
import { explodePolyline, offset2D } from './basic';
import { trim, extend } from './trimExtend';
import { fillet2D, chamfer2D } from './corners';

export const modify2dCommands = commandCatalog(
  explodePolyline,
  offset2D,
  trim,
  extend,
  fillet2D,
  chamfer2D,
);
