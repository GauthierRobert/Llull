/** Display: colour profiles, the colour-by-rule report and the display check (plant 09 VIS). */

import { commandCatalog } from '../schema';
import { checkDisplay } from './checkDisplay';
import { colourByRuleReport } from './colourReport';
import { defineColourProfile, deleteColourProfile, setActiveColourProfile } from './colourProfiles';

export const displayCommands = commandCatalog(
  defineColourProfile,
  setActiveColourProfile,
  deleteColourProfile,
  colourByRuleReport,
  checkDisplay,
);
