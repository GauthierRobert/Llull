/** The state of one route-plan walk (visited components, welds, gaskets, branch seeds) and the lookups over the component network. */

import type { Vec3 } from '@core/model/vectors';
import { add3 } from '@lib/vec3';
import { nodeKey } from '../joints';
import { branchSideways } from './eccentric';
import type { NetworkComponent, NetworkPoint } from '../model';
import type { PlannedInline } from './inlineBody';
import type { PlanOptions, PlannedCap, PlannedPort, PlannedWeld, RouteRefusal, Seed } from './planTypes';

export interface PlanState {
  readonly components: readonly NetworkComponent[];
  readonly options: PlanOptions;
  /** The corner of an elbow whose centre the file does not give. */
  readonly index: ReadonlyMap<string, number[]>;
  readonly visited: Set<number>;
  readonly welds: PlannedWeld[];
  readonly rebuilt: string[];
  readonly gasketless: string[];
  readonly seeds: Seed[];
  shopWelds: number;
  branches: number;
}

/** The walk of one run: the points and inline components met so far, where it stands (`key`, `end`) and the eccentric offset of its axis. */
export interface Walk {
  readonly seed: Seed;
  readonly points: Vec3[];
  readonly inline: PlannedInline[];
  readonly consumed: string[];
  startPort: PlannedPort | undefined;
  endPort: PlannedPort | undefined;
  key: string;
  end: Vec3;
  /** Offset of the actual axis from the stored one (an eccentric reducer upstream on this leg). */
  shift: Vec3;
  /** Per point of `points` (parallel; entry 0 unused): the offsets in force on the segment that ends there, the one it started with and one per eccentric reducer on it. */
  readonly shifts: Vec3[][];
  /** The offsets of the leg being walked (becomes `shifts[k]` when the leg's end point is pushed). */
  legShifts: Vec3[];
  cap: PlannedCap | undefined;
  /** The closure at the start of the main run (its walk begins on the pipe side of it). */
  startCap: (PlannedCap & { readonly tip: Vec3 }) | undefined;
}

/** What one component did to the walk: refused, or moved on past its exit (`advance`), or already moved `end` / `key` itself (`again`). */
export type Step = RouteRefusal | 'advance' | 'again';

export const refuse = (code: RouteRefusal['code'], message: string, ids: readonly string[]): RouteRefusal => ({
  ok: false,
  code,
  message,
  ids,
});
export const midpoint = (a: Vec3, b: Vec3): Vec3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];

export function createState(components: readonly NetworkComponent[], options: PlanOptions): PlanState {
  const index = new Map<string, number[]>();
  components.forEach((component, i) => {
    if (['OLET', 'BOLT', 'SUPPORT'].includes(component.type)) return;
    for (const end of component.ends) index.set(nodeKey(end.xyz), [...(index.get(nodeKey(end.xyz)) ?? []), i]);
  });
  return { components, options, index, visited: new Set(), welds: [], rebuilt: [], gasketless: [], seeds: [], shopWelds: 0, branches: 0 };
}

export const comp = (s: PlanState, i: number): NetworkComponent => s.components[i] as NetworkComponent;

export const take = (s: PlanState, i: number): void => void s.visited.add(i);

export const free = (s: PlanState, key: string, ...except: number[]): number[] =>
  (s.index.get(key) ?? []).filter((i) => !s.visited.has(i) && !except.includes(i) && comp(s, i).type !== 'WELD');

export const otherEnd = (component: NetworkComponent, key: string): NetworkPoint | undefined =>
  component.ends.find((end) => nodeKey(end.xyz) !== key);

/** Welds at a node have no length: they are consumed where the walk arrives. */
export function arrive(s: PlanState, key: string): void {
  for (const i of s.index.get(key) ?? []) {
    const weld = comp(s, i);
    if (weld.type !== 'WELD' || s.visited.has(i)) continue;
    take(s, i);
    const point = weld.ends[0]?.xyz;
    if ((weld.weldKind === 'site' || weld.weldKind === 'field_fit') && point !== undefined)
      s.welds.push({ componentId: weld.id, kind: weld.weldKind, at: point });
    else s.shopWelds += 1;
  }
}

export function addBranch(s: PlanState, parent: string, centre: Vec3, outlet: NetworkPoint, shift: Vec3 = [0, 0, 0]): void {
  s.branches += 1;
  const sideways = branchSideways(shift, add3(centre, shift), outlet.xyz);
  s.seeds.push({
    key: `branch-${s.branches}`,
    start: centre,
    startKey: nodeKey(outlet.xyz),
    dn: outlet.boreMm,
    parent,
    ...(sideways === undefined ? {} : { sideways }),
  });
}

/** The refusal of an INSTRUMENT with a tapping point (BRANCH1-POINT), or undefined: the RTE cannot branch off an instrument body. */
export function tappingRefusal(component: NetworkComponent): RouteRefusal | undefined {
  if (component.type !== 'INSTRUMENT' || component.branch === undefined) return undefined;
  return refuse(
    'ISO_ROUTE_UNSUPPORTED',
    `instrument ${component.id} has a tapping point (BRANCH1-POINT): the RTE cannot branch off an instrument body, so the take-off line cannot be rebuilt (route mode takes an instrument with two end points only)`,
    [component.id],
  );
}
