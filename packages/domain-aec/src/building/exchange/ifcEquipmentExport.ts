/**
 * IFC of parametric plant equipment (03 EQP §6, FR-EQP-18): the body is one IfcRevolvedAreaSolid per revolved part (shell + heads wall section,
 * skirt, nozzle necks, platform clips) and an IfcExtrudedAreaSolid per support / envelope block, taken from the same derived entities the viewport and the
 * STEP export use; every nozzle is an IfcDistributionPort (FlowDirection from its service, placement = the port frame, Z = the direction away from the
 * equipment) nested in the product (IfcRelNests). The profile of a revolved part is an IfcIndexedPolyCurve: lines and circular arcs stay exact
 * (IfcLineIndex, IfcArcIndex); the ellipsoidal head offset and cubic Bézier pieces have no IFC curve there and are written as sampled polylines (the reason
 * is stated in the `BodyRepresentation` property). A part that cannot be written is a warning, never silently omitted.
 * Placements are storey-relative like the pipe ports of `ifcPorts`: the port origin is the world position minus the level elevation (mm); the body is in the frame of the
 * product placement (plan location at the storey, plan angle). Sampling: ellipse quarter 64 chords (sagitta <= 7.7e-5 x the larger semi-axis, 0.06 mm on a 750 mm head),
 * Bezier offset pieces 4 chords per 7.5 degrees (<= 1.4e-4 x the local radius).
 * @invariant pure; GlobalId seeds `<equipment id>:nozzle:<mark>`, `<equipment id>:nozzle-ports:nests`
 */

import { revolutionAxisIndex } from '@core/geometry/revolution';
import { segmentPoint } from '@core/geometry/curveSegments';
import type { CurveSegment } from '@core/model/curve';
import type { BoxEntity, Entity, RevolutionEntity, Vec3 } from '@core/model/types';
import type { Vec2 } from '@core/model/vectors';
import { applyEulerXYZ } from '@lib/eulerRotation';
import { cross3, normalize3OrZero } from '@lib/vec3';
import type { BuildingLevel, EquipmentElement } from '@aec/building/types';
import { getBuilding } from '../model';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { pressureToMpa } from '../../plant/equipment/codecheck/units';
import { evaluateParametricEquipment } from '../../plant/equipment/evaluate/evaluateEquipment';
import { equipmentPorts } from '../../plant/equipment/geometry/ports';
import { addNamedPset, type PlantIfcRun } from './ifcPlant';
import { ratedPressureProperties } from './ifcNozzleRating';
import { addPort, nest, type Flow, type Port, type PortState } from './ifcPorts';
import { type Context, direction, ifcReal, ifcString, point3, rectangleProfile } from './ifcStep';

export interface EquipmentBody {
  /** Solids of the body (IfcRevolvedAreaSolid, IfcExtrudedAreaSolid) in the frame of the product placement. */
  readonly solids: string[];
  /** Entities that have no IFC solid here: each becomes a warning. */
  readonly skipped: Array<{ readonly part: string; readonly kind: string }>;
}

const BODY_NOTE =
  'IfcRevolvedAreaSolid per revolved part; lines and circular arcs exact (IfcIndexedPolyCurve), the ellipsoidal head offset and Bezier pieces sampled as polylines (no elliptic arc in IfcIndexedPolyCurve): chord sagitta <= 7.7e-5 x the larger semi-axis (ellipse, 64 chords per quarter) and <= 1.4e-4 x the local radius (Bezier, 4 chords per 7.5 degrees)';

const SAMPLES: Readonly<Record<'ellipse' | 'bezier', number>> = { ellipse: 64, bezier: 4 };
const CLOSE_TOLERANCE = 1e-9;

/** Rotation of `vector` about +Z by `angle`. */
const turn = ([x, y, z]: Vec3, angle: number): Vec3 => [
  x * Math.cos(angle) - y * Math.sin(angle),
  x * Math.sin(angle) + y * Math.cos(angle),
  z,
];

