/**
 * Display geometry of derived parts (02 RTE §5.11): one read-only revolution entity per part, id = the part id. Pipe piece = solid cylinder,
 * elbow = the 16-point pipe section revolved about the bend axis (24 steps per 90 degrees, exact torus segment), flange = revolved profile
 * (plate, hub, neck, bore), gasket = ring. Bolt sets have no geometry (hardware count only). Layers P-PIPE, P-FITT, P-FLNG (valves and reducer bodies: geometryInline.ts, P-VALV).
 */

import type { Entity, RevolutionEntity } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import type { PartPort, PipeLine, RoutedPart } from '@aec/plant/types';
import { circlePolygon } from '@lib/arc';
import { eulerFromAxes } from '@lib/eulerRotation';
import { add3, cross3, dot3, len3, scale3, sub3 } from '@lib/vec3';
import { unitVector } from './legs';

export const PIPE_LAYER_ID = 'layer-P-PIPE';
export const FITTING_LAYER_ID = 'layer-P-FITT';
export const FLANGE_LAYER_ID = 'layer-P-FLNG';
export const VALVE_LAYER_ID = 'layer-P-VALV';

const COLORS = {
  [PIPE_LAYER_ID]: '#2f9c8f',
  [FITTING_LAYER_ID]: '#d9a441',
  [FLANGE_LAYER_ID]: '#8f98a3',
  [VALVE_LAYER_ID]: '#c0504d',
} as const;
/** Layer id -> colour, for `ensureLayerIds`. */
export const PIPING_LAYER_COLORS: ReadonlyMap<string, string> = new Map(Object.entries(COLORS));

export const RADIAL_SEGMENTS = 24;
const SECTION_POINTS = 16;
const ARC_STEPS_PER_QUARTER = 24;

export type Section = Array<[number, number]>;

export type LayerId = keyof typeof COLORS;

