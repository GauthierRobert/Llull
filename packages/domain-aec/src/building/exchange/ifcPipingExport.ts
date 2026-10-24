/**
 * IFC export of spec-driven pipe runs (02 RTE §6, hand-off to 08): every derived part becomes an IfcPipeSegment (pipe piece), an IfcPipeFitting (BEND
 * elbow / bend, JUNCTION tee / olet, TRANSITION reducer, CONNECTOR flange / gasket, OBSTRUCTION cap) or an IfcValve, with the body of its display
 * geometry (the same revolved profiles `route_pipe` draws, so the IFC, the viewport and the STEP export agree), one IfcDistributionPort per part port
 * nested in it (IfcRelNests), IfcRelConnectsPorts between the ports that meet (from the connectivity graph), and one IfcDistributionSystem per line
 * (IfcRelAssignsToGroup). Bolt sets have no body and stub-ins no component (counted in the summary). Coordinates are the plant's world mm.
 * @invariant pure; the same document gives the same entities in the same order; broken runs are skipped and named
 */

import type { CadDocument, RevolutionEntity, Vec3 } from '@core/model/types';
import type { PartPort, RoutedPart } from '@aec/plant/types';
import { applyEulerXYZ } from '@lib/eulerRotation';
import { len3, sub3 } from '@lib/vec3';
import { buildGraph, selectRuns } from '../../plant/piping/graph';
import { partEntities } from '../../plant/piping/geometryInline';
import { getPiping } from '../../plant/piping/model';
import {
  type Context,
  addPropertySet,
  circleProfile,
  direction,
  ifcReal,
  ifcString,
  point2,
  point3,
  polygonProfile,
  shape,
} from './ifcStep';

export interface PipingIfc {
  /** Spatial-structure children: every pipe product (segments, fittings, valves). */
  readonly products: readonly string[];
  readonly productCount: number;
  readonly portCount: number;
  readonly connectionCount: number;
  readonly systemCount: number;
  /** Parts without a product: bolt sets and stub-ins. */
  readonly bodiless: number;
  /** Runs that do not derive. */
  readonly brokenRuns: readonly string[];
}

const mm3 = (value: Vec3): Vec3 => [value[0], value[1], value[2]];

/** Local frame of an entity: its world X and Z axes (the Euler angles of the entity applied to the unit vectors). */
function frameOf(entity: RevolutionEntity): { origin: Vec3; x: Vec3; z: Vec3 } {
  const origin: Vec3 = [0, 0, 0];
  return {
    origin: mm3(entity.position),
    x: applyEulerXYZ([1, 0, 0], origin, entity.rotation),
    z: applyEulerXYZ([0, 0, 1], origin, entity.rotation),
  };
}

const isCircle = (points: ReadonlyArray<readonly [number, number]>): { centre: [number, number]; radius: number } | null => {
  if (points.length < 12) return null;
  const centre: [number, number] = [
    points.reduce((sum, p) => sum + p[0], 0) / points.length,
    points.reduce((sum, p) => sum + p[1], 0) / points.length,
  ];
  const radii = points.map((p) => Math.hypot(p[0] - centre[0], p[1] - centre[1]));
  const radius = radii[0] ?? 0;
  return radii.every((r) => Math.abs(r - radius) < 1e-6 * Math.max(1, radius)) ? { centre, radius } : null;
};

/** A rectangle [0, r] x [y0, y1] given as a closed profile (a straight round body), else null. */
const cylinderOf = (points: ReadonlyArray<readonly [number, number]>): { radius: number; from: number; to: number } | null => {
  if (points.length !== 4) return null;
  const xs = [...new Set(points.map((p) => p[0]))].sort((a, b) => a - b);
  const ys = [...new Set(points.map((p) => p[1]))].sort((a, b) => a - b);
  return xs.length === 2 && xs[0] === 0 && ys.length === 2 && (xs[1] as number) > 0
    ? { radius: xs[1] as number, from: ys[0] as number, to: ys[1] as number }
    : null;
};