/** World frame of an entity expressed in the equipment frame (origin = plan location at the level elevation, rotated by the plan angle). */
class Frame {
  constructor(
    private readonly element: EquipmentElement,
    private readonly level: BuildingLevel,
    private readonly context: Context,
  ) {}

  point(position: Vec3): Vec3 {
    const relative: Vec3 = [
      position[0] - this.element.location[0],
      position[1] - this.element.location[1],
      position[2] - this.level.elevation,
    ];
    const local = turn(relative, -this.element.angle);
    return [this.context.mm(local[0]), this.context.mm(local[1]), this.context.mm(local[2])];
  }

  /** Unit vector `axis` (entity-local) of an entity with `rotation`, in the equipment frame. */
  axis(axis: Vec3, rotation: Vec3): Vec3 {
    return normalize3OrZero(turn(applyEulerXYZ(axis, [0, 0, 0], rotation), -this.element.angle));
  }
}

const placement3 = (context: Context, origin: Vec3, axis: Vec3, reference: Vec3): string =>
  context.writer.add(`IFCAXIS2PLACEMENT3D(${point3(context, ...origin)},${direction(context, axis)},${direction(context, reference)})`);

/** Radial and axial entity-local directions of a revolution, and the handedness of the sweep about the axial direction (+1: counter-clockwise). */
const REVOLUTION_FRAMES: ReadonlyArray<{ radial: Vec3; axial: Vec3; handed: 1 | -1 }> = [
  { radial: [0, 1, 0], axial: [1, 0, 0], handed: 1 },
  { radial: [1, 0, 0], axial: [0, 1, 0], handed: -1 },
  { radial: [1, 0, 0], axial: [0, 0, 1], handed: 1 },
];

/** The profile as points and IfcIndexedPolyCurve segments (profile coordinates in mm, the axial coordinate signed by `handed`). */
function profileCurve(context: Context, entity: RevolutionEntity, handed: 1 | -1, x3: boolean): string {
  const scale = (point: Vec2): Vec2 => [context.mm(point[0]), handed * context.mm(point[1])];
  const segments: ReadonlyArray<CurveSegment<Vec2>> =
    entity.curves ??
    entity.profile.map(
      (point, index): CurveSegment<Vec2> => ({
        type: 'line',
        points: [point, entity.profile[(index + 1) % entity.profile.length] as Vec2],
      }),
    );
  const points: Vec2[] = [];
  const indexOf = (point: Vec2): number => {
    const scaled = scale(point);
    const found = points.findIndex((candidate) => Math.hypot(candidate[0] - scaled[0], candidate[1] - scaled[1]) <= CLOSE_TOLERANCE);
    if (found >= 0) return found + 1;
    points.push(scaled);
    return points.length;
  };
  const written: string[] = [];
  let run: number[] = [];
  const flush = (): void => {
    if (run.length >= 2) written.push(`IFCLINEINDEX((${run.join(',')}))`);
    run = [];
  };
  for (const segment of segments) {
    const start = indexOf(segment.points[0]);
    if (segment.type === 'arc') {
      flush();
      written.push(`IFCARCINDEX((${start},${indexOf(segment.points[1])},${indexOf(segment.points[2])}))`);
      continue;
    }
    if (run.length === 0) run = [start];
    if (segment.type === 'line') run.push(indexOf(segment.points[1]));
    else {
      const count = SAMPLES[segment.type];
      for (let step = 1; step <= count; step++) {
        const at = segmentPoint(segment, step / count);
        run.push(indexOf([at[0], at[1]]));
      }
    }
  }
  flush();
  const list = context.writer.add(
    `IFCCARTESIANPOINTLIST2D((${points.map((point) => `(${ifcReal(point[0])},${ifcReal(point[1])})`).join(',')})${x3 ? ',$' : ''})`,
  );
  return context.writer.add(`IFCINDEXEDPOLYCURVE(${list},(${written.join(',')}),.F.)`);
}

