/**
 * Film coefficient h(T) (a `{ table }` film BC) as a tied gap conductance to a prescribed-temperature sink. CalculiX has no temperature table
 * on `*FILM` (only the `film.f` user subroutine), but `*GAP CONDUCTANCE` is tabulated in the MEAN temperature of the two contact faces. A tied
 * contact between a coincident dummy wedge layer (slave) whose nodes are held at the sink temperature and the face (master) therefore carries
 * q = h_gap((Ts + Tsink) / 2) (Ts - Tsink); writing the table at Tm = (Ts + Tsink) / 2 gives q = h(Ts) (Ts - Tsink) exactly.
 * STEADY CASES ONLY (refused for heat_transient in `bcModel`): measured on ccx 2.21 (1D slab, h = 100 + 2 T) 73.54160 degC against the closed form
 * 73.54157 on three meshes, but in a transient the surface temperature rise came out 2-8 % off a constant `*FILM`. The dummy layer must be the SLAVE: with the face as
 * slave and the unconnected wedge faces as master ccx 2.21 left 2-4 K error on a coarse mesh (non-uniform face temperatures).
 */

import type { ThermalBcRecord, ThermalSetup } from '@core/model/analysis';
import type { Vec3 } from '@core/model/vectors';
import { siToSystem } from './thermalUnits';
import { safeName, type DeckContext, type DeckRefusal } from '../decks/context';
import { commentText, row } from '../decks/format';
import { faceNodes, indexMesh, type MeshElement, type MeshIndex } from './meshGeometry';
import { inScale } from './quantities';
import { cross3, dot3, sub3 } from '@lib/vec3';

export interface SinkBlocks {
  /** Model-definition lines (dummy nodes, elements, material, sets, contact pair), to sit before the step. */
  readonly model: readonly string[];
  /** Step lines: the prescribed sink temperatures. */
  readonly step: readonly string[];
}

const FILM_SINK_MATERIAL = 'FILM_SINK';

/** Local corner (1-based) of a C3D4 / C3D10 element opposite to each CalculiX face label. */
const OPPOSITE: Readonly<Record<number, number>> = { 1: 4, 2: 3, 3: 1, 4: 2 };

const add = (a: Vec3, b: Vec3, scale: number): Vec3 => [a[0] + scale * b[0], a[1] + scale * b[1], a[2] + scale * b[2]];
const mean = (points: readonly Vec3[]): Vec3 => [
  points.reduce((sum, p) => sum + p[0], 0) / points.length,
  points.reduce((sum, p) => sum + p[1], 0) / points.length,
  points.reduce((sum, p) => sum + p[2], 0) / points.length,
];

const refusal = (code: string, message: string, ids: readonly string[]): DeckRefusal => ({ code, message, ids });

const maxOf = (values: Iterable<number>): number => {
  let max = 0;
  for (const value of values) if (value > max) max = value;
  return max;
};

interface Corner {
  readonly element: MeshElement;
  readonly nodes: readonly number[];
  readonly label: number;
}

/**
 * Dummy wedge (C3D6 for a 3-node face, C3D15 for a 6-node face) lying on the outside of a face, as node coordinates in the order of the
 * element type, with positive volume and face 1 coincident with the real face (outward normal pointing into the part).
 * @invariant thickness = half the square root of the face area; the face must have non-zero area
 */
function wedgeCoordinates(index: MeshIndex, face: Corner): Vec3[] | null {
  const at = (node: number | undefined): Vec3 | null => (node === undefined ? null : (index.coordinates.get(node) ?? null));
  const corners = face.nodes.slice(0, 3).map(at);
  const opposite = at(face.element.nodes[(OPPOSITE[face.label] ?? 1) - 1]);
  const [p0, p1, p2] = corners;
  if (p0 === null || p0 === undefined || p1 === null || p1 === undefined || p2 === null || p2 === undefined || opposite === null)
    return null;
  let normal = cross3(sub3(p1, p0), sub3(p2, p0));
  const doubleArea = Math.hypot(...normal);
  if (!(doubleArea > 0)) return null;
  const unit: Vec3 = [normal[0] / doubleArea, normal[1] / doubleArea, normal[2] / doubleArea];
  const outward = dot3(unit, sub3(mean([p0, p1, p2]), opposite)) > 0 ? 1 : -1;
  normal = [unit[0] * outward, unit[1] * outward, unit[2] * outward];
  const thickness = 0.5 * Math.sqrt(doubleArea / 2);
  // face order a, b, c with (b - a) x (c - a) . n > 0; a face stored the other way swaps b and c (and the mid-side nodes with them)
  const swap = dot3(cross3(sub3(p1, p0), sub3(p2, p0)), normal) < 0;
  const order = swap ? [0, 2, 1] : [0, 1, 2];
  const [a, b, c] = order.map((i) => corners[i]);
  if (a === null || a === undefined || b === null || b === undefined || c === null || c === undefined) return null;
  const up = (p: Vec3): Vec3 => add(p, normal, thickness);
  const bottom: Vec3[] = [a, b, c];
  if (face.nodes.length === 3) return [...bottom, ...bottom.map(up)];
  const mids = face.nodes.slice(3).map(at);
  const [ab, bc, ca] = swap ? [mids[2], mids[1], mids[0]] : mids;
  if (ab == null || bc == null || ca == null) return null;
  const midBottom = [ab, bc, ca];
  return [...bottom, ...bottom.map(up), ...midBottom, ...midBottom.map(up), ...bottom.map((p) => add(p, normal, thickness / 2))];
}

