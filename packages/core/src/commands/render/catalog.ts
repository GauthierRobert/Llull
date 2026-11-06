/** render_view: the document as an SVG image; render_walkthrough: a walkthrough as PNG frames; render_motion: simulated poses as a frame grid; render_animation: a motion source as time-exact frames / APNG. */

import { commandCatalog } from '../schema';
import { renderView } from './renderView';
import { renderWalkthrough } from './renderWalkthrough';
import { renderMotion } from './renderMotion';
import { renderAnimation } from './renderAnimation';
import { visibleEntityIds } from './visibleEntityIds';

export const renderCommands = commandCatalog(renderView, renderWalkthrough, renderMotion, renderAnimation, visibleEntityIds);
