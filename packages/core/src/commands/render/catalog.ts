/** render_view: the document as an SVG image. */

import { commandCatalog } from '../schema';
import { renderView } from './renderView';

export const renderCommands = commandCatalog(renderView);