function revolvedSolid(context: Context, frame: Frame, entity: RevolutionEntity, x3: boolean): string {
  const { radial, axial, handed } = REVOLUTION_FRAMES[revolutionAxisIndex(entity.axis)] as (typeof REVOLUTION_FRAMES)[number];
  const xAxis = frame.axis(radial, entity.rotation);
  const yAxis = frame.axis([axial[0] * handed, axial[1] * handed, axial[2] * handed], entity.rotation);
  const profile = context.writer.add(`IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,${profileCurve(context, entity, handed, x3)})`);
  const position = placement3(context, frame.point(entity.position), normalize3OrZero(cross3(xAxis, yAxis)), xAxis);
  const spin = context.writer.add(`IFCAXIS1PLACEMENT(${point3(context, 0, 0, 0)},${direction(context, [0, 1, 0])})`);
  return context.writer.add(`IFCREVOLVEDAREASOLID(${profile},${position},${spin},${ifcReal(entity.angle)})`);
}

function boxSolid(context: Context, frame: Frame, entity: BoxEntity): string {
  const [length, width, height] = entity.size.map((value) => context.mm(value)) as unknown as Vec3;
  const xAxis = frame.axis([1, 0, 0], entity.rotation);
  const zAxis = frame.axis([0, 0, 1], entity.rotation);
  const centre = frame.point(entity.position);
  const base: Vec3 = [centre[0] - (zAxis[0] * height) / 2, centre[1] - (zAxis[1] * height) / 2, centre[2] - (zAxis[2] * height) / 2];
  const profile = rectangleProfile(context, [0, 0], length, width);
  return context.writer.add(
    `IFCEXTRUDEDAREASOLID(${profile},${placement3(context, base, zAxis, xAxis)},${direction(context, [0, 0, 1])},${ifcReal(height)})`,
  );
}

/** Solids of the derived entities of a parametric equipment (shared with the tests: pure over `entities`). */
export function bodyOfEntities(
  context: Context,
  element: EquipmentElement,
  level: BuildingLevel,
  entities: readonly Entity[],
  x3: boolean,
): EquipmentBody {
  const frame = new Frame(element, level, context);
  const solids: string[] = [];
  const skipped: EquipmentBody['skipped'] = [];
  for (const entity of entities) {
    if (entity.kind === 'revolution') solids.push(revolvedSolid(context, frame, entity, x3));
    else if (entity.kind === 'box') solids.push(boxSolid(context, frame, entity));
    else skipped.push({ part: entity.id, kind: entity.kind });
  }
  return { solids, skipped };
}

/** The body of a parametric (non-block) equipment, or null for legacy equipment and blocks (they keep the footprint solid). */
export function parametricBody(context: Context, element: EquipmentElement, level: BuildingLevel, run: PlantIfcRun): EquipmentBody | null {
  const template = element.plant?.template;
  if (template === undefined || template.kind === 'block') return null;
  const body = bodyOfEntities(context, element, level, evaluateParametricEquipment(element, level, template), run.x3);
  for (const part of body.skipped)
    run.warnings.push({
      code: 'EQP_IFC_PART_SKIPPED',
      id: element.id,
      message: `${part.part}: a ${part.kind} entity has no IFC solid in the equipment export`,
    });
  return body;
}

const text = (name: string, value: string): string => `IFCPROPERTYSINGLEVALUE('${name}',$,IFCLABEL(${ifcString(value)}),$)`;
const mass = (name: string, kg: number): string => `IFCPROPERTYSINGLEVALUE('${name}',$,IFCMASSMEASURE(${ifcReal(kg)}),$)`;