/** Euler angles taking local +Z onto the unit vector `axis` (local X is any perpendicular). */
export function rotationToward(axis: Vec3): Vec3 {
  const reference: Vec3 = Math.abs(axis[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const x = unitVector(cross3(reference, axis));
  return eulerFromAxes(x, cross3(axis, x), axis);
}

export function entityOf(
  part: RoutedPart,
  line: PipeLine,
  layerId: LayerId,
  label: string,
  placement: { position: Vec3; rotation: Vec3 },
  profile: Section,
  angle: number,
  segments: number,
): RevolutionEntity {
  return {
    id: part.id,
    kind: 'revolution',
    position: placement.position,
    rotation: placement.rotation,
    layerId,
    color: COLORS[layerId],
    name: `${label} ${part.id} ${line.lineNumber}`,
    tags: [`piping:${line.id}`, `piping-run:${part.runId}`, `piping-part:${part.kind}`],
    profile,
    axis: [0, 0, 1],
    angle,
    segments,
  };
}

/** Axis of a two-port part: the first port, and the unit direction toward the second. */
export function axisOf(ports: readonly PartPort[]): { origin: Vec3; axis: Vec3; length: number } | null {
  const [a, b] = ports;
  if (a === undefined || b === undefined) return null;
  const delta = sub3(b.position, a.position);
  const length = len3(delta);
  return length > 0 ? { origin: a.position, axis: scale3(delta, 1 / length), length } : null;
}

function pipeEntity(part: RoutedPart, line: PipeLine): RevolutionEntity | null {
  const frame = axisOf(part.ports);
  const od = part.dims['outsideDiameter'];
  if (frame === null || od === undefined) return null;
  const r = od / 2;
  const profile: Section = [
    [0, 0],
    [r, 0],
    [r, frame.length],
    [0, frame.length],
  ];
  return entityOf(
    part,
    line,
    PIPE_LAYER_ID,
    'Pipe',
    { position: frame.origin, rotation: rotationToward(frame.axis) },
    profile,
    2 * Math.PI,
    RADIAL_SEGMENTS,
  );
}

function elbowEntity(part: RoutedPart, line: PipeLine): RevolutionEntity | null {
  const [from, to] = part.ports;
  const radius = part.radius;
  const od = part.dims['outsideDiameter'];
  const turn = part.angleDeg;
  if (from === undefined || to === undefined || radius === undefined || od === undefined || turn === undefined) return null;
  const travel = scale3(from.direction, -1);
  const out = to.direction;
  const inward = unitVector(sub3(out, scale3(travel, dot3(out, travel))));
  if (len3(inward) === 0) return null;
  // The bend starts one tangent length before the elbow centre (the port itself for a butt-weld elbow, the socket bottom for a socket-weld one).
  const tangent = part.centre === undefined ? from.position : add3(part.centre, scale3(travel, -radius * Math.tan((turn * Math.PI) / 360)));
  const arcCentre = add3(tangent, scale3(inward, radius));
  const x = scale3(inward, -1);
  const z = unitVector(cross3(travel, inward));
  const section: Section = circlePolygon([radius, 0], od / 2, SECTION_POINTS).map(([r, a]) => [r, a]);
  const steps = Math.max(3, Math.ceil((ARC_STEPS_PER_QUARTER * turn) / 90));
  const rotation = eulerFromAxes(x, cross3(z, x), z);
  return entityOf(part, line, FITTING_LAYER_ID, 'Elbow', { position: arcCentre, rotation }, section, (turn * Math.PI) / 180, steps);
}

function flangeEntity(part: RoutedPart, line: PipeLine): RevolutionEntity | null {
  const face = part.ports.find((port) => port.endType === 'FL');
  const weld = part.ports.find((port) => port.endType !== 'FL');
  const pipeOd = part.dims['pipeOutsideDiameter'];
  if (face === undefined || weld === undefined || pipeOd === undefined) return null;
  const hub = len3(sub3(weld.position, face.position));
  const neck = pipeOd / 2;
  const outer = (part.dims['outsideDiameter'] ?? pipeOd * 2) / 2;
  const plate = Math.min(part.dims['thickness'] ?? hub * 0.4, hub);
  const hubRoot = neck + (outer - neck) * 0.25;
  const bore = neck * 0.8;
  const profile: Section = [
    [bore, 0],
    [outer, 0],
    [outer, plate],
    [hubRoot, plate],
    [neck, hub],
    [bore, hub],
  ];
  const axis = unitVector(sub3(weld.position, face.position));
  return entityOf(
    part,
    line,
    FLANGE_LAYER_ID,
    'Flange',
    { position: face.position, rotation: rotationToward(axis) },
    profile,
    2 * Math.PI,
    RADIAL_SEGMENTS,
  );
}

function gasketEntity(part: RoutedPart, line: PipeLine): RevolutionEntity | null {
  const frame = axisOf(part.ports);
  const thickness = part.dims['thickness'];
  if (frame === null || thickness === undefined) return null;
  const pipeOd = part.dims['pipeOutsideDiameter'] ?? 0;
  const inner = (part.dims['innerRingId'] ?? pipeOd) / 2;
  const outer = (part.dims['centeringRingOd'] ?? part.dims['sealingElementOd'] ?? pipeOd * 1.6) / 2;
  const profile: Section = [
    [inner, 0],
    [outer, 0],
    [outer, thickness],
    [inner, thickness],
  ];
  return entityOf(
    part,
    line,
    FLANGE_LAYER_ID,
    'Gasket',
    { position: frame.origin, rotation: rotationToward(frame.axis) },
    profile,
    2 * Math.PI,
    RADIAL_SEGMENTS,
  );
}

/** The display entity of `part`, or null when it has none (bolt sets, parts the model cannot draw yet). */
export function partEntity(part: RoutedPart, line: PipeLine): Entity | null {
  switch (part.kind) {
    case 'pipe':
      return pipeEntity(part, line);
    case 'elbow':
      return elbowEntity(part, line);
    case 'flange':
      return flangeEntity(part, line);
    case 'gasket':
      return gasketEntity(part, line);
    default:
      return null;
  }
}
