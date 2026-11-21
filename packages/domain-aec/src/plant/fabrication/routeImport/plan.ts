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
import type { NetworkComponent, NetworkPoint } from '../model';
import { ZERO } from './eccentric';
import { addBranch, arrive, comp, createState, dedupe, free, refuse, take, type PlanState, type Walk } from './planState';
import type { PlanOptions, PlannedRun, PlannedSupport, RoutePlan, RouteRefusal, Seed } from './planTypes';
import { startClosure, startFlangeSet, walkRun } from './planWalk';

export type { PlannedPort, PlannedRun, RoutePlan } from './planTypes';

/** Most components a line may have in route mode: every part is derived from the spec by a command, and the re-derivation grows with the line. */
export const MAX_ROUTE_COMPONENTS = 400;

interface OletCandidate {
  readonly component: NetworkComponent;
  readonly i: number;
}

/** True when `point` lies within 1 mm of the segment a-b. */
function onSegment(point: Vec3, a: Vec3, b: Vec3): boolean {
  const length = distance3(a, b);
  if (length < 1e-9) return false;
  const direction = normalize3(sub3(b, a));
  const along = (point[0] - a[0]) * direction[0] + (point[1] - a[1]) * direction[1] + (point[2] - a[2]) * direction[2];
  return along >= -1 && along <= length + 1 && Math.abs(distance3(point, a) ** 2 - along ** 2) <= 1;
}

/** The free end the main run starts from: an open end when there is one (the closure at the other end then ends the run), else a closed end (the closure starts the run). */
function pickStart(s: PlanState): NetworkPoint | RouteRefusal {
  const structural = s.components.filter((component) => !['WELD', 'BOLT', 'SUPPORT', 'OLET'].includes(component.type));
  const freeEnds = structural
    .flatMap((component) => component.ends.map((end) => ({ component, end })))
    .filter(({ end }) => free(s, nodeKey(end.xyz)).length === 1);
  const closureEnd = ({ component }: (typeof freeEnds)[number]): boolean => component.type === 'CAP' || component.type === 'FLANGE-BLIND';
  // An open end is preferred (the walk then ends at the closure); when every free end is a closure the main run starts at one (closed start, the other end closes it).
  const startPick = freeEnds.find((entry) => !closureEnd(entry)) ?? freeEnds[0];
  const startEnd = startPick?.end;
  if (startEnd === undefined)
    return refuse('ISO_ROUTE_UNSUPPORTED', 'the line has no free end to start from (a closed loop, or no pipe component)', []);
  return startEnd;
}

/** An olet whose centre, less an offset carried along the run (an eccentric reducer upstream), is on this run's centreline branches off it at that stored point. */
function branchOlets(
  s: PlanState,
  seed: Seed,
  line: readonly Vec3[],
  shifts: readonly Vec3[],
  olets: readonly OletCandidate[],
  pending: Set<number>,
): void {
  for (const { component, i } of olets) {
    if (!pending.has(i) || component.branch === undefined) continue;
    const centre = component.centre ?? component.branch.xyz;
    const stored = shifts
      .map((shift) => sub3(centre, shift))
      .find((point) => line.some((p, k) => k > 0 && onSegment(point, line[k - 1] as Vec3, p)));
    if (stored === undefined) continue;
    pending.delete(i);
    take(s, i);
    addBranch(s, seed.key, stored, component.branch);
  }
}

/** The CAP or FLANGE-BLIND whose closed end is the free node `key` (the main run starts closed), if any. */
function startClosureOf(s: PlanState, key: string): number | undefined {
  return free(s, key).find((i) => comp(s, i).type === 'CAP' || comp(s, i).type === 'FLANGE-BLIND');
}

function walkSeed(
  s: PlanState,
  seed: Seed,
  startEnd: NetworkPoint,
  olets: readonly OletCandidate[],
  pending: Set<number>,
  runs: PlannedRun[],
): RouteRefusal | undefined {
  const w: Walk = {
    seed,
    points: [seed.start],
    inline: [],
    consumed: [],
    startPort: undefined,
    endPort: undefined,
    key: seed.startKey,
    end: seed.start,
    shift: ZERO,
    shifts: [ZERO],
    cap: undefined,
    startCap: undefined,
  };
  if (seed.parent === undefined) {
    const closure = startClosureOf(s, seed.startKey);
    const refused = closure === undefined ? startFlangeSet(s, w, startEnd) : startClosure(s, w, startEnd, closure);
    if (refused !== undefined) return refused;
  }
  const walked = walkRun(s, w);
  if (walked !== undefined) return walked;
  arrive(s, w.key);
  w.points.push(w.cap?.tip ?? sub3(w.end, w.shift));
  const line = dedupe(w.points);
  if (line.length < 2)
    return refuse('ISO_ROUTE_UNSUPPORTED', `run ${seed.key} has no length (it starts and ends at one point)`, w.consumed);
  runs.push({
    key: seed.key,
    dn: seed.dn,
    points: line,
    ...(w.startPort === undefined ? {} : { startPort: w.startPort }),
    ...(w.endPort === undefined ? {} : { endPort: w.endPort }),
    ...(w.cap === undefined ? {} : { cap: w.cap }),
    ...(w.startCap === undefined ? {} : { startCap: w.startCap }),
    inline: w.inline,
    ...(seed.parent === undefined ? {} : { parent: seed.parent }),
    consumed: w.consumed,
  });
  branchOlets(s, seed, line, w.shifts, olets, pending);
  return undefined;
}

function supportsOf(components: readonly NetworkComponent[]): PlannedSupport[] {
  return components.flatMap((component): PlannedSupport[] =>
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
}

export function planRoute(components: readonly NetworkComponent[], options: PlanOptions = {}): RoutePlan | RouteRefusal {
  if (components.length > MAX_ROUTE_COMPONENTS)
    return refuse(
      'ISO_ROUTE_TOO_LARGE',
      `${components.length} components: route mode rebuilds at most ${MAX_ROUTE_COMPONENTS} per line`,
      [],
    );
  const s = createState(components, options);
  const startEnd = pickStart(s);
  if ('ok' in startEnd) return startEnd;
  const runs: PlannedRun[] = [];
  s.seeds.push({ key: 'main', start: startEnd.xyz, startKey: nodeKey(startEnd.xyz), dn: startEnd.boreMm });
  const olets = components.map((component, i) => ({ component, i })).filter(({ component }) => component.type === 'OLET');
  const pending = new Set(olets.map(({ i }) => i));
  for (let cursor = 0; cursor < s.seeds.length; cursor++) {
    const refused = walkSeed(s, s.seeds[cursor] as Seed, startEnd, olets, pending, runs);
    if (refused !== undefined) return refused;
  }
  const lost = components.flatMap((component, i) =>
    s.visited.has(i) || ['BOLT', 'SUPPORT'].includes(component.type) ? [] : [component.id],
  );
  if (lost.length > 0)
    return refuse('ISO_ROUTE_UNSUPPORTED', `${lost.length} component(s) are not connected to the line start or lie on no pipe`, lost);
  return {
    ok: true,
    runs,
    welds: s.welds,
    shopWelds: s.shopWelds,
    supports: supportsOf(components),
    rebuilt: s.rebuilt,
    gasketless: [...new Set(s.gasketless)],
  };
}
