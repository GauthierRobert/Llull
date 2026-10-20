/** Semantic PMI (03 GDT): datums, feature control frames, size / location dimensions, surface texture, notes, saved views, checks and stack-ups. */

import { commandCatalog } from '../schema';
import { setPmiStandard } from './standard';
import { addDatumFeature, addDatumTarget } from './datum';
import { addLocationDimension, addSizeDimension } from './dimension';
import { addGeometricTolerance } from './tolerance';
import { addPmiNote, addSurfaceTexture } from './annotation';
import { deletePmi, updatePmi } from './edit';
import { activateSavedView, createSavedView, deleteSavedView, updateSavedView } from './views';
import { listPmi } from './list';
import { checkPmi } from './check';
import { acceptPmiReview } from './review';
import { analyzeStackup } from './stackup';
import { fastenerTolerance } from './fastener';

export const pmiCommands = commandCatalog(
  setPmiStandard,
  addDatumFeature,
  addDatumTarget,
  addSizeDimension,
  addLocationDimension,
  addGeometricTolerance,
  addSurfaceTexture,
  addPmiNote,
  updatePmi,
  deletePmi,
  createSavedView,
  updateSavedView,
  deleteSavedView,
  activateSavedView,
  listPmi,
  checkPmi,
  acceptPmiReview,
  analyzeStackup,
  fastenerTolerance,
);
