/**
 * Installed plugins — the composition state the registry, persistence and toolsets read.
 *
 * @layer core/plugins
 * @invariant installation is idempotent per plugin name; order of installation is preserved
 */

import type { CadPlugin, DocumentExtension } from './plugin';
import type { DerivationGuard } from '../commands/derivation';

const installed: CadPlugin[] = [];
const listeners: Array<(plugin: CadPlugin) => void> = [];

/**
 * Install `plugin` (no-op when a plugin with the same name is already installed).
 * @failure a listener rejects it (e.g. a command-name collision) -> not installed, error rethrown
 */
export function installPlugin(plugin: CadPlugin): void {
  if (installed.some((existing) => existing.name === plugin.name)) return;
  installed.push(plugin);
  try {
    for (const listener of listeners) listener(plugin);
  } catch (error) {
    installed.splice(installed.indexOf(plugin), 1);
    throw error;
  }
}

export function installedPlugins(): ReadonlyArray<CadPlugin> {
  return installed;
}

/** Called for every plugin installed after (and, immediately, before) subscription. */
export function onPluginInstalled(listener: (plugin: CadPlugin) => void): void {
  listeners.push(listener);
  for (const plugin of installed) listener(plugin);
}

export function pluginGuards(): DerivationGuard[] {
  return installed.flatMap((plugin) => plugin.guards ?? []);
}

export function documentExtensions(): DocumentExtension[] {
  return installed.flatMap((plugin) => (plugin.document ? [plugin.document] : []));
}

/** Command names a toolset gets from installed plugins. */
export function pluginToolNames(toolset: string): string[] {
  return installed
    .filter((plugin) => plugin.toolset === toolset)
    .flatMap((plugin) => plugin.commands.map((command) => command.name));
}
