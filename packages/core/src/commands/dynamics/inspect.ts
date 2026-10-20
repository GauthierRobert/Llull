/** Inspecting the dynamics model (inspect_dynamics): bodies, joints, topology and mobility. */

import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { report } from '../noop';
import { toMetres } from '../../model/units';
import { buildSimulationModel } from '../../dynamics/simulationModel';
import { buildTopology, isRefusal } from '../../dynamics/topology';
import { LOOP_OPEN_TOLERANCE_M, analyseMobility, type MobilityResult } from '../../dynamics/mobility';
import { dynamicsOf } from './bodies';

/** Distance from `point` to the line through `anchor` along unit `axis`. */
function distanceToAxis(point: readonly number[], anchor: readonly number[], axis: readonly number[]): number {
  const d = [0, 1, 2].map((i) => (point[i] ?? 0) - (anchor[i] ?? 0));
  const along = d.reduce((sum, value, i) => sum + value * (axis[i] ?? 0), 0);
  return Math.sqrt(Math.max(0, d.reduce((sum, value) => sum + value * value, 0) - along * along));
}

/** Loops whose two pins are further apart than the tolerance at the start pose: `id -> gap (m)`. */
export function openLoopGaps(mobility: MobilityResult): Record<string, number> {
  return Object.fromEntries(Object.entries(mobility.loopGapsM).filter(([, gap]) => gap > LOOP_OPEN_TOLERANCE_M));
}

/**
 * @affects nothing — read-only; data { bodies, joints, gears, motors, propellers, problems, warnings, topology?, mobility?, loopGapsM? }
 * @failure none: an empty model reports empty tables and the problem "no rigid bodies"; a refused topology or an open loop is a problem
 */
