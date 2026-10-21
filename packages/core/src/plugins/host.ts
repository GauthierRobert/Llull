/**
 * Installed plugins — the composition state the registry, persistence and toolsets read.
 * @invariant installation is idempotent per plugin name; order of installation is preserved
 */

import type { CadPlugin, DocumentExtension, DocumentProjections } from './plugin';
import type { DerivationGuard } from '../commands/derivation';
import type { RetiredCommandRewrite } from '../commands/types';
import type { CadDocument } from '../model/types';

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

/** Called for every plugin installed after (and, immediately, before) subscription. */
export function onPluginInstalled(listener: (plugin: CadPlugin) => void): void {
  listeners.push(listener);
  for (const plugin of installed) listener(plugin);
}

export function pluginGuards(): DerivationGuard[] {
  return installed.flatMap((plugin) => plugin.guards ?? []);
}

export function pluginRetiredCommands(): Record<string, RetiredCommandRewrite> {
  return Object.assign({}, ...installed.map((plugin) => plugin.retiredCommands ?? {}));
}

export function documentExtensions(): DocumentExtension[] {
  return installed.flatMap((plugin) => (plugin.document ? [plugin.document] : []));
}

/** The first installed plugin projection named `key`, or undefined (core then behaves as if the domain were absent). */
export function documentProjection<K extends keyof DocumentProjections>(key: K): DocumentProjections[K] {
  for (const extension of documentExtensions()) {
    const projection = extension.projections?.[key];
    if (projection !== undefined) return projection;
  }
  return undefined;
}

/**
 * Entity ids regenerated from the definition by an installed plugin's pure deriver (today: the building plugin). Persistence omits these
 * and re-derives them on load (architecture L8).
 */
export function derivedEntityIds(doc: CadDocument): Set<string> {
  return new Set(documentExtensions().flatMap((extension) => [...extension.derivedEntityIds(doc)]));
}

/** Command names a toolset gets from installed plugins. */
export function pluginToolNames(toolset: string): string[] {
  return installed.filter((plugin) => plugin.toolset === toolset).flatMap((plugin) => plugin.commands.map((command) => command.name));
}
