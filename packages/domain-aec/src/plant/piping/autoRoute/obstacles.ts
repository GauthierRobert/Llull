/**
 * Obstacle boxes of an auto-route problem (02 RTE §5.12, V2): everything the new pipe must stay clear of, inflated by its own radius
 * (pipe OD / 2 + insulation + clearance) and rounded outward to whole µm.
 *
 * - clash bodies: what every registered clash source reports (`industrial/clash/clashSources`, the geometry `check_clashes` and
 *   `RTE_VALVE_OPERATOR_CLASH` use): for pipe runs the pipe pieces and elbows with their insulation, valves and their operators, flanges at
 *   their outside diameter, tees, olets and reducers. A tilted body is cut along its axis into boxes of a few diameters so its axis-aligned
 *   boxes do not swallow the space beside a slope. A run without bodies (it does not derive) is blocked by its legs, inflated by both radii;
 * - every other 3D entity (equipment, supports, steel, solids): its world bounding box. Derived run parts are not taken as entities;
 * - `keepOut` entity ids (any entity, derived parts included) and `keepOutBoxes`.
 * @invariant one geometry path: nothing here re-derives a run or measures a pipe; document order and body order make the list deterministic
 */

import { is3D, type CadDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import type { PipingModel } from '@aec/plant/types';
import { entityBoundsInDoc } from '@core/geometry/bounds';
import type { OrientedBox } from '../../../industrial/clash/clashBoxes';
import { externalBodies, type ExternalBody } from '../../../industrial/clash/clashSources';
import { runPoints } from '../model';
import { pipeOutsideDiameter } from '../specLookup';
import type { ObstacleBox } from './lattice';

/** Keep-out inputs of a route request. */
export interface KeepOuts {
  readonly keepOut?: readonly string[] | undefined;
  readonly keepOutBoxes?: readonly { readonly min: Vec3; readonly max: Vec3 }[] | undefined;
}

export interface Obstacles {
  readonly obstacles: ObstacleBox[];
  readonly keepOutIds: ReadonlySet<string>;
}

export interface ObstacleRefusal {
  readonly code: string;
  readonly message: string;
  readonly ids: readonly string[];
  readonly paths: readonly string[];
}

/** A tilted body is cut into boxes whose length is at most this many section half-widths (at most `MAX_CUTS` cuts). */
const CUT_LENGTH_IN_SECTIONS = 4;
const MAX_CUTS = 32;
const AXIS_EPS = 1e-9;

type Corners = { min: Vec3; max: Vec3 };

const inflate = (id: string, min: Vec3, max: Vec3, extra: number): ObstacleBox => ({
  id,
  min: [Math.floor((min[0] - extra) * 1000), Math.floor((min[1] - extra) * 1000), Math.floor((min[2] - extra) * 1000)],
  max: [Math.ceil((max[0] + extra) * 1000), Math.ceil((max[1] + extra) * 1000), Math.ceil((max[2] + extra) * 1000)],
});

/** World AABB of an oriented box. */
function aabb(box: OrientedBox): Corners {
  const reach = [0, 1, 2].map((dim) => box.axes.reduce((sum, axis, k) => sum + Math.abs(axis[dim] as number) * (box.half[k] as number), 0));
  return {
    min: box.center.map((v, dim) => v - (reach[dim] as number)) as unknown as Vec3,
    max: box.center.map((v, dim) => v + (reach[dim] as number)) as unknown as Vec3,
  };
}

const axisAligned = (box: OrientedBox): boolean => box.axes.every((axis) => axis.some((v) => Math.abs(Math.abs(v) - 1) < AXIS_EPS));

/** The oriented box as one or several axis-aligned boxes covering it: a tilted body is cut along its long (third) axis. */
function aabbs(box: OrientedBox): Corners[] {
  const length = 2 * box.half[2];
  const section = Math.max(box.half[0], box.half[1]);
  const wanted = Math.ceil(length / (CUT_LENGTH_IN_SECTIONS * section || 1));
  const cuts = axisAligned(box) ? 1 : Math.min(MAX_CUTS, Math.max(1, wanted));
  if (cuts === 1) return [aabb(box)];
  const axis = box.axes[2];
  return Array.from({ length: cuts }, (_, cut) => {
    const offset = -length / 2 + ((cut + 0.5) * length) / cuts;
    const center = box.center.map((v, dim) => v + (axis[dim] as number) * offset) as unknown as Vec3;
    return aabb({ ...box, center, half: [box.half[0], box.half[1], length / (2 * cuts)] });
  });
}

const contains = (outer: ObstacleBox, inner: ObstacleBox): boolean =>
  inner.min.every((v, dim) => v >= (outer.min[dim] as number)) && inner.max.every((v, dim) => v <= (outer.max[dim] as number));

/** Boxes of one group's bodies; a box inside another box of the same part is dropped (a solid inside its insulation envelope). */
function bodyBoxes(bodies: readonly ExternalBody[], radius: number): ObstacleBox[] {
  const byPart = new Map<string, ObstacleBox[]>();
  for (const body of bodies) {
    const key = body.accessoryOf === undefined ? body.id : `${body.accessoryOf}/${body.id}`;
    const list = byPart.get(key) ?? [];
    byPart.set(key, list);
    const tag = body.kind === 'envelope' ? '~ins' : '';
    aabbs(body.box).forEach(({ min, max }, cut) => list.push(inflate(`${body.id}${tag}${cut > 0 ? `.${cut}` : ''}`, min, max, radius)));
  }
  const kept = (boxes: readonly ObstacleBox[]): ObstacleBox[] =>
    boxes.filter((box, index) => !boxes.some((other, k) => k !== index && contains(other, box) && (!contains(box, other) || k < index)));
  return [...byPart.values()].flatMap(kept);
}

/**
 * @failure an unknown `keepOut` id -> ObstacleRefusal RTE_UNKNOWN_KEEPOUT
 */
export function collectObstacles(doc: CadDocument, piping: PipingModel, radius: number, request: KeepOuts): Obstacles | ObstacleRefusal {
  const keepOut = new Set(request.keepOut ?? []);
  const unknown = [...keepOut].filter((id) => doc.entities[id] === undefined);
  if (unknown.length > 0)
    return { code: 'RTE_UNKNOWN_KEEPOUT', message: `no entity ${unknown.join(', ')}`, ids: unknown, paths: ['keepOut'] };
  const groups = new Map<string, ExternalBody[]>();
  for (const body of externalBodies(doc)) groups.set(body.group, [...(groups.get(body.group) ?? []), body]);
  const runIds = new Set(piping.runOrder);
  const derived = new Set(Object.values(piping.entityIds).flat());
  const obstacles: ObstacleBox[] = [];
  for (const id of doc.order) {
    const entity = doc.entities[id];
    if (entity === undefined || runIds.has(id) || (derived.has(id) && !keepOut.has(id)) || !is3D(entity)) continue;
    const { min, max } = entityBoundsInDoc(doc, entity);
    if ([...min, ...max].every(Number.isFinite)) obstacles.push(inflate(id, min, max, radius));
  }
  for (const bodies of groups.values()) obstacles.push(...bodyBoxes(bodies, radius));
  for (const runId of piping.runOrder) {
    const run = piping.runs[runId];
    const other = run === undefined ? undefined : piping.lines[run.lineId];
    if (run === undefined || other === undefined || groups.has(runId)) continue;
    const otherRadius = (pipeOutsideDiameter(doc, other.spec, other.dn) ?? 0) / 2 + (other.insulation?.thicknessMm ?? 0);
    const points = runPoints(run);
    for (let leg = 0; leg + 1 < points.length; leg++) {
      const [a, b] = [points[leg] as Vec3, points[leg + 1] as Vec3];
      const min: Vec3 = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])];
      const max: Vec3 = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])];
      obstacles.push(inflate(`${runId}#leg${leg}`, min, max, radius + otherRadius));
    }
  }
  (request.keepOutBoxes ?? []).forEach((box, index) => {
    const id = `keepOutBox#${index}`;
    keepOut.add(id);
    const lower: Vec3 = [Math.min(box.min[0], box.max[0]), Math.min(box.min[1], box.max[1]), Math.min(box.min[2], box.max[2])];
    const upper: Vec3 = [Math.max(box.min[0], box.max[0]), Math.max(box.min[1], box.max[1]), Math.max(box.min[2], box.max[2])];
    obstacles.push(inflate(id, lower, upper, radius));
  });
  return { obstacles, keepOutIds: keepOut };
}
