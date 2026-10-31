/**
 * Decomposition of pipe runs and distribution ports in IFC4X3_ADD2 (plant 08 DAT §5.6, TR-DAT-22): a pipe run of n straights becomes n IfcPipeSegment
 * (RIGIDSEGMENT, the extruded circle of each straight) and n-1 IfcPipeFitting BEND at the interior vertices (no body); each gets an inlet (SINK) and an
 * outlet (SOURCE) IfcDistributionPort nested in it (one IfcRelNests per product), consecutive ports meet in one IfcRelConnectsPorts (RelatingPort = the
 * SOURCE), and the ends of a process line meet the nozzles inferred on the equipment its from / to names. Ports that no connection reaches are open.
 * @invariant pure; GlobalId seeds `<pipe>:seg:<k>`, `<pipe>:bend:<k>`, `<product seed>:in|out`, `<equipment>:nozzle:<pipe>:from|to`
 */

import type { BuildingLevel, PipeElement } from '@aec/building/types';
import type { CadDocument, Vec3 } from '@core/model/types';
import { atLevel } from '@aec/industrial/evaluate';
import { len3, sub3 } from '@lib/vec3';
import { inferredNozzles } from '../../plant/data/plantReports/inferNozzles';
import { type PlantIfcObject } from '../../plant/data/view';
import type { Exported } from './ifcElementExport';
import { addNamedPset, countPredefined, type PlantIfcRun } from './ifcPlant';
import { sweptSolids } from './ifcIndustrialExport';
import { type Context, circleProfile, ifcReal, ifcString, placement, shape } from './ifcStep';

type Flow = 'SOURCE' | 'SINK' | 'SOURCEANDSINK';

interface Port {
  readonly ref: string;
  readonly seed: string;
}

interface EndPort extends Port {
  readonly end: 'start' | 'end';
  /** World point (document units) for the nozzle match. */
  readonly world: Vec3;
  readonly lineId: string | null;
  readonly flow: Flow;
}

export interface PortState {
  portCount: number;
  connectionCount: number;
  readonly connected: Set<string>;
  readonly endPorts: EndPort[];
  /** Equipment element id -> product reference and the placement of its level. */
  readonly equipment: Map<string, { readonly ref: string; readonly storeyPlacement: string; readonly level: BuildingLevel }>;
}

export const newPortState = (): PortState => ({
  portCount: 0,
  connectionCount: 0,
  connected: new Set(),
  endPorts: [],
  equipment: new Map(),
});

const length = (context: Context, value: number): string => `IFCPOSITIVELENGTHMEASURE(${ifcReal(context.mm(value))})`;
const lengthMm = (value: number): string => `IFCPOSITIVELENGTHMEASURE(${ifcReal(value)})`;

function portPset(context: Context, port: Port, dn: number | undefined): void {
  addNamedPset(context, { seed: port.seed, ref: port.ref }, 'Pset_DistributionPortTypePipe', [
    ...(dn === undefined ? [] : [`IFCPROPERTYSINGLEVALUE('NominalDiameter',$,${length(context, dn)},$)`]),
    `IFCPROPERTYSINGLEVALUE('ConnectionType',$,IFCLABEL('NOTDEFINED'),$)`,
  ]);
}

/** One IfcDistributionPort placed at `point` (mm, relative to the storey). */
function addPort(
  context: Context,
  state: PortState,
  storeyPlacement: string,
  seed: string,
  name: string,
  flow: Flow,
  point: Vec3,
  dn: number | undefined,
  description: string | null = null,
): Port {
  const local = placement(context, storeyPlacement, point[0], point[1], point[2]);
  const ref = context.writer.add(
    `IFCDISTRIBUTIONPORT('${context.guid(seed)}',$,${ifcString(name)},${description === null ? '$' : ifcString(description)},$,${local},$,.${flow}.,.PIPE.,.USERDEFINED.)`,
  );
  state.portCount += 1;
  const port = { ref, seed };
  portPset(context, port, dn);
  return port;
}

function connect(context: Context, state: PortState, relating: Port, related: Port): void {
  context.writer.add(
    `IFCRELCONNECTSPORTS('${context.guid(`${relating.seed}:${related.seed}:conn`)}',$,$,$,${relating.ref},${related.ref},$)`,
  );
  state.connectionCount += 1;
  state.connected.add(relating.ref);
  state.connected.add(related.ref);
}

function nest(context: Context, seed: string, product: string, ports: readonly Port[]): void {
  context.writer.add(`IFCRELNESTS('${context.guid(`${seed}:nests`)}',$,$,$,${product},(${ports.map((port) => port.ref).join(',')}))`);
}

export interface PipeIfcInput {
  /** Prefix of Name and Tag of the products. */
  readonly base: string;
  /** Plant object of the process line the pipe belongs to (its system and flow direction), or null. */
  readonly line: PlantIfcObject | null;
  /** Hierarchy container (spatial element reference) of the products, or null for the storey. */
  readonly container: string | null;
}

/** The pipe's points with consecutive duplicates removed. */
function distinct(points: readonly Vec3[]): Vec3[] {
  const kept: Vec3[] = [];
  for (const point of points) {
    const last = kept.at(-1);
    if (last === undefined || len3(sub3(point, last)) > 1e-9) kept.push(point);
  }
  return kept;
}

