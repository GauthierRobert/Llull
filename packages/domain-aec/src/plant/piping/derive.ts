/**
 * Run display geometry is derived from `plant.piping` (02 RTE §2 "stored intent, derived parts"): one read-only mesh per run (id = run
 * id, layer P-PIPE), omitted from saved files, re-derived on load and protected by a derivation guard (architecture L8).
 */

import type { CadDocument, Entity, MeshData, MeshSolidEntity } from '@core/model/types';
import type { PipeRun, PipingModel } from '@aec/plant/types';
import type { Vec3 } from '@core/model/vectors';
import type { DerivationGuard } from '@core/commands/derivation';
import type { DocumentExtension } from '@core/plugins/plugin';
import { circlePolygon } from '@lib/arc';
import { isRecord } from '@lib/isRecord';
import { sweepMesh } from '../../shared/mesh';
import { ensureLayerIds } from '../../shared/derived';
import { pipeOutsideDiameter } from './sizes';
import { getPiping } from './model';
import { pipingErrors } from './validate';

export const PIPE_LAYER_ID = 'layer-P-PIPE';
const PIPE_COLOR = '#2f9c8f';
const LAYER_COLORS: ReadonlyMap<string, string> = new Map([[PIPE_LAYER_ID, PIPE_COLOR]]);
const SEGMENTS = 16;

export const runPoints = (run: PipeRun): Vec3[] => [run.start.point, ...run.pis, run.end.point];

/** Tube of the run's OD swept along every leg, as one mesh (null when the line size has no OD or every leg is degenerate). */
function runMesh(piping: PipingModel, run: PipeRun): MeshData | null {
  const line = piping.lines[run.lineId];
  const diameter = line === undefined ? null : pipeOutsideDiameter(line.dn);
  if (diameter === null) return null;
  const circle = circlePolygon([0, 0], diameter / 2, SEGMENTS);
  const positions: number[] = [];
  const indices: number[] = [];
  const points = runPoints(run);
  for (let leg = 0; leg + 1 < points.length; leg++) {
    const mesh = sweepMesh(circle, [], points[leg] as Vec3, points[leg + 1] as Vec3, 0, 1);
    if (mesh === null) continue;
    const offset = positions.length / 3;
    positions.push(...mesh.positions);
    for (const index of mesh.indices) indices.push(index + offset);
  }
  return indices.length === 0 ? null : { positions, indices };
}

function runEntity(piping: PipingModel, run: PipeRun, layerId: string): MeshSolidEntity | null {
  const mesh = runMesh(piping, run);
  if (mesh === null) return null;
  const line = piping.lines[run.lineId];
  return {
    id: run.id,
    kind: 'mesh',
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    layerId,
    color: PIPE_COLOR,
    mesh,
    name: `Pipe run ${run.id}${line === undefined ? '' : ` ${line.lineNumber}`}`,
    tags: [`piping:${run.lineId}`],
  };
}

/** `doc` with the derived entity of `run` (re)built and the P-PIPE layer present. */
export function withRunEntity(doc: CadDocument, run: PipeRun): CadDocument {
  const entity = runEntity(getPiping(doc), run, PIPE_LAYER_ID);
  if (entity === null) return doc;
  const { layers, layerOrder } = ensureLayerIds(doc.layers, doc.layerOrder, [PIPE_LAYER_ID], LAYER_COLORS);
  const order = doc.order.includes(run.id) ? doc.order : [...doc.order, run.id];
  return { ...doc, layers, layerOrder, entities: { ...doc.entities, [run.id]: entity }, order };
}

const rawPiping = (raw: Record<string, unknown>): unknown => (isRecord(raw['plant']) ? raw['plant']['piping'] : undefined);

export const pipingDocument: DocumentExtension = {
  validate: (raw) => {
    const plant = raw['plant'];
    if (plant === undefined) return [];
    if (!isRecord(plant)) return ['plant must be an object'];
    return plant['piping'] === undefined ? [] : pipingErrors(plant['piping']);
  },
  derivedEntityIds: (doc) => new Set(getPiping(doc).runOrder),
  restore: (raw) => {
    const saved = rawPiping(raw);
    if (saved === undefined || pipingErrors(saved).length > 0 || !isRecord(raw['entities']) || !Array.isArray(raw['order'])) return raw;
    const piping = saved as PipingModel;
    const layerSource = isRecord(raw['layers']) ? (raw['layers'] as CadDocument['layers']) : {};
    const layerOrder = Array.isArray(raw['layerOrder']) ? (raw['layerOrder'] as string[]) : [];
    const layers = ensureLayerIds(layerSource, layerOrder, [PIPE_LAYER_ID], LAYER_COLORS);
    const entities: Record<string, unknown> = { ...raw['entities'] };
    const order = [...(raw['order'] as string[])];
    for (const runId of piping.runOrder) {
      const run = piping.runs[runId];
      const entity = run === undefined ? null : runEntity(piping, run, PIPE_LAYER_ID);
      if (entity === null) continue;
      entities[runId] = entity;
      if (!order.includes(runId)) order.push(runId);
    }
    return { ...raw, entities, order, layers: layers.layers, layerOrder: layers.layerOrder };
  },
};

const sameEntity = (a: Entity | undefined, b: Entity | undefined): boolean =>
  a === b || (a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b));

/** Run meshes change only through piping commands (those replace `plant`). */
export const pipingDerivationGuard: DerivationGuard = {
  domain: 'piping',
  check(previous: CadDocument, next: CadDocument) {
    if (next.plant !== previous.plant || next.entities === previous.entities) return null;
    const edited = getPiping(previous).runOrder.filter((id) => !sameEntity(previous.entities[id], next.entities[id]));
    if (edited.length === 0) return null;
    return (
      `it would edit the derived geometry of pipe run(s) ${edited.join(', ')}. ` +
      'Pipe runs change through the piping commands (auto_route_pipe, delete_pipe_run); derived geometry is read-only.'
    );
  },
};
