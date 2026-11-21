/** The walk of one run of the route plan: the start flange set, then component after component along the pipe until a port, a cap or a blind closes it. */

import type { Vec3 } from '@core/model/vectors';
import { add3, distance3, normalize3, sub3 } from '@lib/vec3';
import { nodeKey } from '../joints';
import type { NetworkComponent, NetworkPoint } from '../model';
import { bodyOf } from './inlineBody';
import { eccentricStep, isShifted, storedCorner, ZERO } from './eccentric';
import { flangeStep } from './planFlange';
import {
  addBranch,
  arrive,
  comp,
  free,
  midpoint,
  otherEnd,
  refuse,
  take,
  tappingRefusal,
  type PlanState,
  type Step,
  type Walk,
} from './planState';
import type { RouteRefusal } from './planTypes';

/** The axis-parallel corner of an elbow whose centre is not given (the L through the first axis the end points differ on). */
const cornerOf = (a: Vec3, b: Vec3): Vec3 => {
  const axis = [0, 1, 2].find((at) => Math.abs((b[at] as number) - (a[at] as number)) > 1e-6) ?? 0;
  return [axis === 0 ? b[0] : a[0], axis === 1 ? b[1] : a[1], axis === 2 ? b[2] : a[2]];
};

/** A flange set at the free start (an optional gasket on the face, then the flange entered by its flanged face) is the start port. */
export function startFlangeSet(s: PlanState, w: Walk, startEnd: NetworkPoint): RouteRefusal | undefined {
  arrive(s, w.key);
  const gasket = free(s, w.key).find((i) => comp(s, i).type === 'GASKET');
  const faceKey = gasket === undefined ? w.key : nodeKey(otherEnd(comp(s, gasket), w.key)?.xyz ?? startEnd.xyz);
  const flange = free(s, faceKey, ...(gasket === undefined ? [] : [gasket])).find(
    (i) => comp(s, i).type === 'FLANGE' && comp(s, i).ends.some((e) => e.endType === 'FL' && nodeKey(e.xyz) === faceKey),
  );
  if (flange === undefined) return undefined;
  const joint = otherEnd(comp(s, flange), faceKey);
  if (joint === undefined)
    return refuse('ISO_ROUTE_UNSUPPORTED', `flange ${comp(s, flange).id} has no second end point`, [comp(s, flange).id]);
  if (gasket !== undefined) {
    take(s, gasket);
    s.rebuilt.push(comp(s, gasket).id);
  }
  take(s, flange);
  w.consumed.push(comp(s, flange).id);
  w.startPort = { position: startEnd.xyz, direction: normalize3(sub3(joint.xyz, startEnd.xyz)), dn: startEnd.boreMm };
  w.key = nodeKey(joint.xyz);
  w.end = joint.xyz;
  return undefined;
}

/**
 * The main run starts at a closed end (the line has another closed end, so the walk could not start at an open one): a CAP, or a blind flange with its gasket and
 * the flange behind it, is read from the free first end `startEnd` (the closure's closed end) and the walk begins on the pipe side of it.
 */
