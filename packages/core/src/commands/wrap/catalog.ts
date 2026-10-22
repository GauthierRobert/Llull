/** Curves and features on curved faces, outline fonts and 3D text (03 WRP, toolset 3d): fonts, text outlines, unwrap / wrap / project, emboss, check. */

import { commandCatalog } from '../schema';
import { checkWrap } from './checkWrap';
import { embossOnFace } from './embossOnFace';
import { importFont, listFonts } from './importFont';
import { projectToFace } from './projectToFace';
import { textOutlineCommand } from './textOutlineCommand';
import { unwrapFace } from './unwrapFace';
import { wrapToFace } from './wrapToFace';

export const wrapCommands = commandCatalog(
  importFont,
  listFonts,
  textOutlineCommand,
  unwrapFace,
  wrapToFace,
  projectToFace,
  embossOnFace,
  checkWrap,
);