/** IFC swept solid of a revolution entity: a round body becomes an extrusion, a revolved circle an exact torus segment, anything else a revolved polygon. */
function solidOf(context: Context, entity: RevolutionEntity): string {
  const { writer } = context;
  const frame = frameOf(entity);
  const full = entity.angle >= 2 * Math.PI - 1e-9;
  const round = full ? cylinderOf(entity.profile) : null;
  if (round !== null) {
    const base: Vec3 = [
      frame.origin[0] + frame.z[0] * round.from,
      frame.origin[1] + frame.z[1] * round.from,
      frame.origin[2] + frame.z[2] * round.from,
    ];
    const axes = writer.add(
      `IFCAXIS2PLACEMENT3D(${point3(context, ...base)},${direction(context, frame.z)},${direction(context, frame.x)})`,
    );
    return writer.add(
      `IFCEXTRUDEDAREASOLID(${circleProfile(context, round.radius)},${axes},${context.zAxis},${ifcReal(round.to - round.from)})`,
    );
  }
  // Profile plane: X' = entity X, Y' = entity axis, Z' = X' x Y' (so a positive sweep about Y' is the entity's counter-clockwise sweep).
  const normal: Vec3 = [
    frame.x[1] * frame.z[2] - frame.x[2] * frame.z[1],
    frame.x[2] * frame.z[0] - frame.x[0] * frame.z[2],
    frame.x[0] * frame.z[1] - frame.x[1] * frame.z[0],
  ];
  const position = writer.add(
    `IFCAXIS2PLACEMENT3D(${point3(context, ...frame.origin)},${direction(context, normal)},${direction(context, frame.x)})`,
  );
  const circle = isCircle(entity.profile);
  const profile =
    circle === null
      ? polygonProfile(
          context,
          entity.profile.map(([x, y]) => [x, y]),
        )
      : writer.add(
          `IFCCIRCLEPROFILEDEF(.AREA.,$,${writer.add(`IFCAXIS2PLACEMENT2D(${point2(context, circle.centre)},$)`)},${ifcReal(circle.radius)})`,
        );
  const axis = writer.add(`IFCAXIS1PLACEMENT(${point3(context, 0, 0, 0)},${direction(context, [0, 1, 0])})`);
  return writer.add(`IFCREVOLVEDAREASOLID(${profile},${position},${axis},${ifcReal(Math.min(entity.angle, 2 * Math.PI))})`);
}

const VALVE_TYPE: Readonly<Record<string, string>> = {
  valveGate: '.ISOLATING.',
  valveBall: '.ISOLATING.',
  valveButterfly: '.ISOLATING.',
  valvePlug: '.ISOLATING.',
  valveGlobe: '.REGULATING.',
  valveCheck: '.CHECKVALVE.',
};

/** The IFC entity and predefined type of a part, or null for a part without a product. */
function classOf(part: RoutedPart): { entity: 'IFCPIPESEGMENT' | 'IFCPIPEFITTING' | 'IFCVALVE'; type: string } | null {
  switch (part.kind) {
    case 'pipe':
      return { entity: 'IFCPIPESEGMENT', type: '.RIGIDSEGMENT.' };
    case 'elbow':
      return { entity: 'IFCPIPEFITTING', type: '.BEND.' };
    case 'tee':
    case 'olet':
      return { entity: 'IFCPIPEFITTING', type: '.JUNCTION.' };
    case 'reducer':
      return { entity: 'IFCPIPEFITTING', type: '.TRANSITION.' };
    case 'flange':
    case 'gasket':
      return { entity: 'IFCPIPEFITTING', type: '.CONNECTOR.' };
    case 'cap':
      return { entity: 'IFCPIPEFITTING', type: '.OBSTRUCTION.' };
    case 'valve':
      return { entity: 'IFCVALVE', type: VALVE_TYPE[part.typeKey] ?? '.NOTDEFINED.' };
    default:
      return null;
  }
}

/** Index of the port of `part` nearest to `at`. */
function nearestPort(part: RoutedPart, at: Vec3): number {
  let best = 0;
  let distance = Infinity;
  part.ports.forEach((port, index) => {
    const d = len3(sub3(port.position, at));
    if (d < distance - 1e-9) {
      best = index;
      distance = d;
    }
  });
  return best;
}

