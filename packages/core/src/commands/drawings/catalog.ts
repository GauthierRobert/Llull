/** Drawing sheets: 2D documentation (orthographic, section, detail views) derived from the 3D model. */

import { commandCatalog } from '../schema';
import { createSheet } from './createSheet';
import { createDrawingView, addSectionView, addDetailView } from './viewCommands';
import { updateDrawingView, deleteDrawingView, updateSheet, deleteSheet } from './editCommands';
import { exportSheetSvg } from './exportSheetSvg';

export const drawingsCommands = commandCatalog(
  createSheet,
  createDrawingView,
  addSectionView,
  addDetailView,
  updateDrawingView,
  deleteDrawingView,
  updateSheet,
  deleteSheet,
  exportSheetSvg,
);