export const inspectDynamics = defineCommand({
  name: 'inspect_dynamics',
  annotations: { readOnly: true },
  description:
    'List the physics model: every rigid body with its computed mass (kg), centre of mass (document units) and moment of inertia about ' +
    'its joint axis (kg·m², revolute joints; a prismatic joint reports translatingMassKg instead: the body plus the bodies it carries) and the densities used (densitySources, densityDefaulted: true when the steel default filled in, with a DYN_DENSITY_DEFAULTED warning; unverified), plus joints, gear couplings (ratio, teeth, efficiency), motors, propellers (with their Ct / Cp table), cylinder pressures and engine losses (losses, only when set), and any problem that would stop ' +
    'simulate_motion. With mobility true (default) it also reports the closed-loop structure: data.topology { tree: spanning-tree ' +
    'joints rooted at the ground, loops: joints that close loops, flipped: tree joints whose declared parent/child sense is reversed }, ' +
    'data.mobility { gruebler: 6·bodies − joint constraints; rank: numerical rank of the loop-constraint Jacobian at the start pose; ' +
    'dof: tree coordinates − rank = true degrees of freedom (a crank-driven slider-crank has 1); redundant: constraint rows that repeat ' +
    'what the tree already fixes (FPR_REDUNDANT_CONSTRAINT, with the joint to change; make one revolute loop joint spherical); ' +
    'treeCoordinates, constraintRows } and data.loopGapsM (distance in metres between the two pins of each loop at the start pose; ' +
    'above 1 µm simulate_motion refuses with FPR_LOOP_OPEN). Gear couplings are not counted in the degrees of freedom. Use it to check ' +
    'a setup before simulating. Read-only; needs no physics engine.',
  params: z.object({ mobility: z.boolean().optional().describe('Report data.topology, data.mobility and data.loopGapsM (default true).') }),
  run: (doc, params, ctx): CommandResult => {
    const dynamics = dynamicsOf(doc);
    const built = buildSimulationModel(doc, 0.001, ctx?.kernel);
    const metres = toMetres(doc, 1);
    const problems = 'error' in built ? [built.code !== undefined ? `${built.code}: ${built.error}` : built.error] : [];
    const warnings: string[] = [];
    const bodies =
      'error' in built
        ? {}
        : Object.fromEntries(
            built.model.bodies.map((body) => {
              const axis = body.joint?.axis;
              const [ixx, iyy, izz, ixy, ixz, iyz] = body.inertia;
              const aboutAxis =
                axis === undefined
                  ? null
                  : ixx * axis[0] ** 2 +
                    iyy * axis[1] ** 2 +
                    izz * axis[2] ** 2 +
                    2 * (ixy * axis[0] * axis[1] + ixz * axis[0] * axis[2] + iyz * axis[1] * axis[2]);
              const prismatic = body.joint?.kind === 'prismatic';
              const carried = (id: string): number =>
                (built.model.bodies.find((candidate) => candidate.id === id)?.mass ?? 0) +
                built.model.bodies.filter((child) => child.parentId === id).reduce((sum, child) => sum + carried(child.id), 0);
              const offset = body.joint === null ? 0 : distanceToAxis(body.centerOfMass, body.joint.anchor, body.joint.axis);
              const density = built.mass[body.id];
              if (density?.densityDefaulted === true)
                warnings.push(`DYN_DENSITY_DEFAULTED: body '${body.id}' uses the steel default (7850 kg/m^3) for parts without a material`);
              return [
                body.id,
                {
                  name: dynamics.bodies[body.id]?.name ?? null,
                  massKg: body.mass,
                  centerOfMass: body.centerOfMass.map((c) => c / metres),
                  fixed: body.fixed,
                  joint: body.joint?.id ?? null,
                  // parallel axis: about the joint axis, not the centre of mass
                  inertiaAboutJointAxis: aboutAxis === null || prismatic ? null : aboutAxis + body.mass * offset * offset,
                  // a prismatic joint moves mass, not inertia: the body plus everything it carries
                  translatingMassKg: prismatic ? carried(body.id) : null,
                  densitySources: density?.densitySources ?? [],
                  densityDefaulted: density?.densityDefaulted ?? false,
                  unverified: (density?.unverifiedReasons.length ?? 0) > 0,
                },
              ];
            }),
          );
    const structure = (() => {
      if (params.mobility === false) return null;
      const topology = buildTopology(dynamics);
      if (isRefusal(topology)) return null;
      const mobility = analyseMobility(dynamics, topology, metres);
      for (const row of mobility.redundant) warnings.push(`FPR_REDUNDANT_CONSTRAINT: ${row.message}`);
      for (const gear of mobility.skippedGears)
        warnings.push(
          `FPR_GEAR_ON_LOOP_JOINT: gear coupling '${gear}' has a loop-closing joint on one side, so the mobility count does not include it`,
        );
      for (const suggestion of mobility.suggestions) warnings.push(`FPR_REDUNDANT_CONSTRAINT: suggestion — ${suggestion}`);
      for (const [id, gap] of Object.entries(openLoopGaps(mobility)))
        problems.push(`FPR_LOOP_OPEN: loop joint '${id}' is open by ${(gap * 1000).toPrecision(4)} mm at the start pose`);
      return {
        topology: {
          tree: topology.tree.map((entry) => ({ joint: entry.joint.id, parent: entry.parent, child: entry.child, flipped: entry.flipped })),
          loops: topology.loops.map((loop) => ({ joint: loop.id, kind: loop.kind, parent: loop.parent, child: loop.child })),
          flipped: topology.flipped,
        },
        mobility: {
          gruebler: mobility.gruebler,
          rank: mobility.rank,
          dof: mobility.dof,
          treeCoordinates: mobility.treeCoordinates,
          constraintRows: mobility.constraintRows,
          redundant: mobility.redundant,
          suggestions: mobility.suggestions,
        },
        loopGapsM: mobility.loopGapsM,
      };
    })();
    const data = {
      bodies,
      joints: dynamics.joints,
      gears: dynamics.gears,
      motors: dynamics.motors,
      propellers: dynamics.propellers,
      cylinders: dynamics.cylinders ?? {},
      ...(Object.keys(dynamics.losses ?? {}).length > 0 ? { losses: dynamics.losses } : {}),
      problems,
      warnings,
      ...(structure ?? {}),
    };
    const lines = Object.entries(bodies).map(
      ([id, body]) =>
        `${id}${body.name !== null ? ` (${body.name})` : ''}: ${body.massKg.toPrecision(4)} kg` +
        (body.inertiaAboutJointAxis !== null
          ? `, I = ${body.inertiaAboutJointAxis.toPrecision(4)} kg·m² about joint ${body.joint ?? ''}`
          : body.translatingMassKg !== null
            ? `, translating mass ${body.translatingMassKg.toPrecision(4)} kg along joint ${body.joint ?? ''}`
            : '') +
        (body.fixed ? ', fixed' : ''),
    );
    const counts =
      `${Object.keys(dynamics.joints).length} joint(s), ${Object.keys(dynamics.gears).length} gear(s), ` +
      `${Object.keys(dynamics.motors).length} motor(s), ${Object.keys(dynamics.propellers).length} propeller(s)` +
      `${Object.keys(dynamics.cylinders ?? {}).length > 0 ? `, ${Object.keys(dynamics.cylinders ?? {}).length} cylinder(s)` : ''}`;
    const mobilityText =
      structure !== null
        ? ` Mobility: ${structure.mobility.dof} DOF (Gruebler ${structure.mobility.gruebler}, rank ${structure.mobility.rank}), ` +
          `tree [${structure.topology.tree.map((entry) => entry.joint).join(', ')}], loops [${structure.topology.loops.map((loop) => loop.joint).join(', ')}]` +
          `${structure.mobility.redundant.length > 0 ? `, ${structure.mobility.redundant.length} redundant constraint row(s)` : ''}.`
        : '';
    const summary =
      problems.length > 0
        ? `inspect_dynamics: not simulatable — ${problems.join('; ')}. ${counts}.${mobilityText}`
        : `inspect_dynamics: ${lines.join('; ')}. ${counts}.${mobilityText}${warnings.length > 0 ? ` Warnings: ${warnings.join('; ')}.` : ''}`;
    return report(doc, summary, data);
  },
});
