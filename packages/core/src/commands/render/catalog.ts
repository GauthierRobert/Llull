/** render_view: the document as an SVG image; render_walkthrough: a walkthrough as PNG frames. */

import { commandCatalog } from '../schema';
import { renderView } from './renderView';
import { renderWalkthrough } from './renderWalkthrough';

export const renderCommands = commandCatalog(renderView, renderWalkthrough);
