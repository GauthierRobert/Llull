/** 2D drafting: lines, arcs, curves, belts, text and dimensions. */

import { commandCatalog } from '../schema';
import { drawLine, drawPolyline, drawArc, drawCircle, drawRectangle, drawPoint } from './basic';
import { drawEllipse, drawSpline, drawInvolute } from './curves';
import { addText, addDimension } from './annotate';
import { drawBeltAround } from './belt';

export const draw2dCommands = commandCatalog(
  drawLine,
  drawPolyline,
  drawArc,
  drawCircle,
  drawRectangle,
  drawPoint,
  drawEllipse,
  drawSpline,
  addText,
  addDimension,
  drawInvolute,
  drawBeltAround,
);
