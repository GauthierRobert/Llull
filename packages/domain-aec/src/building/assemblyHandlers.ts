/**
 * Extension point of the generated assemblies (06 STA): the building model keeps assemblies (platforms, pipe racks) and asks the plugin that
 * generated them to re-derive an assembly or to say why it is out of date. A plugin registers one handler per kind when it is installed
 * (`CadPlugin.onInstall`); the building commands (move, check) stay unaware of the domain.
 * @invariant a handler is pure; an assembly whose kind has no handler cannot follow a host (the move is refused) and reports no staleness
 */

import type { CadDocument } from '@core/model/types';
import type { AssemblyElement, AssemblyKind, BuildingModel } from './types';

export type Regeneration =
  | { readonly ok: true; readonly building: BuildingModel; readonly partIds: string[] }
  | { readonly ok: false; readonly message: string };

export interface AssemblyHandler {
  readonly kinds: ReadonlyArray<AssemblyKind>;
  /** Re-derives the parts of `assembly` from its stored parameters in `building` (ids and marks kept, generation raised). */
  readonly regenerate: (doc: CadDocument, building: BuildingModel, assembly: AssemblyElement) => Regeneration;
  /** Why `assembly` no longer matches a fresh derivation (or cannot be derived), or null when it is current. */
  readonly staleReason: (doc: CadDocument, building: BuildingModel, assembly: AssemblyElement) => string | null;
}

const handlers = new Map<AssemblyKind, AssemblyHandler>();

/** Registers (or replaces) `handler` for each of its kinds; called by the plugin's `onInstall`. */
export function registerAssemblyHandler(handler: AssemblyHandler): void {
  for (const kind of handler.kinds) handlers.set(kind, handler);
}

/** Why `assembly` is out of date, or null when current. An assembly of a kind nobody handles is reported as such. */
export function assemblyStaleReason(doc: CadDocument, building: BuildingModel, assembly: AssemblyElement): string | null {
  const handler = handlers.get(assembly.kind);
  return handler === undefined ? `no installed plugin handles '${assembly.kind}' assemblies` : handler.staleReason(doc, building, assembly);
}

export type FollowOutcome =
  | { readonly ok: true; readonly building: BuildingModel; readonly ids: string[] }
  | { readonly ok: false; readonly message: string };

/**
 * Re-derives every assembly hosted by one of `hostIds` (a circular platform follows its vessel, 06 STA FR-STA-14) in `building`, where the hosts
 * already have their new place. Part ids and marks are kept. Refuses (with the reason) when an assembly cannot follow, e.g. the vessel no longer
 * reaches its elevation, or no plugin handles its kind.
 */
export function followAssemblyHosts(doc: CadDocument, building: BuildingModel, hostIds: ReadonlySet<string>): FollowOutcome {
  let next = building;
  const ids: string[] = [];
  for (const assembly of Object.values(building.elements)) {
    if (assembly.category !== 'assembly' || assembly.hostId === undefined || !hostIds.has(assembly.hostId)) continue;
    const handler = handlers.get(assembly.kind);
    if (handler === undefined) return { ok: false, message: `no installed plugin can re-derive ${assembly.id} (${assembly.kind})` };
    const built = handler.regenerate(doc, next, next.elements[assembly.id] as AssemblyElement);
    if (!built.ok) return { ok: false, message: `${assembly.kind} ${assembly.id} cannot follow ${assembly.hostId}: ${built.message}` };
    next = built.building;
    ids.push(assembly.id, ...built.partIds);
  }
  return { ok: true, building: next, ids };
}
