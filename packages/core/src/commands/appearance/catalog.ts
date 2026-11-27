/** Appearance data (RV1 RV-M1 / RV-M2): textures, layered materials, the offline library, the scene environment. */

import { commandCatalog } from '../schema';
import { applyAppearance } from './applyAppearance';
import { importTexture } from './importTexture';
import { listAppearances } from './listAppearances';
import { setEnvironment } from './setEnvironment';
import { setMaterialAppearance } from './setMaterialAppearance';

export const appearanceCommands = commandCatalog(importTexture, setMaterialAppearance, applyAppearance, listAppearances, setEnvironment);