export function startClosure(s: PlanState, w: Walk, startEnd: NetworkPoint, closure: number): RouteRefusal | undefined {
  const component = comp(s, closure);
  const mouthPoint = otherEnd(component, w.key);
  if (mouthPoint === undefined)
    return refuse('ISO_ROUTE_UNSUPPORTED', `${component.type} ${component.id} has no second end point`, [component.id]);
  take(s, closure);
  w.consumed.push(component.id);
  if (component.type === 'CAP') {
    w.startCap = { kind: 'cap', mouth: mouthPoint.xyz, tip: startEnd.xyz };
    w.key = nodeKey(mouthPoint.xyz);
    w.end = mouthPoint.xyz;
    return undefined;
  }
  const matingKey = nodeKey(mouthPoint.xyz);
  const gasket = free(s, matingKey).find((i) => comp(s, i).type === 'GASKET');
  const faceKey = gasket === undefined ? matingKey : nodeKey(otherEnd(comp(s, gasket), matingKey)?.xyz ?? mouthPoint.xyz);
  const flange = free(s, faceKey, ...(gasket === undefined ? [] : [gasket])).find(
    (i) => comp(s, i).type === 'FLANGE' && comp(s, i).ends.some((e) => e.endType === 'FL' && nodeKey(e.xyz) === faceKey),
  );
  const joint = flange === undefined ? undefined : otherEnd(comp(s, flange), faceKey);
  if (flange === undefined || joint === undefined)
    return refuse(
      'ISO_ROUTE_UNSUPPORTED',
      `blind flange ${component.id} has no flange behind it (the closed start needs flange, [gasket], blind)`,
      [component.id],
    );
  if (gasket === undefined) s.gasketless.push(comp(s, flange).id, component.id);
  else {
    take(s, gasket);
    s.rebuilt.push(comp(s, gasket).id);
  }
  take(s, flange);
  w.consumed.push(comp(s, flange).id);
  w.startCap = { kind: 'blindFlange', mouth: mouthPoint.xyz, tip: startEnd.xyz };
  w.key = nodeKey(joint.xyz);
  w.end = joint.xyz;
  return undefined;
}

function elbowStep(w: Walk, component: NetworkComponent, exit: NetworkPoint): Step {
  const [a, b] = [component.ends[0]?.xyz, component.ends[1]?.xyz];
  if (a === undefined || b === undefined) return refuse('ISO_ROUTE_UNSUPPORTED', `${component.id} has no end points`, [component.id]);
  const centre = component.centre ?? cornerOf(a, b);
  const next = sub3(exit.xyz, centre);
  w.points.push(isShifted(w.shift) && distance3(exit.xyz, centre) > 1e-6 ? storedCorner(centre, w.shift, normalize3(next)) : centre);
  w.shift = ZERO;
  return 'advance';
}

function teeStep(s: PlanState, w: Walk, component: NetworkComponent): Step {
  const [a, b] = [component.ends[0]?.xyz, component.ends[1]?.xyz];
  const centre = component.centre ?? (a !== undefined && b !== undefined ? midpoint(a, b) : undefined);
  if (isShifted(w.shift))
    return refuse(
      'ISO_ROUTE_UNSUPPORTED',
      `tee ${component.id} lies downstream of an eccentric reducer on the same leg, where the axis is off the stored line: the RTE cannot branch there`,
      [component.id],
    );
  if (component.branch === undefined || centre === undefined)
    return refuse('ISO_ROUTE_UNSUPPORTED', `tee ${component.id} has no branch point`, [component.id]);
  addBranch(s, w.seed.key, centre, component.branch);
  return 'advance';
}

function concentricStep(w: Walk, component: NetworkComponent, exit: NetworkPoint): Step {
  w.inline.push({
    type: 'reducer',
    componentId: component.id,
    centre: sub3(midpoint(component.ends[0]?.xyz ?? w.end, component.ends[1]?.xyz ?? w.end), w.shift),
    dn2: exit.boreMm,
  });
  return 'advance';
}

function eccentricReducerStep(s: PlanState, w: Walk, component: NetworkComponent, exit: NetworkPoint): Step {
  const entry = component.ends.find((reducerEnd) => nodeKey(reducerEnd.xyz) === w.key) ?? exit;
  const stored = sub3(entry.xyz, w.shift);
  const before = w.points[w.points.length - 1] as Vec3;
  const step = eccentricStep(
    component,
    entry,
    exit,
    distance3(stored, before) > 1e-6 ? normalize3(sub3(stored, before)) : undefined,
    s.options.eccentricFlat,
  );
  if ('message' in step) return refuse(step.code, step.message, [component.id]);
  const centre = sub3(midpoint(entry.xyz, exit.xyz), add3(w.shift, [step.offset[0] / 2, step.offset[1] / 2, step.offset[2] / 2]));
  w.inline.push({ type: 'reducer', componentId: component.id, centre, dn2: exit.boreMm, flat: step.flat });
  w.shift = add3(w.shift, step.offset);
  return 'advance';
}

