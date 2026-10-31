/** Curves and features on curved faces, outline fonts and 3D text (03 WRP, toolset 3d): fonts, text outlines, unwrap / wrap / project, emboss, check. */

import { commandCatalog } from '../schema';
import { addKnurl } from './addKnurl';
import { checkWrap } from './checkWrap';
import { createCurveOnFace } from './createCurveOnFace';
import { embossOnFace } from './embossOnFace';
import { fontMetrics } from './fontMetrics';
import { importFont, listFonts } from './importFont';
import { patternOnFace } from './patternOnFace';
import { previewAddKnurl, previewEmbossOnFace } from './previewWrap';
import { projectToFace } from './projectToFace';
import { splitAtSilhouette } from './splitAtSilhouette';
import { splitFaceByCurves } from './splitFaceByCurves';
import { textOutlineCommand } from './textOutlineCommand';
import { unwrapFace } from './unwrapFace';
import { wrapOverlay } from './wrapOverlay';
import { wrapToFace } from './wrapToFace';

export const wrapCommands = commandCatalog(
  importFont,
  listFonts,
  fontMetrics,
  textOutlineCommand,
  unwrapFace,
  wrapToFace,
  projectToFace,
  embossOnFace,
  patternOnFace,
  createCurveOnFace,
  addKnurl,
  splitFaceByCurves,
  splitAtSilhouette,
  checkWrap,
  wrapOverlay,
  previewEmbossOnFace,
  previewAddKnurl,
);