function portOf(context: Context, part: RoutedPart, index: number, port: PartPort, parent: string, partId: string): string {
  const { writer } = context;
  const axis = writer.add(
    `IFCAXIS2PLACEMENT3D(${point3(context, ...mm3(port.position))},${direction(context, port.direction)},${direction(context, perpendicular(port.direction))})`,
  );
  const placement = writer.add(`IFCLOCALPLACEMENT(${parent},${axis})`);
  return writer.add(
    `IFCDISTRIBUTIONPORT('${context.guid(`${partId}:port-${index + 1}`)}',$,${ifcString(`${part.id}:P${index + 1}`)},${ifcString(`${port.endType} DN${port.dn}`)},$,${placement},$,.SOURCEANDSINK.,.PIPE.,$)`,
  );
}

/** A unit vector perpendicular to `v`. */
function perpendicular(v: Vec3): Vec3 {
  const reference: Vec3 = Math.abs(v[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const cross: Vec3 = [
    reference[1] * v[2] - reference[2] * v[1],
    reference[2] * v[0] - reference[0] * v[2],
    reference[0] * v[1] - reference[1] * v[0],
  ];
  const length = len3(cross);
  return [cross[0] / length, cross[1] / length, cross[2] / length];
}

interface PortHandle {
  readonly id: string;
  readonly ref: string;
}

const CELL = 0.05;
const cellKey = (position: Vec3): string => position.map((value) => Math.round(value / CELL)).join('|');

/**
 * The ports that meet, each port in at most one pair: first the ports of two parts that coincide and face each other (butt welds, the faces of a gasket
 * between two flanges), then the ports a socket-weld, threaded or butt-weld joint joins whose parts overlap (the nearest port of each part to the joint).
 * A flanged joint is carried by the faces of its gasket; an olet or stub-in is welded to the side of a header piece (a branch weld) and has no port there.
 */
function connectedPorts(
  refs: ReadonlyMap<string, { product: string; ports: string[] }>,
  parts: ReadonlyMap<string, { part: RoutedPart }>,
  edges: ReadonlyArray<{ from: string; to: string; jointKind?: string; position: Vec3 }>,
): Array<[PortHandle, PortHandle]> {
  const used = new Set<string>();
  const pairs: Array<[PortHandle, PortHandle]> = [];
  const handle = (partId: string, index: number): PortHandle | null => {
    const ref = refs.get(partId)?.ports[index];
    return ref === undefined ? null : { id: `${partId}:${index}`, ref };
  };
  const link = (a: PortHandle | null, b: PortHandle | null): void => {
    if (a === null || b === null || used.has(a.id) || used.has(b.id)) return;
    used.add(a.id);
    used.add(b.id);
    pairs.push([a, b]);
  };
  const cells = new Map<string, Array<{ partId: string; index: number; direction: Vec3 }>>();
  for (const partId of refs.keys()) {
    parts.get(partId)?.part.ports.forEach((port, index) => {
      const key = cellKey(port.position);
      cells.set(key, [...(cells.get(key) ?? []), { partId, index, direction: port.direction }]);
    });
  }
  for (const entries of cells.values()) {
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const [a, b] = [entries[i], entries[j]];
        if (a === undefined || b === undefined || a.partId === b.partId) continue;
        const dot = a.direction[0] * b.direction[0] + a.direction[1] * b.direction[1] + a.direction[2] * b.direction[2];
        if (dot < -0.999) link(handle(a.partId, a.index), handle(b.partId, b.index));
      }
    }
  }
  for (const edge of edges) {
    if (edge.jointKind === undefined || edge.jointKind === 'flanged' || edge.jointKind === 'branchWeld') continue;
    const [a, b] = [parts.get(edge.from)?.part, parts.get(edge.to)?.part];
    if (a === undefined || b === undefined) continue;
    link(handle(a.id, nearestPort(a, edge.position)), handle(b.id, nearestPort(b, edge.position)));
  }
  return pairs;
}

/**
 * Appends the pipe products of `doc` to the IFC being written.
 * @param parentPlacement local placement of the IfcBuilding (world origin): the plant coordinates are absolute
 */