function bodyStep(w: Walk, component: NetworkComponent, entry: NetworkPoint | undefined, exit: NetworkPoint): Step {
  if (component.ends.some((bodyEnd) => bodyEnd.endType === 'FL'))
    return refuse(
      'ISO_ROUTE_UNSUPPORTED',
      `flanged ${component.type.toLowerCase()} ${component.id} is not between two flanges with gaskets`,
      [component.id],
    );
  if (component.type === 'INSTRUMENT' && component.ends.some((bodyEnd) => bodyEnd.endType !== 'BW'))
    return refuse(
      'ISO_ROUTE_UNSUPPORTED',
      `instrument ${component.id} has ${[...new Set(component.ends.map((bodyEnd) => bodyEnd.endType))].join(' / ')} ends: route mode takes an instrument with butt-weld ends, or flanged between flange sets (socket-weld and threaded instruments are not rebuilt)`,
      [component.id],
    );
  const tapped = tappingRefusal(component);
  if (tapped !== undefined) return tapped;
  if (entry === undefined)
    return refuse('ISO_ROUTE_UNSUPPORTED', `${component.type} ${component.id} has no first end point`, [component.id]);
  w.inline.push(bodyOf(component, entry.xyz, exit.xyz, w.shift, false));
  return 'advance';
}

function componentStep(
  s: PlanState,
  w: Walk,
  i: number,
  component: NetworkComponent,
  entry: NetworkPoint | undefined,
  exit: NetworkPoint,
): Step {
  switch (component.type) {
    case 'PIPE':
      return 'advance';
    case 'ELBOW':
    case 'BEND':
      return elbowStep(w, component, exit);
    case 'TEE':
      return teeStep(s, w, component);
    case 'REDUCER-CONCENTRIC':
      return concentricStep(w, component, exit);
    case 'REDUCER-ECCENTRIC':
      return eccentricReducerStep(s, w, component, exit);
    case 'VALVE':
    case 'INSTRUMENT':
      return bodyStep(w, component, entry, exit);
    case 'FLANGE':
      return flangeStep(s, w, i, component, exit);
    default:
      return refuse('ISO_ROUTE_UNSUPPORTED', `route mode does not rebuild ${component.type} ${component.id}`, [component.id]);
  }
}

/** Walks from the current node until a port, a cap, a blind or the end of the chain closes the run. */
export function walkRun(s: PlanState, w: Walk): RouteRefusal | undefined {
  for (let guard = 0; guard <= s.components.length + 2 && w.endPort === undefined && w.cap === undefined; guard++) {
    arrive(s, w.key);
    const i = free(s, w.key)[0];
    if (i === undefined) break;
    const component = comp(s, i);
    if (component.type === 'CAP') {
      take(s, i);
      w.consumed.push(component.id);
      const tip = otherEnd(component, w.key)?.xyz;
      w.cap = { kind: 'cap', mouth: sub3(w.end, w.shift), ...(tip === undefined ? {} : { tip: sub3(tip, w.shift) }) };
      break;
    }
    const exit = otherEnd(component, w.key);
    const entry = component.ends.find((componentEnd) => componentEnd !== exit);
    if (exit === undefined)
      return refuse('ISO_ROUTE_UNSUPPORTED', `${component.type} ${component.id} has no second end point`, [component.id]);
    take(s, i);
    w.consumed.push(component.id);
    const step = componentStep(s, w, i, component, entry, exit);
    if (typeof step === 'object') return step;
    if (step === 'advance') {
      w.end = exit.xyz;
      w.key = nodeKey(exit.xyz);
    }
  }
  return undefined;
}
