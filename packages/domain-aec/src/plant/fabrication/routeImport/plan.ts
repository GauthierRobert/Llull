/**
 * Route plan of an imported PCF line (plant 05 ISO M5, `import_pcf as route`): the centreline of the line read back from its components, as the inputs the 02 RTE
 * commands take - runs (a main run and one run per tee / olet branch) with their points of intersection, the valves and reducers inline, the flanged ends as ports,
 * plus the field welds and the supports to place afterwards. Nothing is built here; the fittings, flange sets and cut lengths come from the spec when the plan is
 * executed (`compose.ts`). A line this plan cannot reproduce faithfully (a flanged joint that is not a valve set, a cap, an instrument, an eccentric reducer, a loop,
 * a component not reached) is refused with the components named, never silently simplified. Pure, iterative, bounded.
 */

import type { Vec3 } from '@core/model/vectors';
import { distance3, normalize3, sub3 } from '@lib/vec3';
import { nodeKey } from '../joints';
import type { NetworkComponent, NetworkPoint, WeldKind } from '../model';

/** Most components a line may have in route mode: every part is derived from the spec by a command, and the re-derivation grows with the line. */
export const MAX_ROUTE_COMPONENTS = 400;

export interface PlannedPort {
  readonly position: Vec3;
  /** Face direction toward the pipe. */
  readonly direction: Vec3;
  readonly dn: number;
}

export interface PlannedInline {
  readonly type: 'valve' | 'reducer';
  readonly componentId: string;
  readonly centre: Vec3;
  /** Reducers: the size the run continues at. */
  readonly dn2?: number;
  /** Valves: direction from the centre toward the handwheel, when the file gives a spindle direction. */
  readonly stem?: Vec3;
}

export interface PlannedRun {
  readonly key: string;
  readonly dn: number;
  /** Start (for a branch: the point on the header), points of intersection, end. */
  readonly points: readonly Vec3[];
  readonly startPort?: PlannedPort;
  readonly endPort?: PlannedPort;
  readonly inline: readonly PlannedInline[];
  /** The run this one branches off (absent for the main run). */
  readonly parent?: string;
  readonly consumed: readonly string[];
}

export interface PlannedWeld {
  readonly componentId: string;
  readonly kind: Exclude<WeldKind, 'shop'>;
  readonly at: Vec3;
}

export interface PlannedSupport {
  readonly componentId: string;
  readonly at: Vec3;
  readonly name: string | undefined;
  readonly type: string | undefined;
}

export interface RoutePlan {
  readonly ok: true;
  /** The main run first, then the branches in discovery order (a parent before its children). */
  readonly runs: readonly PlannedRun[];
  readonly welds: readonly PlannedWeld[];
  readonly shopWelds: number;
  readonly supports: readonly PlannedSupport[];
  /** Gaskets the spec rebuilds with its flange sets (bolt sets are not counted: they have no position). */
  readonly rebuilt: readonly string[];
}

export interface RouteRefusal {
  readonly ok: false;
  readonly code: 'ISO_ROUTE_UNSUPPORTED' | 'ISO_ROUTE_TOO_LARGE';
  readonly message: string;
  readonly ids: readonly string[];
}

const UNSUPPORTED: Readonly<Record<string, string>> = {
  CAP: 'a cap',
  'FLANGE-BLIND': 'a blind flange',
  INSTRUMENT: 'an instrument',
  'REDUCER-ECCENTRIC': 'an eccentric reducer (its flat side is not in the file)',
};

const SPINDLE: Readonly<Record<string, Vec3>> = {
  UP: [0, 0, 1],
  DOWN: [0, 0, -1],
  NORTH: [0, 1, 0],
  SOUTH: [0, -1, 0],
  EAST: [1, 0, 0],
  WEST: [-1, 0, 0],
};

interface Seed {
  readonly key: string;
  readonly start: Vec3;
  /** The node the walk starts from (the outlet of a branch fitting, the free end of the main run). */
  readonly startKey: string;
  readonly dn: number;
  readonly parent?: string;
}

const refuse = (code: RouteRefusal['code'], message: string, ids: readonly string[]): RouteRefusal => ({ ok: false, code, message, ids });
const midpoint = (a: Vec3, b: Vec3): Vec3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
const dedupe = (points: readonly Vec3[]): Vec3[] => points.filter((point, k) => k === 0 || distance3(point, points[k - 1] as Vec3) > 1e-6);

/** The axis-parallel corner of an elbow whose centre is not given (the L through the first axis the end points differ on). */
const cornerOf = (a: Vec3, b: Vec3): Vec3 => {
  const axis = [0, 1, 2].find((at) => Math.abs((b[at] as number) - (a[at] as number)) > 1e-6) ?? 0;
  return [axis === 0 ? b[0] : a[0], axis === 1 ? b[1] : a[1], axis === 2 ? b[2] : a[2]];
};