/**
 * Sink layer, contact pair and sink temperatures of every film BC with an h(T) table.
 * @failure a BC without faces in the mesh, or a degenerate face -> FEA_TARGET_UNRESOLVED / FEA_PART_INVALID (ids: the BC)
 */
export function filmSinkBlocks(ctx: DeckContext, thermal: ThermalSetup): SinkBlocks | DeckRefusal | null {
  const records: ThermalBcRecord[] = thermal.bcOrder.flatMap((id) => {
    const record = thermal.bcs[id];
    return record !== undefined && record.bc.kind === 'film' && !('value' in record.bc.filmCoefficient) ? [record] : [];
  });
  if (records.length === 0) return null;
  const index = indexMesh(ctx.mesh);
  let lastNode = maxOf(ctx.mesh.nodes.map(([id]) => id));
  let lastElement = maxOf(ctx.mesh.blocks.flatMap((block) => block.elements.map((element) => element[0] ?? 0)));
  const scale = thermal.temperatureScale;
  const model: string[] = [`*MATERIAL, NAME=${FILM_SINK_MATERIAL}`, '*CONDUCTIVITY', '1'];
  const step: string[] = [];
  for (const record of records) {
    const bc = record.bc;
    if (bc.kind !== 'film' || 'value' in bc.filmCoefficient || !('points' in bc.filmCoefficient.table)) continue;
    const faces = ctx.faces(`B_${record.id}`);
    const unresolved = refusal('FEA_TARGET_UNRESOLVED', `thermal BC '${record.id}' (${record.name}) has no faces in the mesh`, [record.id]);
    if (faces.length === 0) return unresolved;
    const base = safeName(record.id).toUpperCase();
    const names = { face: `FQ_${base}`, sink: `FM_${base}`, interaction: `FI_${base}`, nodes: `FN_${base}`, elements: `FS_${base}` };
    const sink = inScale(bc.sinkTemperature, scale);
    const nodeLines: string[] = [];
    const wedges = new Map<'C3D6' | 'C3D15', string[]>();
    const sinkFaces: string[] = [];
    const sinkNodes: number[] = [];
    for (const [elementId, label] of faces) {
      const element = index.elements.get(elementId);
      const nodes = element === undefined ? null : faceNodes(element, label);
      const coordinates = element === undefined || nodes === null ? null : wedgeCoordinates(index, { element, nodes, label });
      if (coordinates === null)
        return refusal('FEA_PART_INVALID', `thermal BC '${record.id}': face ${label} of element ${elementId} has no area`, [record.id]);
      const ids = coordinates.map((point) => {
        lastNode += 1;
        nodeLines.push(row(lastNode, ...point));
        sinkNodes.push(lastNode);
        return lastNode;
      });
      lastElement += 1;
      const type = coordinates.length === 6 ? 'C3D6' : 'C3D15';
      wedges.set(type, [...(wedges.get(type) ?? []), row(lastElement, ...ids)]);
      sinkFaces.push(row(lastElement, 'S1'));
    }
    model.push(`** ${commentText(record.id)} ${commentText(record.name)} (film h(T) table: tied gap conductance to a sink at ${sink})`);
    model.push(`*NODE, NSET=${names.nodes}`, ...nodeLines);
    for (const [type, lines] of wedges) model.push(`*ELEMENT, TYPE=${type}, ELSET=${names.elements}`, ...lines);
    model.push(`*SOLID SECTION, ELSET=${names.elements}, MATERIAL=${FILM_SINK_MATERIAL}`);
    model.push(`*SURFACE, NAME=${names.sink}, TYPE=ELEMENT`, ...sinkFaces);
    model.push(`*SURFACE, NAME=${names.face}, TYPE=ELEMENT`, ...faces.map(([element, face]) => row(element, `S${face}`)));
    model.push(`*SURFACE INTERACTION, NAME=${names.interaction}`, '*SURFACE BEHAVIOR, PRESSURE-OVERCLOSURE=TIED', '*GAP CONDUCTANCE');
    for (const [temperature, h] of bc.filmCoefficient.table.points)
      model.push(row(siToSystem('film', h, ctx.unitSystem), 0, (temperature + sink) / 2));
    model.push(`*CONTACT PAIR, INTERACTION=${names.interaction}, TYPE=SURFACE TO SURFACE`, row(names.sink, names.face));
    model.push('*INITIAL CONDITIONS, TYPE=TEMPERATURE', row(names.nodes, sink));
    step.push(`** ${commentText(record.id)} sink of the film h(T) table`, '*BOUNDARY', row(names.nodes, 11, 11, sink));
  }
  return { model, step };
}
