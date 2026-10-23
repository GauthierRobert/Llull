/**
 * Run display geometry is derived from `plant.piping` (02 RTE §2 "stored intent, derived parts"): one read-only entity per part of every run
 * (`routeParts.deriveRun` -> `geometry.partEntity`; ids `<runId>/<kind>-<k>`), omitted from saved files, re-derived on load and after every command
 * that changes what they derive from (`reconcile`), and protected by a derivation guard (architecture L8). The ids of a run's entities are kept in
 * `plant.piping.entityIds`; a run that no longer derives is marked `broken` and has no entities.
 */

import type { CadDocument, Entity } from '@core/model/types';
import type { PipeRun, PipingModel } from '@aec/plant/types';
import type { DerivationGuard } from '@core/commands/derivation';
import type { DocumentExtension } from '@core/plugins/plugin';
import { isRecord } from '@lib/isRecord';
import { ensureLayerIds } from '../../shared/derived';
import { partEntity, PIPING_LAYER_COLORS } from './geometry';
import { getPiping } from './model';
import { portOfRef } from './ports';
import { deriveRun } from './routeParts';
import { pipingErrors } from './validate';

interface RunState {
  readonly entities: Entity[];
  readonly broken?: { readonly code: string; readonly reason: string };
}

/** The entities of `run` in route order, or why it does not derive (unknown spec, missing or moved port, short leg ...). */
function runState(doc: CadDocument, run: PipeRun): RunState {
  const line = getPiping(doc).lines[run.lineId];
  const derived = deriveRun(doc, run);
  if (!derived.ok) return { entities: [], broken: { code: derived.code, reason: derived.message } };
  return { entities: line === undefined ? [] : derived.parts.flatMap((part) => partEntity(part, line) ?? []) };
}

const sameBroken = (a: PipeRun['broken'], b: PipeRun['broken']): boolean => a?.code === b?.code && a?.reason === b?.reason;

/** `run` marked broken, or with the mark cleared. */
function marked(run: PipeRun, broken: RunState['broken']): PipeRun {
  const { broken: previous, ...rest } = run;
  void previous;
  return broken === undefined ? rest : { ...rest, broken };
}

/** `doc` with the display entities of run `runId` rebuilt (the old ones removed), `entityIds` updated and the run's `broken` mark set or cleared. */
export function withRunEntities(doc: CadDocument, runId: string): CadDocument {
  const piping = getPiping(doc);
  const run = piping.runs[runId];
  const stale = new Set(piping.entityIds[runId] ?? []);
  const entities: Record<string, Entity> = {};
  for (const [id, entity] of Object.entries(doc.entities)) if (!stale.has(id)) entities[id] = entity;
  const order = doc.order.filter((id) => !stale.has(id));
  const state: RunState = run === undefined ? { entities: [] } : runState(doc, run);
  for (const entity of state.entities) {
    entities[entity.id] = entity;
    order.push(entity.id);
  }
  const { layers, layerOrder } = ensureLayerIds(
    doc.layers,
    doc.layerOrder,
    new Set(state.entities.map((entity) => entity.layerId)),
    PIPING_LAYER_COLORS,
  );
  const entityIds = { ...piping.entityIds, [runId]: state.entities.map((entity) => entity.id) };
  const runs =
    run === undefined || sameBroken(run.broken, state.broken) ? piping.runs : { ...piping.runs, [runId]: marked(run, state.broken) };
  return {
    ...doc,
    entities,
    order,
    layers,
    layerOrder,
    selection: doc.selection.filter((id) => entities[id] !== undefined),
    plant: { ...doc.plant, piping: { ...piping, runs, entityIds } },
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

/** Runs whose derivation depends on something this command changed: the spec / catalogues, their line, a tie-in or the port of a nozzle. */
function affectedRuns(previous: CadDocument, next: CadDocument): string[] {
  const piping = getPiping(next);
  const before = getPiping(previous);
  const specsChanged = next.plant?.spec !== previous.plant?.spec || next.plant?.catalog !== previous.plant?.catalog;
  const buildingChanged = next.building !== previous.building;
  return piping.runOrder.filter((id) => {
    const run = piping.runs[id];
    // A run the command itself created or changed was derived by that command.
    if (run === undefined || run !== before.runs[id]) return false;
    if (specsChanged || piping.lines[run.lineId] !== before.lines[run.lineId]) return true;
    return [run.start.ref, run.end.ref].some((ref) => {
      if (ref === undefined) return false;
      if (ref.kind === 'tieIn') return piping.tieIns[ref.id] !== before.tieIns[ref.id];
      return ref.kind === 'nozzle' && buildingChanged && JSON.stringify(portOfRef(previous, ref)) !== JSON.stringify(portOfRef(next, ref));
    });
  });
}

/** Re-derives the runs a command made stale (spec, catalogue, line, tie-in or equipment nozzle edits) and reports the runs that no longer derive. */
function reconcile(previous: CadDocument, next: CadDocument): { document: CadDocument; notes: string[] } {
  if (getPiping(next).runOrder.length === 0) return { document: next, notes: [] };
  const affected = affectedRuns(previous, next);
  if (affected.length === 0) return { document: next, notes: [] };
  const document = affected.reduce(withRunEntities, next);
  const runs = getPiping(document).runs;
  const broken = affected.flatMap((id) => {
    const mark = runs[id]?.broken;
    return mark === undefined ? [] : [`${id} (${mark.code}: ${mark.reason})`];
  });
  return {
    document,
    notes: [
      `piping: re-derived ${affected.length} run(s)${broken.length === 0 ? '' : `; now broken, parts removed: ${broken.join('; ')}`}.`,
    ],
  };
}

export const pipingDocument: DocumentExtension = {
  validate: (raw) => {
    const plant = raw['plant'];
    if (plant === undefined) return [];
    if (!isRecord(plant)) return ['plant must be an object'];
    return plant['piping'] === undefined ? [] : pipingErrors(plant['piping']);
  },
  derivedEntityIds: (doc) => new Set(Object.values(getPiping(doc).entityIds).flat()),
  reconcile,
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
    const runs: Record<string, PipeRun> = {};
    for (const runId of piping.runOrder) {
      const run = piping.runs[runId] as PipeRun;
      let state: RunState;
      try {
        state = runState(raw as unknown as CadDocument, run);
      } catch {
        state = {
          entities: [],
          broken: { code: 'RTE_SPEC_UNKNOWN', reason: 'the spec, catalogues or ports of the run could not be read' },
        };
      }
      entityIds[runId] = state.entities.map((entity) => entity.id);
      runs[runId] = marked(run, state.broken);
      for (const entity of state.entities) {
        entities[entity.id] = entity;
        used.add(entity.layerId);
        if (!order.includes(entity.id)) order.push(entity.id);
      }
    }
    const layers = ensureLayerIds(layerSource, layerOrder, used, PIPING_LAYER_COLORS);
    const plant = raw['plant'] as Record<string, unknown>;
    return {
      ...raw,
      plant: { ...plant, piping: { ...piping, runs, entityIds } },
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
 * refused (a spec change that would invalidate a run is refused atomically, 02 RTE §8). Benign spec edits are not refused: `reconcile` re-derives.
 */
export const pipingDerivationGuard: DerivationGuard = {
  domain: 'piping',
  check(previous: CadDocument, next: CadDocument) {
    if (next.plant !== previous.plant) {
      const specEdited = next.plant?.spec !== previous.plant?.spec || next.plant?.catalog !== previous.plant?.catalog;
      if (!specEdited) return null;
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