/** True when `point` lies within 1 mm of the segment a-b. */
function onSegment(point: Vec3, a: Vec3, b: Vec3): boolean {
  const length = distance3(a, b);
  if (length < 1e-9) return false;
  const direction = normalize3(sub3(b, a));
  const along = (point[0] - a[0]) * direction[0] + (point[1] - a[1]) * direction[1] + (point[2] - a[2]) * direction[2];
  return along >= -1 && along <= length + 1 && Math.abs(distance3(point, a) ** 2 - along ** 2) <= 1;
}

const stemOf = (component: NetworkComponent): { stem?: Vec3 } => {
  const stem = SPINDLE[component.extra?.['SPINDLE-DIRECTION'] ?? ''];
  return stem === undefined ? {} : { stem };
};

export function planRoute(components: readonly NetworkComponent[]): RoutePlan | RouteRefusal {
  if (components.length > MAX_ROUTE_COMPONENTS)
    return refuse(
      'ISO_ROUTE_TOO_LARGE',
      `${components.length} components: route mode rebuilds at most ${MAX_ROUTE_COMPONENTS} per line`,
      [],
    );
  const unsupported = components.filter((component) => UNSUPPORTED[component.type] !== undefined);
  if (unsupported.length > 0)
    return refuse(
      'ISO_ROUTE_UNSUPPORTED',
      `route mode cannot rebuild ${[...new Set(unsupported.map((component) => UNSUPPORTED[component.type]))].join(', ')}`,
      unsupported.map((component) => component.id),
    );
  const at = (i: number): NetworkComponent => components[i] as NetworkComponent;
  const index = new Map<string, number[]>();
  components.forEach((component, i) => {
    if (['OLET', 'BOLT', 'SUPPORT'].includes(component.type)) return;
    for (const end of component.ends) index.set(nodeKey(end.xyz), [...(index.get(nodeKey(end.xyz)) ?? []), i]);
  });
  const visited = new Set<number>();
  const welds: PlannedWeld[] = [];
  const rebuilt: string[] = [];
  let shopWelds = 0;
  const take = (i: number): void => void visited.add(i);
  const free = (key: string, ...except: number[]): number[] =>
    (index.get(key) ?? []).filter((i) => !visited.has(i) && !except.includes(i) && at(i).type !== 'WELD');
  const otherEnd = (component: NetworkComponent, key: string): NetworkPoint | undefined =>
    component.ends.find((end) => nodeKey(end.xyz) !== key);

  /** Welds at a node have no length: they are consumed where the walk arrives. */
  const arrive = (key: string): void => {
    for (const i of index.get(key) ?? []) {
      const weld = at(i);
      if (weld.type !== 'WELD' || visited.has(i)) continue;
      take(i);
      const point = weld.ends[0]?.xyz;
      if ((weld.weldKind === 'site' || weld.weldKind === 'field_fit') && point !== undefined)
        welds.push({ componentId: weld.id, kind: weld.weldKind, at: point });
      else shopWelds += 1;
    }
  };

  /** Flange (entered by its welded end) - [gasket] - valve - gasket - flange: the valve inline and the far flange's welded end. */
  function valveSet(
    flange: NetworkComponent,
    gasket: number | undefined,
    valveIndex: number,
    valveFaceKey: string,
  ): { valve: PlannedInline; consumed: string[]; out: NetworkPoint } | RouteRefusal {
    const valve = at(valveIndex);
    const far = otherEnd(valve, valveFaceKey);
    if (far === undefined || valve.ends.some((valveEnd) => valveEnd.endType !== 'FL'))
      return refuse('ISO_ROUTE_UNSUPPORTED', `valve ${valve.id} is not a flanged valve between two flanges`, [valve.id]);
    const farKey = nodeKey(far.xyz);
    const gasket2 = free(farKey, valveIndex).find((j) => at(j).type === 'GASKET');
    const faceKey = gasket2 === undefined ? farKey : nodeKey(otherEnd(at(gasket2), farKey)?.xyz ?? far.xyz);
    const flange2 = free(faceKey, ...(gasket2 === undefined ? [] : [gasket2])).find(
      (j) => at(j).type === 'FLANGE' && at(j).ends.some((e) => e.endType === 'FL' && nodeKey(e.xyz) === faceKey),
    );
    const out = flange2 === undefined ? undefined : otherEnd(at(flange2), faceKey);
    if (flange2 === undefined || out === undefined)
      return refuse('ISO_ROUTE_UNSUPPORTED', `valve ${valve.id} has no flange on its far side`, [valve.id, flange.id]);
    for (const j of [gasket, gasket2, valveIndex, flange2]) if (j !== undefined) take(j);
    for (const j of [gasket, gasket2]) if (j !== undefined) rebuilt.push(at(j).id);
    return {
      valve: {
        type: 'valve',
        componentId: valve.id,
        centre: midpoint(valve.ends[0]?.xyz ?? far.xyz, valve.ends[1]?.xyz ?? far.xyz),
        ...stemOf(valve),
      },
      consumed: [valve.id, at(flange2).id],
      out,
    };
  }

  const structural = components.filter((component) => !['WELD', 'BOLT', 'SUPPORT', 'OLET'].includes(component.type));
  const startEnd = structural.flatMap((component) => component.ends).find((end) => free(nodeKey(end.xyz)).length === 1);
  if (startEnd === undefined)
    return refuse('ISO_ROUTE_UNSUPPORTED', 'the line has no free end to start from (a closed loop, or no pipe component)', []);

  const runs: PlannedRun[] = [];
  const seeds: Seed[] = [{ key: 'main', start: startEnd.xyz, startKey: nodeKey(startEnd.xyz), dn: startEnd.boreMm }];
  const olets = components.map((component, i) => ({ component, i })).filter(({ component }) => component.type === 'OLET');
  const pendingOlets = new Set(olets.map(({ i }) => i));
  let branches = 0;
  const addBranch = (parent: string, centre: Vec3, outlet: NetworkPoint): void => {
    branches += 1;
    seeds.push({ key: `branch-${branches}`, start: centre, startKey: nodeKey(outlet.xyz), dn: outlet.boreMm, parent });
  };

  for (let cursor = 0; cursor < seeds.length; cursor++) {
    const seed = seeds[cursor] as Seed;
    const points: Vec3[] = [seed.start];
    const inline: PlannedInline[] = [];
    const consumed: string[] = [];
    let startPort: PlannedPort | undefined;
    let endPort: PlannedPort | undefined;
    let key = seed.startKey;
    let end = seed.start;

    // A flange set at the free start (an optional gasket on the face, then the flange entered by its flanged face) is the start port.
    if (seed.parent === undefined) {
      arrive(key);
      const gasket = free(key).find((i) => at(i).type === 'GASKET');
      const faceKey = gasket === undefined ? key : nodeKey(otherEnd(at(gasket), key)?.xyz ?? startEnd.xyz);
      const flange = free(faceKey, ...(gasket === undefined ? [] : [gasket])).find(
        (i) => at(i).type === 'FLANGE' && at(i).ends.some((e) => e.endType === 'FL' && nodeKey(e.xyz) === faceKey),
      );
      if (flange !== undefined) {
        const joint = otherEnd(at(flange), faceKey);
        if (joint === undefined) return refuse('ISO_ROUTE_UNSUPPORTED', `flange ${at(flange).id} has no second end point`, [at(flange).id]);
        if (gasket !== undefined) {
          take(gasket);
          rebuilt.push(at(gasket).id);
        }
        take(flange);
        consumed.push(at(flange).id);
        startPort = { position: startEnd.xyz, direction: normalize3(sub3(joint.xyz, startEnd.xyz)), dn: startEnd.boreMm };
        key = nodeKey(joint.xyz);
        end = joint.xyz;
      }
    }

    for (let guard = 0; guard <= components.length + 2 && endPort === undefined; guard++) {
      arrive(key);
      const i = free(key)[0];
      if (i === undefined) break;
      const component = at(i);
      const exit = otherEnd(component, key);
      if (exit === undefined)
        return refuse('ISO_ROUTE_UNSUPPORTED', `${component.type} ${component.id} has no second end point`, [component.id]);
      take(i);
      consumed.push(component.id);
      switch (component.type) {
        case 'PIPE':
          break;
        case 'ELBOW':
        case 'BEND': {
          const [a, b] = [component.ends[0]?.xyz, component.ends[1]?.xyz];
          if (a === undefined || b === undefined)
            return refuse('ISO_ROUTE_UNSUPPORTED', `${component.id} has no end points`, [component.id]);
          points.push(component.centre ?? cornerOf(a, b));
          break;
        }
        case 'TEE': {
          const [a, b] = [component.ends[0]?.xyz, component.ends[1]?.xyz];
          const centre = component.centre ?? (a !== undefined && b !== undefined ? midpoint(a, b) : undefined);
          if (component.branch === undefined || centre === undefined)
            return refuse('ISO_ROUTE_UNSUPPORTED', `tee ${component.id} has no branch point`, [component.id]);
          addBranch(seed.key, centre, component.branch);
          break;
        }
        case 'REDUCER-CONCENTRIC':
          inline.push({
            type: 'reducer',
            componentId: component.id,
            centre: midpoint(component.ends[0]?.xyz ?? end, component.ends[1]?.xyz ?? end),
            dn2: exit.boreMm,
          });
          break;
        case 'VALVE':
          if (component.ends.some((valveEnd) => valveEnd.endType === 'FL'))
            return refuse('ISO_ROUTE_UNSUPPORTED', `flanged valve ${component.id} is not between two flanges with gaskets`, [component.id]);
          inline.push({
            type: 'valve',
            componentId: component.id,
            centre: midpoint(component.ends[0]?.xyz ?? end, component.ends[1]?.xyz ?? end),
            ...stemOf(component),
          });
          break;
        case 'FLANGE': {
          if (exit.endType !== 'FL')
            return refuse(
              'ISO_ROUTE_UNSUPPORTED',
              `flange ${component.id} is entered by its flanged face: a flanged joint that is not a valve set`,
              [component.id],
            );
          const faceKey = nodeKey(exit.xyz);
          const beyond = free(faceKey, i);
          const gasket = beyond.length === 1 && at(beyond[0] as number).type === 'GASKET' ? (beyond[0] as number) : undefined;
          if (beyond.length === 0 || gasket !== undefined) {
            const far = gasket === undefined ? exit : otherEnd(at(gasket), faceKey);
            if (far === undefined)
              return refuse('ISO_ROUTE_UNSUPPORTED', `gasket ${at(gasket as number).id} has no second end point`, [
                at(gasket as number).id,
              ]);
            const farKey = nodeKey(far.xyz);
            const onward = free(farKey, ...(gasket === undefined ? [] : [gasket]));
            if (onward.length === 0) {
              // The flange ends the run: the face (outside the gasket, when the file has one) is a port.
              if (gasket !== undefined) {
                take(gasket);
                rebuilt.push(at(gasket).id);
              }
              endPort = { position: far.xyz, direction: normalize3(sub3(end, far.xyz)), dn: far.boreMm };
              end = far.xyz;
              key = farKey;
              continue;
            }
            const valve = onward.find((j) => at(j).type === 'VALVE');
            if (valve === undefined)
              return refuse(
                'ISO_ROUTE_UNSUPPORTED',
                `flange ${component.id} is joined to something that is not a valve: a flanged joint outside a valve set`,
                [component.id],
              );
            const through = valveSet(component, gasket, valve, farKey);
            if ('ok' in through) return through;
            inline.push(through.valve);
            consumed.push(...through.consumed);
            end = through.out.xyz;
            key = nodeKey(through.out.xyz);
            continue;
          }
          return refuse(
            'ISO_ROUTE_UNSUPPORTED',
            `flange ${component.id} is joined to something that is not a gasket: a flanged joint outside a valve set`,
            [component.id],
          );
        }
        default:
          return refuse('ISO_ROUTE_UNSUPPORTED', `route mode does not rebuild ${component.type} ${component.id}`, [component.id]);
      }
      end = exit.xyz;
      key = nodeKey(exit.xyz);
    }
    arrive(key);
    points.push(end);
    const line = dedupe(points);
    if (line.length < 2)
      return refuse('ISO_ROUTE_UNSUPPORTED', `run ${seed.key} has no length (it starts and ends at one point)`, consumed);
    runs.push({
      key: seed.key,
      dn: seed.dn,
      points: line,
      ...(startPort === undefined ? {} : { startPort }),
      ...(endPort === undefined ? {} : { endPort }),
      inline,
      ...(seed.parent === undefined ? {} : { parent: seed.parent }),
      consumed,
    });
    // An olet whose centre is on this run's centreline branches off it.
    for (const { component, i } of olets) {
      if (!pendingOlets.has(i) || component.branch === undefined) continue;
      const centre = component.centre ?? component.branch.xyz;
      if (!line.some((p, k) => k > 0 && onSegment(centre, line[k - 1] as Vec3, p))) continue;
      pendingOlets.delete(i);
      take(i);
      addBranch(seed.key, centre, component.branch);
    }
  }

  const lost = components.flatMap((component, i) => (visited.has(i) || ['BOLT', 'SUPPORT'].includes(component.type) ? [] : [component.id]));
  if (lost.length > 0)
    return refuse('ISO_ROUTE_UNSUPPORTED', `${lost.length} component(s) are not connected to the line start or lie on no pipe`, lost);
  const supports = components.flatMap((component): PlannedSupport[] =>
    component.type === 'SUPPORT' && component.coords !== undefined
      ? [
          {
            componentId: component.id,
            at: component.coords,
            name: component.extra?.['SUPPORT-NAME'],
            type: component.extra?.['SUPPORT-TYPE'],
          },
        ]
      : [],
  );
  return { ok: true, runs, welds, shopWelds, supports, rebuilt };
}
