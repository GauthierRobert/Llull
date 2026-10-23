/**
 * Run display geometry is derived from `plant.piping` (02 RTE §2 "stored intent, derived parts"): one read-only entity per part of every run
 * (`routeParts.deriveRun` -> `geometry.partEntity`; ids `<runId>/<kind>-<k>`), omitted from saved files, re-derived on load and protected by a
 * derivation guard (architecture L8). The ids of a run's entities are kept in `plant.piping.entityIds`.
 */

import type { CadDocument, Entity } from '@core/model/types';
import type { PipeRun, PipingModel } from '@aec/plant/types';
import type { DerivationGuard } from '@core/commands/derivation';
import type { DocumentExtension } from '@core/plugins/plugin';
import { isRecord } from '@lib/isRecord';
import { ensureLayerIds } from '../../shared/derived';
import { partEntity, PIPING_LAYER_COLORS } from './geometry';
import { getPiping } from './model';
import { deriveRun } from './routeParts';
import { pipingErrors } from './validate';

/** The entities of `run` in route order (empty when the run does not derive: unknown spec, missing port ...). */
function runEntities(doc: CadDocument, run: PipeRun): Entity[] {
  const line = getPiping(doc).lines[run.lineId];
  if (line === undefined) return [];
  const derived = deriveRun(doc, run);
  if (!derived.ok) return [];
  return derived.parts.flatMap((part) => partEntity(part, line) ?? []);
}

/** `doc` with the display entities of run `runId` rebuilt (the old ones removed) and `entityIds` updated; the run must be in `plant.piping`. */
export function withRunEntities(doc: CadDocument, runId: string): CadDocument {
  const piping = getPiping(doc);
  const run = piping.runs[runId];
  const stale = new Set(piping.entityIds[runId] ?? []);
  const entities: Record<string, Entity> = {};
  for (const [id, entity] of Object.entries(doc.entities)) if (!stale.has(id)) entities[id] = entity;
  const order = doc.order.filter((id) => !stale.has(id));
  const fresh = run === undefined ? [] : runEntities(doc, run);
  for (const entity of fresh) {
    entities[entity.id] = entity;
    order.push(entity.id);
  }
  const { layers, layerOrder } = ensureLayerIds(
    doc.layers,
    doc.layerOrder,
    new Set(fresh.map((entity) => entity.layerId)),
    PIPING_LAYER_COLORS,
  );
  const entityIds = { ...piping.entityIds, [runId]: fresh.map((entity) => entity.id) };
  return {
    ...doc,
    entities,
    order,
    layers,
    layerOrder,
    selection: doc.selection.filter((id) => entities[id] !== undefined),
    plant: { ...doc.plant, piping: { ...piping, entityIds } },
  };
}

/** `doc` without run `runId` and without its display entities. */
export function withoutRun(doc: CadDocument, runId: string): CadDocument {
  const piping = getPiping(doc);
  const stale = new Set(piping.entityIds[runId] ?? []);
  const entities: Record<string, Entity> = {};
  for (const [id, entity] of Object.entries(doc.entities)) if (!stale.has(id)) entities[id] = entity;
  const { [runId]: removedRun, ...runs } = piping.runs;
  const { [runId]: removedIds, ...entityIds } = piping.entityIds;
  void removedRun;
  void removedIds;
  return {
    ...doc,
    entities,
    order: doc.order.filter((id) => !stale.has(id)),
    selection: doc.selection.filter((id) => !stale.has(id)),
    plant: { ...doc.plant, piping: { ...piping, runs, runOrder: piping.runOrder.filter((id) => id !== runId), entityIds } },
  };
}

const rawPiping = (raw: Record<string, unknown>): unknown => (isRecord(raw['plant']) ? raw['plant']['piping'] : undefined);

export const pipingDocument: DocumentExtension = {
  validate: (raw) => {
    const plant = raw['plant'];
    if (plant === undefined) return [];
    if (!isRecord(plant)) return ['plant must be an object'];
    return plant['piping'] === undefined ? [] : pipingErrors(plant['piping']);
  },
  derivedEntityIds: (doc) => new Set(Object.values(getPiping(doc).entityIds).flat()),
  restore: (raw) => {
    const saved = rawPiping(raw);
    if (saved === undefined || pipingErrors(saved).length > 0 || !isRecord(raw['entities']) || !Array.isArray(raw['order'])) return raw;
    const piping = saved as PipingModel;
    const layerSource = isRecord(raw['layers']) ? (raw['layers'] as CadDocument['layers']) : {};
    const layerOrder = Array.isArray(raw['layerOrder']) ? (raw['layerOrder'] as string[]) : [];
    const entities: Record<string, unknown> = { ...raw['entities'] };
    const order = [...(raw['order'] as string[])];
    const used = new Set<string>();
    const entityIds: Record<string, string[]> = {};
    for (const runId of piping.runOrder) {
      const run = piping.runs[runId];
      let fresh: Entity[];
      try {
        fresh = run === undefined ? [] : runEntities(raw as unknown as CadDocument, run);
      } catch {
        fresh = [];
      }
      entityIds[runId] = fresh.map((entity) => entity.id);
      for (const entity of fresh) {
        entities[entity.id] = entity;
        used.add(entity.layerId);
        if (!order.includes(entity.id)) order.push(entity.id);
      }
    }
    const layers = ensureLayerIds(layerSource, layerOrder, used, PIPING_LAYER_COLORS);
    const plant = raw['plant'] as Record<string, unknown>;
    return {
      ...raw,
      plant: { ...plant, piping: { ...piping, entityIds } },
      entities,
      order,
      layers: layers.layers,
      layerOrder: layers.layerOrder,
    };
  },
};

const sameEntity = (a: Entity | undefined, b: Entity | undefined): boolean =>
  a === b || (a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b));

/** Names the runs that derive in `previous` but no longer in `next` (a spec / catalogue edit that would break them). */
function brokenRuns(previous: CadDocument, next: CadDocument): string[] {
  return getPiping(next).runOrder.filter((id) => {
    const before = getPiping(previous).runs[id];
    const after = getPiping(next).runs[id];
    return before !== undefined && after !== undefined && deriveRun(previous, before).ok && !deriveRun(next, after).ok;
  });
}

/**
 * Run entities change only through piping commands (those replace `plant`); a spec or catalogue edit that would leave a run underivable is
 * refused (a spec change that would invalidate a run is refused atomically, 02 RTE §8).
 */
export const pipingDerivationGuard: DerivationGuard = {
  domain: 'piping',
  check(previous: CadDocument, next: CadDocument) {
    if (next.plant !== previous.plant) {
      const specEdited = next.plant?.spec !== previous.plant?.spec || next.plant?.catalog !== previous.plant?.catalog;
      if (!specEdited || next.plant?.piping !== previous.plant?.piping) return null;
      const broken = brokenRuns(previous, next);
      return broken.length === 0
        ? null
        : `it would leave pipe run(s) ${broken.join(', ')} without a derivable spec part (spec or catalogue edit). Fix the spec change, or delete_pipe_run first.`;
    }
    if (next.entities === previous.entities) return null;
    const ids = Object.values(getPiping(previous).entityIds).flat();
    const edited = ids.filter((id) => !sameEntity(previous.entities[id], next.entities[id]));
    if (edited.length === 0) return null;
    return (
      `it would edit the derived geometry of pipe part(s) ${edited.slice(0, 5).join(', ')}${edited.length > 5 ? ' ...' : ''}. ` +
      'Pipe runs change through the piping commands (route_pipe, auto_route_pipe, delete_pipe_run); derived geometry is read-only.'
    );
  },
};
