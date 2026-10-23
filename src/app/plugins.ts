// Composition root of the default domain plugins (app, backend, CLI, test setup): the only place that knows the domains.

import { installPlugin } from '@core/plugins/host';
import {
  buildingPlugin,
  civilPlugin,
  industrialPlugin,
  pipingCatalogPlugin,
  pipingPlugin,
  plantDisplayPlugin,
  plantEquipmentPlugin,
  scanPlugin,
  structuresPlugin,
} from '@aec/index';
import { caePlugin, explicitPlugin, topologyPlugin } from '@cae/index';
import {
  aerodynamicsPlugin,
  cfdPlugin,
  compositesPlugin,
  fastenersPlugin,
  fluidsPlugin,
  sheetMetalPlugin,
  surfacingPlugin,
} from '@aero/index';
import { dynamicsPlugin } from '@dynamics/index';
import { implicitPlugin } from '@implicit/index';
import { designPlugin } from '@design/index';
import { plmPlugin } from '@plm/index';

/** Install every default domain plugin (idempotent). */
export function installDefaultPlugins(): void {
  installPlugin(dynamicsPlugin);
  installPlugin(buildingPlugin);
  installPlugin(industrialPlugin);
  installPlugin(civilPlugin);
  installPlugin(pipingPlugin);
  installPlugin(pipingCatalogPlugin);
  installPlugin(structuresPlugin);
  installPlugin(plantEquipmentPlugin);
  installPlugin(plantDisplayPlugin);
  installPlugin(caePlugin);
  installPlugin(topologyPlugin);
  installPlugin(sheetMetalPlugin);
  installPlugin(fastenersPlugin);
  installPlugin(aerodynamicsPlugin);
  installPlugin(surfacingPlugin);
  installPlugin(compositesPlugin);
  installPlugin(fluidsPlugin);
  installPlugin(cfdPlugin);
  installPlugin(designPlugin);
  installPlugin(plmPlugin);
  installPlugin(explicitPlugin);
  installPlugin(scanPlugin);
  installPlugin(implicitPlugin);
}
