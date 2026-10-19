// Composition root of the default domain plugins (app, backend, CLI, test setup): the only place that knows the domains.

import { installPlugin } from '@core/plugins/host';
import { buildingPlugin, civilPlugin, industrialPlugin, pipingPlugin } from '@aec/index';
import { caePlugin, topologyPlugin } from '@cae/index';
import { aerodynamicsPlugin, fastenersPlugin, fluidsPlugin, sheetMetalPlugin } from '@aero/index';
import { designPlugin } from '@design/index';

/** Install every default domain plugin (idempotent). */
export function installDefaultPlugins(): void {
  installPlugin(buildingPlugin);
  installPlugin(industrialPlugin);
  installPlugin(civilPlugin);
  installPlugin(pipingPlugin);
  installPlugin(caePlugin);
  installPlugin(topologyPlugin);
  installPlugin(sheetMetalPlugin);
  installPlugin(fastenersPlugin);
  installPlugin(aerodynamicsPlugin);
  installPlugin(fluidsPlugin);
  installPlugin(designPlugin);
}
