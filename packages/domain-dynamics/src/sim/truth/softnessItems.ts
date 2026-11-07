/**
 * Softness of the constraint model in check_motion_truth (PHY-23 TR-DRV-23 (c)): how far an end stop or a backlash row gave way against its travel / gap, and
 * whether the inertia its stiffness and damping were scaled to (static in the configuration, spec 13.15 item 4) can differ from the one the run met.
 * DRV-M2 leftover, decision (spec 13.18): the per-step solref rewrite for a configuration-dependent J_eff is NOT built; this check flags the variation instead.
 */

import type { CheckThreshold } from '@core/model/checkResult';
import type { DynamicsModel } from '@core/model/dynamics';
import { type ReviewItem, reviewItem } from '@core/model/reviewEnvelope';
import { couplingsOf, transmissionJoints } from '@core/model/transmissions';
import type { RunData } from '../runData';
import type { Topology } from '../topology';

/** Penetration of a stop at or under this fraction of its travel / gap passes (TR-DRV-23 (c)). */
const PENETRATION_PASS = 0.01;
const PENETRATION_FAIL = 0.1;
/** A downstream joint counts as having moved when its travel over the run exceeds this (0.5 deg, 1 mm). */
const MOVED_RAD = (0.5 * Math.PI) / 180;
const MOVED_M = 1e-3;

const threshold: CheckThreshold = {
  value: PENETRATION_PASS,
  unit: 'peak penetration / travel (or gap)',
  source: 'TR-DRV-23 (c): stop / backlash penetration at most 1 % of the travel / gap',
  grade: 'C',
  defaulted: true,
};

/** Travel (limits, rad or m) or gap (backlash) a stop key refers to, or null when the model has no such stop. */
function travelOf(dynamics: DynamicsModel, key: string): number | null {
  const limits = dynamics.jointPhysics?.[key]?.limits;
  if (limits !== undefined) return limits.max - limits.min;
  const transmission = dynamics.transmissions?.[key];
  if (transmission?.kind === 'gear' && transmission.backlashDeg !== undefined) return (transmission.backlashDeg * Math.PI) / 180;
  if (transmission?.kind === 'rack_pinion' && transmission.backlashMm !== undefined) return transmission.backlashMm * 1e-3;
  return null;
}

/** DRV_STOP_PENETRATION per end stop / backlash row of the run: peak penetration against its travel or gap. */
export function stopPenetrationItems(run: RunData, dynamics: DynamicsModel): ReviewItem[] {
  return Object.entries(run.stops ?? {}).flatMap(([key, stop]): ReviewItem[] => {
    const travel = travelOf(dynamics, key);
    if (travel === null || !(travel > 0)) return [];
    const ratio = stop.peakPenetration / travel;
    const status: ReviewItem['status'] = ratio <= PENETRATION_PASS ? 'pass' : ratio <= PENETRATION_FAIL ? 'warn' : 'fail';
    return [
      reviewItem(
        'dynamics',
        'DRV_STOP_PENETRATION',
        status,
        [key],
        status === 'pass' ? 'None.' : 'The stop gives way too far for its travel: raise its stiffness (set_joint_physics limits / add_transmission meshStiffness) or lower the impact speed.',
        {
          values: { peakPenetration: stop.peakPenetration, travel, penetrationRatio: ratio, peakForce: stop.peakForce, effectiveInertia: stop.effectiveInertia },
          threshold,
          ...(status === 'pass' ? {} : { unverified: true }),
        },
      ),
    ];
  });
}

/** Joints rigidly coupled to `joint` by transmissions (they share the stop's cluster inertia, which `reflectedInertia` accounts for). */
function coupledTo(dynamics: DynamicsModel, joint: string): Set<string> {
  const cluster = new Set([joint]);
  const couplings = couplingsOf(dynamics);
  for (let pass = 0; pass <= couplings.length; pass++)
    for (const coupling of couplings)
      if (cluster.has(coupling.driver) || cluster.has(coupling.driven)) [coupling.driver, coupling.driven].forEach((id) => cluster.add(id));
  return cluster;
}

/** Tree joints below `joint` (the joint carrying `joint`'s child body, and everything attached to it), by body. */
function downstreamJoints(topology: Topology, joint: string): string[] {
  const entry = topology.tree.find((candidate) => candidate.joint.id === joint);
  if (entry === undefined) return [];
  const bodies = new Set([entry.child]);
  const found: string[] = [];
  for (let pass = 0; pass <= topology.tree.length; pass++)
    for (const other of topology.tree)
      if (bodies.has(other.parent) && other.joint.id !== joint && !found.includes(other.joint.id)) {
        found.push(other.joint.id);
        bodies.add(other.child);
      }
  return found;
}

/** Stop keys of the run with the joints each one acts on (a limit: its joint; a backlash: the transmission's driver and driven joints). */
function stopJoints(dynamics: DynamicsModel, key: string): string[] {
  if (dynamics.jointPhysics?.[key]?.limits !== undefined) return [key];
  const transmission = dynamics.transmissions?.[key];
  if (transmission === undefined) return [];
  const { driver, driven } = transmissionJoints(transmission);
  return [driver, driven];
}

/**
 * DRV_STOP_INERTIA_VARIES: a stop or backlash row whose joint carries other moving joints (or sits in a closed loop) was damped for the inertia at the start
 * configuration; when the joints below it moved during the run the effective inertia was different and the stop's peak force and restitution are approximate.
 * An item per such row: `warn` when a joint below it travelled more than 0.5 deg / 1 mm, `pass` when it stayed put. No item for a stop that carries nothing.
 */
export function inertiaVariationItems(run: RunData, dynamics: DynamicsModel, topology: Topology): ReviewItem[] {
  return Object.keys(run.stops ?? {}).flatMap((key): ReviewItem[] => {
    const own = stopJoints(dynamics, key);
    const cluster = new Set(own.flatMap((joint) => [...coupledTo(dynamics, joint)]));
    const candidates = new Set([
      ...own.flatMap((joint) => downstreamJoints(topology, joint)),
      ...(topology.loops.length > 0 ? topology.tree.map((entry) => entry.joint.id) : []),
    ]);
    const others = [...candidates].filter((joint) => !cluster.has(joint));
    if (others.length === 0) return [];
    const travel = (joint: string): number => {
      const positions = run.series?.jointPosition[joint] ?? [];
      return positions.length === 0 ? 0 : Math.max(...positions) - Math.min(...positions);
    };
    const moved = others.filter((joint) => travel(joint) > (dynamics.joints[joint]?.kind === 'prismatic' ? MOVED_M : MOVED_RAD));
    const status: ReviewItem['status'] = moved.length > 0 ? 'warn' : 'pass';
    return [
      reviewItem(
        'dynamics',
        'DRV_STOP_INERTIA_VARIES',
        status,
        [key, ...moved],
        status === 'pass'
          ? 'None.'
          : 'Hold the joints below the stop still during contact, or treat its peak force and restitution as approximate: the stop was damped for the inertia at the start configuration (per-step rewrite not built, spec 13.18).',
        {
          values: { jointsBelow: others.length, jointsMoved: moved.length, largestTravel: Math.max(0, ...others.map(travel)) },
          note: `stop '${key}' acts on ${own.map((id) => `'${id}'`).join(', ')}; ${others.length} other joint(s) ${topology.loops.length > 0 ? 'of a closed-loop mechanism ' : 'below it '}change its effective inertia with the configuration; ${moved.length} of them moved during the run (${moved.join(', ') || 'none'})`,
          ...(status === 'pass' ? {} : { unverified: true }),
        },
      ),
    ];
  });
}
