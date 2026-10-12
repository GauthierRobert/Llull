/** 2D drafting: lines, arcs, curves, belts, text, dimensions and image underlays. */

import { commandCatalog } from '../schema';
import { drawPolyline, drawArc, drawRectangle, drawPoint } from './basic';
import { drawEllipse, drawSpline, drawInvolute } from './curves';
import { addText, addDimension } from './annotate';
import { drawBeltAround } from './belt';
import { addImageUnderlay, calibrateUnderlayCommand, setUnderlay, imageToWorld } from './underlay';

export const draw2dCommands = commandCatalog(
  drawPolyline,
  drawArc,
  drawRectangle,
  drawPoint,
  drawEllipse,
  drawSpline,
  addText,
  addDimension,
  drawInvolute,
  drawBeltAround,
  addImageUnderlay,
  calibrateUnderlayCommand,
  setUnderlay,
  imageToWorld,
);