export function exportPipeProducts(
  context: Context,
  run: PlantIfcRun,
  state: PortState,
  pipe: PipeElement,
  level: BuildingLevel,
  storeyPlacement: string,
  input: PipeIfcInput,
): Exported[] {
  const { writer, mm } = context;
  const points = distinct(pipe.points);
  if (points.length < 2) return [];
  const mm3 = ([x, y, z]: Vec3): Vec3 => [mm(x), mm(y), mm(z)];
  const circle = circleProfile(context, mm(pipe.diameter) / 2);
  const local = placement(context, storeyPlacement, 0, 0, 0);
  const description = [pipe.line, pipe.service].filter(Boolean).join(' ');
  const flowIn: Flow = input.line?.object.properties['bidirectional'] === true ? 'SOURCEANDSINK' : 'SINK';
  const flowOut: Flow = flowIn === 'SINK' ? 'SOURCE' : 'SOURCEANDSINK';
  const lineId = input.line?.object.id ?? null;
  const system = lineId === null ? undefined : run.systems.get(lineId);
  const exported: Exported[] = [];
  let previous: Port | null = null;
  const addProduct = (ref: string, seed: string, inPoint: Vec3, outPoint: Vec3, first: boolean, last: boolean): void => {
    exported.push({ ref, material: pipe.material });
    system?.members.push(ref);
    if (!run.options.ports) return;
    const inlet = addPort(context, state, storeyPlacement, `${seed}:in`, 'In', flowIn, inPoint, pipe.dn);
    const outlet = addPort(context, state, storeyPlacement, `${seed}:out`, 'Out', flowOut, outPoint, pipe.dn);
    nest(context, seed, ref, [inlet, outlet]);
    if (previous !== null) connect(context, state, previous, inlet);
    if (first) state.endPorts.push({ ...inlet, end: 'start', world: atLevel(level, points[0] as Vec3), lineId, flow: flowIn });
    if (last) state.endPorts.push({ ...outlet, end: 'end', world: atLevel(level, points.at(-1) as Vec3), lineId, flow: flowOut });
    previous = outlet;
  };
  const straights = points.length - 1;
  for (let k = 0; k < straights; k++) {
    const start = points[k] as Vec3;
    const end = points[k + 1] as Vec3;
    const seed = `${pipe.id}:seg:${k}`;
    const name = `${input.base}-S${k + 1}`;
    const solids = sweptSolids(context, circle, [mm3(start), mm3(end)]);
    const ref = writer.add(
      `IFCPIPESEGMENT('${context.guid(seed)}',$,${ifcString(name)},${ifcString(description)},$,${local},${shape(context, solids)},${ifcString(name)},.RIGIDSEGMENT.)`,
    );
    countPredefined(run, 'IFCPIPESEGMENT', 'RIGIDSEGMENT');
    const lengthMmValue = mm(len3(sub3(end, start)));
    addNamedPset(context, { seed, ref }, 'Pset_PipeSegmentTypeCommon', [
      ...(pipe.dn === undefined ? [] : [`IFCPROPERTYSINGLEVALUE('NominalDiameter',$,${length(context, pipe.dn)},$)`]),
      `IFCPROPERTYSINGLEVALUE('OuterDiameter',$,${length(context, pipe.diameter)},$)`,
      `IFCPROPERTYSINGLEVALUE('Length',$,${lengthMm(lengthMmValue)},$)`,
    ]);
    addProduct(ref, seed, mm3(start), mm3(end), k === 0, k === straights - 1);
    if (k === straights - 1) break;
    const vertex = mm3(end);
    const bendSeed = `${pipe.id}:bend:${k + 1}`;
    const bendName = `${input.base}-B${k + 1}`;
    const bend = writer.add(
      `IFCPIPEFITTING('${context.guid(bendSeed)}',$,${ifcString(bendName)},${ifcString(description)},$,${placement(context, storeyPlacement, ...vertex)},$,${ifcString(bendName)},.BEND.)`,
    );
    countPredefined(run, 'IFCPIPEFITTING', 'BEND');
    addProduct(bend, bendSeed, vertex, vertex, false, false);
  }
  return exported.map((item) => (input.container === null ? item : { ...item, container: input.container }));
}

/** Inferred nozzle ports of the equipment (IfcRelNests) and their connections to the pipe ends; call once after every element is exported. */
export function finishNozzles(context: Context, doc: CadDocument, state: PortState): void {
  const byEquipment = new Map<string, ReturnType<typeof inferredNozzles>>();
  for (const nozzle of inferredNozzles(doc)) {
    byEquipment.set(nozzle.equipment.id, [...(byEquipment.get(nozzle.equipment.id) ?? []), nozzle]);
  }
  for (const [equipmentId, nozzles] of byEquipment) {
    const target = state.equipment.get(equipmentId);
    if (target === undefined) continue;
    const ports: Port[] = [];
    for (const nozzle of nozzles) {
      const seed = `${equipmentId}:nozzle:${nozzle.line.id}:${nozzle.end}`;
      const bidirectional = nozzle.line.properties['bidirectional'] === true;
      const flow: Flow = bidirectional ? 'SOURCEANDSINK' : nozzle.flowDirection;
      const point = nozzle.point;
      const z = point[2] - target.level.elevation;
      const dn = nozzle.shape?.dn ?? undefined;
      const port = addPort(
        context,
        state,
        target.storeyPlacement,
        seed,
        nozzle.name,
        flow,
        [context.mm(point[0]), context.mm(point[1]), context.mm(z)],
        dn,
        'inferred from line from/to',
      );
      ports.push(port);
      const pipeEnd = state.endPorts.find(
        (candidate) =>
          candidate.lineId === nozzle.line.id &&
          candidate.end === (nozzle.end === 'from' ? 'start' : 'end') &&
          len3(sub3(candidate.world, point)) <= 1e-6 * Math.max(1, len3(point)),
      );
      if (pipeEnd === undefined) continue;
      if (nozzle.end === 'from') connect(context, state, port, pipeEnd);
      else connect(context, state, pipeEnd, port);
    }
    nest(context, `${equipmentId}:nozzles`, target.ref, ports);
  }
}
