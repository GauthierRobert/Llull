/**
 * @layer server
 * Side-effect module: installs the default domain plugins. Imported FIRST by index.ts, so the
 * autosave load in liveDocument.ts already sees the building document extension.
 */
import { installDefaultPlugins } from '@app/plugins';

installDefaultPlugins();
