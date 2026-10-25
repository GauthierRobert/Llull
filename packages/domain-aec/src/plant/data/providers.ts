/**
 * Plant object providers (plant 08 DAT §2, TR-DAT-05): a plant object stands for an object of the model through a provider that answers whether it
 * exists, what it is called, which tag-like field it already carries, and how to write the tag back. DAT ships the providers of the building
 * elements, the routed lines, the inline components and the tie-ins (`providersBuiltin.ts`); sibling plugins register theirs (03 EQP nozzles,
 * 01/02 components, 04 PID instruments) with `registerPlantObjectProvider` at install time (open / closed, C6).
 * @invariant providers are read-only on the document except `writeTags`, which returns a new document
 */

import type { CadDocument } from '@core/model/types';
import type { ExecutionContext } from '@core/commands/types';
import { providerIdOf, type PlantObjectTarget } from './model';
import { objectRegistry } from './registry';
import { getPlantData } from './model';
import type { PlantValueInput } from './properties';
import { normaliseTag } from './tagFormat';

export interface ProviderElement {
  readonly id: string;
  /** What the model calls it (`equipment`, `pipe`, `routedLine`, `valve`, ...). */
  readonly category: string;
  /** Short human label for summaries (`equipment-2 "Feed tank"`). */
  readonly label: string;
  /** The tag-like field the object already carries (equipment mark, line number, inline tag), when it has one. */
  readonly tag?: string;
  /** Objects of this provider must carry distinct `tag`s (an equipment mark, a routed line number): a plant tag may not equal another one's. */
  readonly tagUnique: boolean;
  /** `check_plant_data` reports the object when it has no plant object (DAT_UNCLASSIFIED_ELEMENT). */
  readonly needsClass: boolean;
}

export interface PlantObjectProvider {
  /** `buildingElement` or the `provider` name of a `PlantObjectTarget`. */
  readonly id: string;
  /** Every object of the provider that has a tag-like field or needs a class (not the whole model). */
  elements(doc: CadDocument): readonly ProviderElement[];
  element(doc: CadDocument, id: string): ProviderElement | undefined;
  /** `from` / `to` names a line object carries in the model. */
  ends?(doc: CadDocument, id: string): { readonly from?: string; readonly to?: string };
  /** Nominal size DN of a pipe or line object. */
  dn?(doc: CadDocument, id: string): number | undefined;
  /** Facts of the model object offered as defaults for tag fields and properties at assignment (the caller's values win). */
  seeds?(doc: CadDocument, id: string): Readonly<Record<string, PlantValueInput>>;
  /** Names of battery limits the provider declares (tie-in points of kind battery_limit). */
  batteryLimits?(doc: CadDocument): readonly string[];
  /** Why the provider cannot carry `tag` in its own tag field (a grammar of the owning plugin), or null. Checked before any tag is written. */
  tagProblem?(doc: CadDocument, id: string, tag: string): string | null;
  /** Writes tags into the model objects in one step; a text says why it cannot. Absent = the provider cannot rename its objects. */
  writeTags?(
    doc: CadDocument,
    tags: readonly { readonly id: string; readonly tag: string }[],
    ctx: ExecutionContext | undefined,
  ): CadDocument | string;
}

const providers = new Map<string, PlantObjectProvider>();

/** Registers (or replaces) a provider; called by the plugins' `onInstall`. */
export function registerPlantObjectProvider(provider: PlantObjectProvider): void {
  providers.set(provider.id, provider);
  foreignCache = new WeakMap();
}

/** Removes a provider (tests that register their own). */
export function unregisterPlantObjectProvider(id: string): void {
  providers.delete(id);
  foreignCache = new WeakMap();
}

export const getProvider = (id: string): PlantObjectProvider | undefined => providers.get(id);

export const allProviders = (): readonly PlantObjectProvider[] => [...providers.values()];

/** Provider and model object of a target, or null (reserved target, unregistered provider, deleted object). */
export function elementOf(
  doc: CadDocument,
  target: PlantObjectTarget,
): { readonly provider: PlantObjectProvider; readonly element: ProviderElement } | null {
  if (target.kind === 'reserved') return null;
  const provider = providers.get(providerIdOf(target) as string);
  const element = provider?.element(doc, target.id);
  return provider === undefined || element === undefined ? null : { provider, element };
}

export type ResolvedTarget =
  | { readonly ok: true; readonly target: PlantObjectTarget; readonly provider: PlantObjectProvider; readonly element: ProviderElement }
  | { readonly ok: false; readonly message: string };

/** A caller's target reference: an id any provider knows (building elements first), or `{ provider, id }`. */
export function resolveTarget(doc: CadDocument, reference: string | { readonly provider: string; readonly id: string }): ResolvedTarget {
  if (typeof reference !== 'string') {
    const provider = providers.get(reference.provider);
    if (provider === undefined)
      return { ok: false, message: `no object provider "${reference.provider}" is installed (${[...providers.keys()].join(', ')})` };
    const element = provider.element(doc, reference.id);
    if (element === undefined) return { ok: false, message: `provider ${provider.id} has no object "${reference.id}"` };
    return { ok: true, target: asTarget(provider.id, reference.id), provider, element };
  }
  for (const provider of providers.values()) {
    const element = provider.element(doc, reference);
    if (element !== undefined) return { ok: true, target: asTarget(provider.id, reference), provider, element };
  }
  return { ok: false, message: `no model object "${reference}" in any provider (${[...providers.keys()].join(', ')})` };
}

const asTarget = (providerId: string, id: string): PlantObjectTarget =>
  providerId === 'buildingElement' ? { kind: 'buildingElement', id } : { kind: 'provider', provider: providerId, id };

type ForeignHolder = { readonly provider: string; readonly element: ProviderElement };

let foreignCache = new WeakMap<CadDocument, ReadonlyMap<string, readonly ForeignHolder[]>>();

/** Normalised tag -> the model objects that carry it as a field that must be unique and that no plant object stands for (tags in use the plant objects do not know). Built once per document. */
function foreignIndex(doc: CadDocument): ReadonlyMap<string, readonly ForeignHolder[]> {
  const cached = foreignCache.get(doc);
  if (cached !== undefined) return cached;
  const data = getPlantData(doc);
  const claimed = objectRegistry(data).byTarget;
  const index = new Map<string, ForeignHolder[]>();
  for (const provider of providers.values())
    for (const element of provider.elements(doc)) {
      if (!element.tagUnique || element.tag === undefined) continue;
      const key = normaliseTag(element.tag);
      const owner = claimed.get(`${provider.id}:${element.id}`);
      // A claimed element is the plant object's own tag only while both agree; a mark changed behind the plant object's back is a tag in use.
      if (owner !== undefined && normaliseTag(data.objects[owner]?.tag ?? '') === key) continue;
      index.set(key, [...(index.get(key) ?? []), { provider: provider.id, element }]);
    }
  foreignCache.set(doc, index);
  return index;
}

/** Model objects whose unique tag field equals `tag` and that no plant object stands for. */
export const foreignTagHolders = (doc: CadDocument, tag: string): readonly ForeignHolder[] =>
  foreignIndex(doc).get(normaliseTag(tag)) ?? [];

/** Every normalised tag some model object carries as a unique tag field without a plant object standing for it. */
export const foreignTags = (doc: CadDocument): string[] => [...foreignIndex(doc).keys()];
