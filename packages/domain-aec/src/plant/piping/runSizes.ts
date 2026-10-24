/**
 * Nominal size along a run (02 RTE M2): a run starts at `run.dn ?? line DN` and each concentric reducer changes the size from its centre on, so
 * the size at any point of the route is a pure function of the stored run (no per-leg size is stored).
 * @invariant inline components are read in route order (leg, then centre distance); a reducer without dn2 changes nothing
 */

import type { InlineComponent, PipeRun } from '@aec/plant/types';

/** A reducer changes the run size (concentric reducer; eccentric ones are V1). */
export const isReducer = (component: Pick<InlineComponent, 'type'>): boolean => component.type.startsWith('reducer');

export const isValve = (component: Pick<InlineComponent, 'type'>): boolean => component.type.startsWith('valve');

/** Route order of two positions on a run. */
export const byRoute = (a: Pick<InlineComponent, 'leg' | 'centreDistance'>, b: Pick<InlineComponent, 'leg' | 'centreDistance'>): number =>
  a.leg - b.leg || a.centreDistance - b.centreDistance;

/** The inline components of `run` in route order. */
export const inlineInOrder = (run: PipeRun): InlineComponent[] => [...(run.inline ?? [])].sort(byRoute);

/** Size at the run start. */
export const startDn = (run: PipeRun, lineDn: number): number => run.dn ?? lineDn;

/** Size just after the point `distance` along leg `leg`: every reducer whose centre is at or before it has applied. */
export function dnAfter(run: PipeRun, lineDn: number, leg: number, distance: number): number {
  let dn = startDn(run, lineDn);
  for (const component of inlineInOrder(run)) {
    if (!isReducer(component) || component.dn2 === undefined) continue;
    if (component.leg < leg || (component.leg === leg && component.centreDistance <= distance)) dn = component.dn2;
  }
  return dn;
}

/** Size at the run end (after every reducer). */
export const endDn = (run: PipeRun, lineDn: number): number => dnAfter(run, lineDn, Number.POSITIVE_INFINITY, 0);
