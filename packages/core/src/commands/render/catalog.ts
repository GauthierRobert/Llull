/** render_view: the document as an SVG image; render_walkthrough: a walkthrough as PNG frames; render_motion: simulated poses as a frame grid. */

import { commandCatalog } from '../schema';
import { renderView } from './renderView';
import { renderWalkthrough } from './renderWalkthrough';
import { renderMotion } from './renderMotion';

export const renderCommands = commandCatalog(renderView, renderWalkthrough, renderMotion);
