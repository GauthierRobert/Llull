// Composition root of the default domain plugins (app, backend, CLI, test setup): the only place that knows the domains.

import { installPlugin } from '@core/plugins/host';
import { buildingPlugin, civilPlugin, industrialPlugin } from '@aec/index';
import { caePlugin, topologyPlugin } from '@cae/index';
import { aerodynamicsPlugin, compositesPlugin, fastenersPlugin, fluidsPlugin, sheetMetalPlugin, surfacingPlugin } from '@aero/index';
import { designPlugin } from '@design/index';
import { plmPlugin } from '@plm/index';

/** Install every default domain plugin (idempotent). */
export function installDefaultPlugins(): void {
  installPlugin(buildingPlugin);
  installPlugin(industrialPlugin);
  installPlugin(civilPlugin);
  installPlugin(caePlugin);
  installPlugin(topologyPlugin);
  installPlugin(sheetMetalPlugin);
  installPlugin(fastenersPlugin);
  installPlugin(aerodynamicsPlugin);
  installPlugin(surfacingPlugin);
  installPlugin(compositesPlugin);
  installPlugin(fluidsPlugin);
  installPlugin(designPlugin);
  installPlugin(plmPlugin);
}
