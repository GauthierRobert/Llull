/**
 * Installed plugins — the composition state the registry, persistence and toolsets read.
 * @invariant installation is idempotent per plugin name; order of installation is preserved
 */

import type { CadPlugin, DocumentExtension, DocumentProjections } from './plugin';
import type { DerivationGuard } from '../commands/derivation';
import type { CommandResult, ExecutionContext, RetiredCommandRewrite } from '../commands/types';
import type { BeamLatticeAnswer } from '../model/beamLattice';
import type { LevelSetAnswer } from '../geometry/field/levelSetExport';
import type { CadDocument } from '../model/types';
import type { EntityPropertyProvider } from '../model/entityProperties';

const installed: CadPlugin[] = [];
const listeners: Array<(plugin: CadPlugin) => void> = [];

/**
 * Install `plugin` (no-op when a plugin with the same name is already installed).
 * @invariant `plugin.onInstall` runs once, after every listener accepted the plugin (a rejected plugin has no side effect)
 * @failure a listener rejects it (e.g. a command-name collision) -> not installed, `onInstall` not called, error rethrown
 */
export function installPlugin(plugin: CadPlugin): void {
  if (installed.some((existing) => existing.name === plugin.name)) return;
  installed.push(plugin);
  try {
    for (const listener of listeners) listener(plugin);
    plugin.onInstall?.();
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

/** `next` after every extension's `reconcile`, with the notes and affected ids they report (empty when no installed domain depends on the change). */
function reconcileExtensions(previous: CadDocument, next: CadDocument): { document: CadDocument; notes: string[]; affected: string[] } {
  let document = next;
  const notes: string[] = [];
  const affected: string[] = [];
  for (const extension of documentExtensions()) {
    if (extension.reconcile === undefined) continue;
    const result = extension.reconcile(previous, document);
    document = result.document;
    notes.push(...result.notes);
    affected.push(...result.affected);
  }
  return { document, notes, affected };
}

/**
 * The ONE place a mutating command result is reconciled (execute, nested execute and history replay all call it): the result with every extension's
 * re-derivation applied, notes appended to the summary and re-derived ids appended to `affected`. A result that changed nothing is returned as is.
 * @invariant returns `result` itself when the command changed nothing, was rejected, or no domain depends on the change
 */
export function applyReconcile(before: CadDocument, result: CommandResult): CommandResult {
  if (result.document === before || result.rejected === true) return result;
  const reconciled = reconcileExtensions(before, result.document);
  if (reconciled.document === result.document) return result;
  const extra = reconciled.affected.filter((id) => !result.affected.includes(id));
  return {
    ...result,
    document: reconciled.document,
    summary: reconciled.notes.length > 0 ? `${result.summary} ${reconciled.notes.join(' ')}` : result.summary,
    affected: extra.length > 0 ? [...result.affected, ...new Set(extra)] : result.affected,
  };
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

/** Derived entity ids that an installed plugin could not realise on this machine (see `DocumentExtension.staleEntityIds`). */
export function staleEntityIds(doc: CadDocument): Set<string> {
  return new Set(documentExtensions().flatMap((extension) => [...(extension.staleEntityIds?.(doc) ?? [])]));
}

/** The property providers of the installed plugins, in installation order. */
export function entityPropertyProviders(): EntityPropertyProvider[] {
  return installed.flatMap((plugin) => (plugin.entityProperties ? [plugin.entityProperties] : []));
}

/** The beam lattice of `entityId` from the first installed plugin that knows it (a string is the reason there is none), or null. */
export function beamLatticeOf(doc: CadDocument, entityId: string, ctx: ExecutionContext | undefined): BeamLatticeAnswer {
  for (const plugin of installed) {
    const answer = plugin.beamLattice?.(doc, entityId, ctx);
    if (answer !== undefined && answer !== null) return answer;
  }
  return null;
}

/** The level set of `entityId` from the first installed plugin that knows it (a string is the reason there is none), or null. */
export function levelSetOf(doc: CadDocument, entityId: string, ctx: ExecutionContext | undefined): LevelSetAnswer {
  for (const plugin of installed) {
    const answer = plugin.levelSet?.(doc, entityId, ctx);
    if (answer !== undefined && answer !== null) return answer;
  }
  return null;
}

/** The reason an installed plugin gives for not exporting `entityId` as an exact STEP solid, or null. */
export function stepSkipReason(doc: CadDocument, entityId: string): string | null {
  for (const plugin of installed) {
    const reason = plugin.stepSkip?.(doc, entityId);
    if (reason !== undefined && reason !== null) return reason;
  }
  return null;
}

/** Command names a toolset gets from installed plugins. */
export function pluginToolNames(toolset: string): string[] {
  return installed.filter((plugin) => plugin.toolset === toolset).flatMap((plugin) => plugin.commands.map((command) => command.name));
}