/** Template, design data and weights of a parametric equipment for `Pset_llullEquipment` (the weights are those of `equipment_weights`). */
export function equipmentProperties(doc: CadDocument, element: EquipmentElement): string[] {
  const plant = element.plant;
  if (plant === undefined) return [];
  const { template } = plant;
  const design = template.kind === 'vessel' ? plant.design : undefined;
  const weights = template.kind === 'block' ? undefined : execute(doc, 'equipment_weights', { equipment: element.id }).data;
  const body = (weights as { body?: { emptyKg: number; testKg: number } } | undefined)?.body;
  return [
    text('Template', template.kind),
    ...(template.kind === 'vessel' || template.kind === 'exchanger' ? [text('Orientation', template.orientation)] : []),
    ...(design?.pressure === undefined
      ? []
      : [
          `IFCPROPERTYSINGLEVALUE('DesignPressure','Internal design pressure, gauge, Pa',IFCPRESSUREMEASURE(${ifcReal(pressureToMpa(design.pressure.value, design.pressure.unit) * 1e6)}),$)`,
        ]),
    ...(design?.temperatureC === undefined
      ? []
      : [
          `IFCPROPERTYSINGLEVALUE('DesignTemperature','Design temperature, K',IFCTHERMODYNAMICTEMPERATUREMEASURE(${ifcReal(design.temperatureC + 273.15)}),$)`,
        ]),
    ...(design?.material === undefined ? [] : [text('Material', design.material)]),
    ...(body === undefined ? [] : [mass('EmptyWeight', body.emptyKg), mass('TestWeight', body.testKg)]),
    text('BodyRepresentation', template.kind === 'block' ? 'footprint extrusion (block)' : BODY_NOTE),
  ];
}

const INFLOW = /\b(inlet|feed|suction|charge|make-?up|in)\b/i;
const OUTFLOW = /\b(outlet|discharge|product|draw|bottoms?|overhead|drain|vent|out|take-?off)\b/i;

/** FlowDirection of a nozzle seen from the equipment: a pump's SUC / DIS by role, else the service words (inlet SINK, outlet SOURCE), else SOURCEANDSINK. */
export function nozzleFlow(mark: string, service: string | undefined): Flow {
  if (mark === 'SUC') return 'SINK';
  if (mark === 'DIS') return 'SOURCE';
  const [inflow, outflow] = [INFLOW.test(service ?? ''), OUTFLOW.test(service ?? '')];
  return inflow === outflow ? 'SOURCEANDSINK' : inflow ? 'SINK' : 'SOURCE';
}

/** One IfcDistributionPort per nozzle of `element`, nested in the product `ref`; returns the number written. */
export function exportEquipmentPorts(
  context: Context,
  state: PortState,
  doc: CadDocument,
  element: EquipmentElement,
  level: BuildingLevel,
  storeyPlacement: string,
  ref: string,
): number {
  const ports = equipmentPorts(getBuilding(doc), element);
  if (ports.length === 0) return 0;
  const written = new Map<string, Port>();
  for (const port of ports) {
    const at: Vec3 = [context.mm(port.position[0]), context.mm(port.position[1]), context.mm(port.position[2] - level.elevation)];
    const nozzlePort = addPort(
      context,
      state,
      storeyPlacement,
      `${element.id}:nozzle:${port.mark}`,
      port.mark,
      nozzleFlow(port.mark, port.service),
      at,
      port.dn / context.mm(1),
      `${port.id} DN${port.dn} ${port.rating} ${port.facing}${port.service === undefined ? '' : ` ${port.service}`}`,
      port.direction,
    );
    addNamedPset(context, nozzlePort, 'Pset_llullNozzle', [
      `IFCPROPERTYSINGLEVALUE('PortId',$,IFCLABEL(${ifcString(port.id)}),$)`,
      `IFCPROPERTYSINGLEVALUE('Rating',$,IFCLABEL(${ifcString(port.rating)}),$)`,
      `IFCPROPERTYSINGLEVALUE('Facing',$,IFCLABEL(${ifcString(port.facing)}),$)`,
      ...ratedPressureProperties(doc, port.rating),
      ...(port.service === undefined ? [] : [`IFCPROPERTYSINGLEVALUE('Service',$,IFCLABEL(${ifcString(port.service)}),$)`]),
    ]);
    written.set(port.mark, nozzlePort);
  }
  nest(context, `${element.id}:nozzle-ports`, ref, [...written.values()]);
  state.nozzlePorts.set(element.id, written);
  return written.size;
}
