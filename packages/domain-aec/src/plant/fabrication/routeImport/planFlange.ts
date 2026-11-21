/** A flange met by the route walk (entered by its welded end): a closing blind, a port, a mid-line flanged joint or a flange - valve - flange set. */

import { normalize3, sub3 } from '@lib/vec3';
import { nodeKey } from '../joints';
import type { NetworkComponent, NetworkPoint } from '../model';
import { bodyOf, type PlannedInline } from './inlineBody';
import { ZERO } from './eccentric';
import { comp, free, midpoint, otherEnd, refuse, take, tappingRefusal, type PlanState, type Step, type Walk } from './planState';
import type { RouteRefusal } from './planTypes';
import { appendAll } from '@lib/appendAll';

/** Flange (entered by its welded end) - [gasket] - valve - gasket - flange: the valve inline and the far flange's welded end. */
function valveSet(
  s: PlanState,
  flange: NetworkComponent,
  gasket: number | undefined,
  valveIndex: number,
  valveFaceKey: string,
): { valve: PlannedInline; consumed: string[]; out: NetworkPoint } | RouteRefusal {
  const valve = comp(s, valveIndex);
  const tapped = tappingRefusal(valve);
  if (tapped !== undefined) return tapped;
  const far = otherEnd(valve, valveFaceKey);
  const near = valve.ends.find((bodyEnd) => bodyEnd !== far);
  if (far === undefined || near === undefined || valve.ends.some((valveEnd) => valveEnd.endType !== 'FL'))
    return refuse('ISO_ROUTE_UNSUPPORTED', `${valve.type} ${valve.id} is not a flanged body between two flanges`, [valve.id]);
  const farKey = nodeKey(far.xyz);
  const gasket2 = free(s, farKey, valveIndex).find((j) => comp(s, j).type === 'GASKET');
  const faceKey = gasket2 === undefined ? farKey : nodeKey(otherEnd(comp(s, gasket2), farKey)?.xyz ?? far.xyz);
  const flange2 = free(s, faceKey, ...(gasket2 === undefined ? [] : [gasket2])).find(
    (j) => comp(s, j).type === 'FLANGE' && comp(s, j).ends.some((e) => e.endType === 'FL' && nodeKey(e.xyz) === faceKey),
  );
  const out = flange2 === undefined ? undefined : otherEnd(comp(s, flange2), faceKey);
  if (flange2 === undefined || out === undefined)
    return refuse('ISO_ROUTE_UNSUPPORTED', `${valve.type} ${valve.id} has no flange on its far side`, [valve.id, flange.id]);
  for (const j of [gasket, gasket2, valveIndex, flange2]) if (j !== undefined) take(s, j);
  for (const j of [gasket, gasket2]) if (j !== undefined) s.rebuilt.push(comp(s, j).id);
  if (gasket === undefined) s.gasketless.push(flange.id, valve.id);
  if (gasket2 === undefined) s.gasketless.push(valve.id, comp(s, flange2).id);
  return { valve: bodyOf(valve, near.xyz, far.xyz, ZERO, true), consumed: [valve.id, comp(s, flange2).id], out };
}

function takeGasket(s: PlanState, gasket: number | undefined): void {
  if (gasket === undefined) return;
  take(s, gasket);
  s.rebuilt.push(comp(s, gasket).id);
}

/** A blind flange closes the run: the gasket (when the file has one) and the blind are rebuilt by the spec behind the flange. */
function closeWithBlind(
  s: PlanState,
  w: Walk,
  component: NetworkComponent,
  gasket: number | undefined,
  blind: number,
  far: NetworkPoint,
  farKey: string,
): void {
  take(s, blind);
  w.consumed.push(comp(s, blind).id);
  if (gasket === undefined) s.gasketless.push(component.id, comp(s, blind).id);
  takeGasket(s, gasket);
  const tip = otherEnd(comp(s, blind), farKey)?.xyz;
  w.cap = { kind: 'blindFlange', mouth: sub3(far.xyz, w.shift), ...(tip === undefined ? {} : { tip: sub3(tip, w.shift) }) };
  w.end = far.xyz;
  w.key = farKey;
}