export function exportPipingProducts(context: Context, doc: CadDocument, parentPlacement: string): PipingIfc {
  const piping = getPiping(doc);
  const empty: PipingIfc = { products: [], productCount: 0, portCount: 0, connectionCount: 0, systemCount: 0, bodiless: 0, brokenRuns: [] };
  if (piping.runOrder.length === 0 || doc.units !== 'mm') return empty;
  const { writer } = context;
  const selection = selectRuns(doc);
  const graph = buildGraph(doc, selection.graphRuns);
  const refs = new Map<string, { product: string; ports: string[] }>();
  const byLine = new Map<string, string[]>();
  const products: string[] = [];
  let ports = 0;
  let bodiless = 0;
  const identity = writer.add(
    `IFCLOCALPLACEMENT(${parentPlacement},${writer.add(`IFCAXIS2PLACEMENT3D(${point3(context, 0, 0, 0)},$,$)`)})`,
  );
  for (const { runId, lineId, derivation } of selection.graphRuns) {
    const line = piping.lines[lineId];
    if (line === undefined) continue;
    for (const part of derivation.parts) {
      const kind = classOf(part);
      const solids = partEntities(part, line).flatMap((entity) => (entity.kind === 'revolution' ? [solidOf(context, entity)] : []));
      if (kind === null || solids.length === 0) {
        bodiless += 1;
        continue;
      }
      const description = [line.lineNumber, part.tag ?? part.typeKey].join(' ');
      const product = writer.add(
        `${kind.entity}('${context.guid(part.id)}',$,${ifcString(part.tag ?? part.id)},${ifcString(description)},${ifcString(part.typeKey)},${identity},${shape(context, solids)},${ifcString(part.id)},${kind.type})`,
      );
      const portRefs = part.ports.map((port, index) => portOf(context, part, index, port, identity, part.id));
      if (portRefs.length > 0) writer.add(`IFCRELNESTS('${context.guid(`${part.id}:nests`)}',$,$,$,${product},(${portRefs.join(',')}))`);
      ports += portRefs.length;
      addPropertySet(context, { id: part.id, ref: product }, 'Pset_llullPiping', [
        `IFCPROPERTYSINGLEVALUE('LineNumber','Line number of the pipe line',IFCLABEL(${ifcString(line.lineNumber)}),$)`,
        `IFCPROPERTYSINGLEVALUE('Spec','Piping spec id',IFCLABEL(${ifcString(line.spec)}),$)`,
        `IFCPROPERTYSINGLEVALUE('CatalogueKey','Catalogue row <spec>/<component>/<size>',IFCLABEL(${ifcString(part.catalogueKey)}),$)`,
        `IFCPROPERTYSINGLEVALUE('NominalSize','Nominal size DN, mm',IFCLENGTHMEASURE(${ifcReal(part.dn)}),$)`,
        `IFCPROPERTYSINGLEVALUE('Run','Pipe run id',IFCLABEL(${ifcString(runId)}),$)`,
      ]);
      refs.set(part.id, { product, ports: portRefs });
      products.push(product);
      byLine.set(lineId, [...(byLine.get(lineId) ?? []), product]);
    }
  }
  const pairs = connectedPorts(refs, graph.parts, graph.edges);
  for (const [first, second] of pairs) {
    writer.add(`IFCRELCONNECTSPORTS('${context.guid(`${first.id}:${second.id}:ports`)}',$,$,$,${first.ref},${second.ref},$)`);
  }
  const connections = pairs.length;
  let systems = 0;
  for (const lineId of piping.lineOrder) {
    const members = byLine.get(lineId);
    const line = piping.lines[lineId];
    if (members === undefined || line === undefined) continue;
    const system = writer.add(
      `IFCDISTRIBUTIONSYSTEM('${context.guid(`${lineId}:system`)}',$,${ifcString(line.lineNumber)},${ifcString(`${line.service} ${line.spec} DN${line.dn}`)},${ifcString(line.service)},$,.NOTDEFINED.)`,
    );
    writer.add(`IFCRELASSIGNSTOGROUP('${context.guid(`${lineId}:system-members`)}',$,$,$,(${members.join(',')}),$,${system})`);
    systems += 1;
  }
  return {
    products,
    productCount: products.length,
    portCount: ports,
    connectionCount: connections,
    systemCount: systems,
    bodiless,
    brokenRuns: selection.broken.map((entry) => entry.runId),
  };
}
