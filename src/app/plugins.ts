/**
 * Composition root (MG6.2): the app, the MCP server and the test setup install the default
 * domain plugins here — the only place that knows which domains extend the CAD core.
 *
 * @layer app
 */

import { installPlugin } from '@core/plugins/host';
import { buildingPlugin, industrialPlugin } from '@aec/plugin';

/** Install every default domain plugin (idempotent). */
export function installDefaultPlugins(): void {
  installPlugin(buildingPlugin);
  installPlugin(industrialPlugin);
}
