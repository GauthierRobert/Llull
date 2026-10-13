/**
 * Composition root: the app, the MCP server and the test setup install the default
 * domain plugins here — the only place that knows which domains extend the CAD core.
 */

import { installPlugin } from '@core/plugins/host';
import { buildingPlugin, civilPlugin, industrialPlugin } from '@aec/index';

/** Install every default domain plugin (idempotent). */
export function installDefaultPlugins(): void {
  installPlugin(buildingPlugin);
  installPlugin(industrialPlugin);
  installPlugin(civilPlugin);
}