/** Flange - [gasket] - flange: a mid-line flanged joint, rebuilt by the spec with its own gasket and bolts. */
function midLineJoint(
  s: PlanState,
  w: Walk,
  component: NetworkComponent,
  exitPoint: NetworkPoint,
  gasket: number | undefined,
  far: NetworkPoint,
  mate: number,
  outPoint: NetworkPoint,
): void {
  take(s, mate);
  takeGasket(s, gasket);
  w.consumed.push(comp(s, mate).id);
  if (gasket === undefined) s.gasketless.push(component.id, comp(s, mate).id);
  w.inline.push({ type: 'flangedJoint', componentId: component.id, centre: sub3(midpoint(exitPoint.xyz, far.xyz), w.shift) });
  w.end = outPoint.xyz;
  w.key = nodeKey(outPoint.xyz);
}

const flangedFaceAt = (s: PlanState, j: number, faceKey: string): boolean =>
  comp(s, j).ends.some((flangeEnd) => flangeEnd.endType === 'FL' && nodeKey(flangeEnd.xyz) === faceKey);

/** The part of a flange joined onward (past its gasket, when it has one): a blind, a port, a mid-line joint or a valve set. */
function onwardStep(s: PlanState, w: Walk, component: NetworkComponent, exitPoint: NetworkPoint, gasket: number | undefined): Step {
  const far = gasket === undefined ? exitPoint : otherEnd(comp(s, gasket), nodeKey(exitPoint.xyz));
  if (far === undefined)
    return refuse('ISO_ROUTE_UNSUPPORTED', `gasket ${comp(s, gasket as number).id} has no second end point`, [
      comp(s, gasket as number).id,
    ]);
  const farKey = nodeKey(far.xyz);
  const onward = free(s, farKey, ...(gasket === undefined ? [] : [gasket]));
  const blind = onward.find((j) => comp(s, j).type === 'FLANGE-BLIND');
  if (blind !== undefined) {
    closeWithBlind(s, w, component, gasket, blind, far, farKey);
    return 'again';
  }
  if (onward.length === 0) {
    takeGasket(s, gasket);
    w.endPort = { position: far.xyz, direction: normalize3(sub3(w.end, far.xyz)), dn: far.boreMm };
    w.end = far.xyz;
    w.key = farKey;
    return 'again';
  }
  const mate = onward.find((j) => comp(s, j).type === 'FLANGE' && flangedFaceAt(s, j, farKey));
  const outPoint = mate === undefined ? undefined : otherEnd(comp(s, mate), farKey);
  if (mate !== undefined && outPoint !== undefined) {
    midLineJoint(s, w, component, exitPoint, gasket, far, mate, outPoint);
    return 'again';
  }
  const valve = onward.find((j) => comp(s, j).type === 'VALVE' || comp(s, j).type === 'INSTRUMENT');
  if (valve === undefined)
    return refuse(
      'ISO_ROUTE_UNSUPPORTED',
      `flange ${component.id} is joined to something that is neither a flange, a valve nor an instrument: a flanged joint outside a flanged set`,
      [component.id],
    );
  const through = valveSet(s, component, gasket, valve, farKey);
  if ('ok' in through) return through;
  w.inline.push({ ...through.valve, centre: sub3(through.valve.centre, w.shift) });
  appendAll(w.consumed, through.consumed);
  w.end = through.out.xyz;
  w.key = nodeKey(through.out.xyz);
  return 'again';
}

export function flangeStep(s: PlanState, w: Walk, i: number, component: NetworkComponent, exitPoint: NetworkPoint): Step {
  if (exitPoint.endType !== 'FL')
    return refuse(
      'ISO_ROUTE_UNSUPPORTED',
      `flange ${component.id} is entered by its flanged face: a flanged joint that is not a valve set`,
      [component.id],
    );
  const faceKey = nodeKey(exitPoint.xyz);
  const beyond = free(s, faceKey, i);
  const gasket = beyond.length === 1 && comp(s, beyond[0] as number).type === 'GASKET' ? (beyond[0] as number) : undefined;
  const blindBeyond = beyond.find((j) => comp(s, j).type === 'FLANGE-BLIND');
  const flangeBeyond = beyond.find((j) => ['FLANGE', 'VALVE', 'INSTRUMENT'].includes(comp(s, j).type) && flangedFaceAt(s, j, faceKey));
  if (beyond.length === 0 || gasket !== undefined || blindBeyond !== undefined || flangeBeyond !== undefined)
    return onwardStep(s, w, component, exitPoint, gasket);
  return refuse(
    'ISO_ROUTE_UNSUPPORTED',
    `flange ${component.id} is joined to something that is not a gasket: a flanged joint outside a valve set`,
    [component.id],
  );
}
