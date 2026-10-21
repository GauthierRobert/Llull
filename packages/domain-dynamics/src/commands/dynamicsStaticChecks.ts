/** Static (no simulation) items of check_dynamics: input realism, losses and loop topology of `doc.dynamics`. */

import type { CadDocument } from '@core/model/types';
import type { CheckThreshold } from '@core/model/checkResult';
import type { GeometryKernel } from '@core/geometry/kernel';
import { bodyMassProperties } from '@core/geometry/bodyMassProperties';
import { buildTopology, isRefusal } from '../sim/topology';
import { analyseMobility, LOOP_OPEN_TOLERANCE_M } from '../sim/mobility';
import { toMetres } from '@core/model/units';
import { type ReviewItem, reviewItem } from '@core/model/reviewEnvelope';
import { dynamicsOf } from './bodies';
import { openLoopGaps } from './inspect';

/** No real static propeller exceeds a figure of merit of ~0.75 (NACA TR-684); above 0.8 the Ct / Cp pair is not physical (named default). */
const MAX_FIGURE_OF_MERIT: CheckThreshold = {
  value: 0.8,
  unit: 'dimensionless',
  source: 'NACA TR-684 (static figure of merit ~0.75 at best); llull named default',
  grade: 'C',
  defaulted: true,
};
/** Above this tip Mach number compressibility, which the model does not include, changes thrust and power (named default). */
export const MAX_TIP_MACH: CheckThreshold = {
  value: 0.85,
  unit: 'dimensionless',
  source: 'compressibility onset, llull named default (simulate_motion warning)',
  grade: 'C',
  defaulted: true,
};

type Simulatable = { readonly ok: true; readonly loops: number } | { readonly ok: false; readonly why: string };

export interface StaticOutcome {
  readonly items: ReviewItem[];
  readonly simulatable: Simulatable;
}

const item = (
  code: string,
  status: ReviewItem['status'],
  ids: readonly string[],
  remediation: string,
  extra?: Partial<ReviewItem>,
): ReviewItem => reviewItem('dynamics', code, status, ids, remediation, extra);

function massItems(doc: CadDocument, kernel: GeometryKernel | null): ReviewItem[] {
  const dynamics = dynamicsOf(doc);
  const moving = Object.values(dynamics.bodies).filter((body) => !body.fixed);
  const defaulted: string[] = [];
  const failed: string[] = [];
  let defaultedKg = 0;
  for (const body of moving) {
    const props = bodyMassProperties(doc, body, kernel);
    if ('error' in props) failed.push(body.id);
    else if (props.densityDefaulted) {
      defaulted.push(body.id);
      defaultedKg += props.mass;
    }
  }
  const fix = 'Give the body a sourced material (assign_material on its entities), a measured massKg or a density in add_rigid_body.';
  if (failed.length > 0)
    return [
      item(
        'FPR_MASS_DEFAULTED',
        'not_run',
        failed,
        `The mass of ${failed.length} body(ies) could not be computed (see inspect_dynamics): fix them. ${fix}`,
        { unverified: true },
      ),
    ];
  if (defaulted.length > 0)
    return [
      item('FPR_MASS_DEFAULTED', 'warn', defaulted, `${fix} Results that depend on these masses are unverified.`, {
        values: { defaultedBodies: defaulted.length, defaultedMassKg: defaultedKg },
        unverified: true,
        note: 'Mass fell back to the steel default density 7850 kg/m3; an aluminium or hollow part would be several times too heavy.',
      }),
    ];
  return [item('FPR_MASS_DEFAULTED', 'pass', [], 'None.', { values: { bodies: moving.length } })];
}

function lossItems(doc: CadDocument): ReviewItem[] {
  const dynamics = dynamicsOf(doc);
  const joints = Object.values(dynamics.joints);
  if (joints.length === 0) return [];
  const damped = joints.filter((joint) => joint.damping > 0 || joint.friction > 0).length;
  const dampers = Object.values(dynamics.springs ?? {}).filter((spring) => spring.damping > 0).length;
  const propellers = Object.keys(dynamics.propellers).length;
  const values = { dampedJoints: damped, springDampers: dampers, propellers };
  if (damped + dampers + propellers > 0) return [item('FPR_NO_LOSSES', 'pass', [], 'None.', { values })];
  return [
    item(
      'FPR_NO_LOSSES',
      'warn',
      joints.map((joint) => joint.id),
      'Set damping / friction on the joints (add_body_joint) from measured data, or add the load (add_propeller): without losses a driven mechanism never settles and brake quantities are not meaningful.',
      { values, unverified: true, note: 'No joint damping or friction, spring damper or propeller anywhere: the model is lossless.' },
    ),
  ];
}

function propellerItems(doc: CadDocument): ReviewItem[] {
  return Object.values(dynamicsOf(doc).propellers).map((propeller): ReviewItem => {
    const merit =
      propeller.powerCoefficient > 0 ? propeller.thrustCoefficient ** 1.5 / (propeller.powerCoefficient * Math.sqrt(Math.PI / 2)) : null;
    const over = merit !== null && merit > MAX_FIGURE_OF_MERIT.value;
    return item(
      'FPR_UNREALISTIC',
      over ? 'warn' : 'pass',
      [propeller.id],
      over ? 'Check the propeller thrustCoefficient / powerCoefficient (add_propeller) against its measured table.' : 'None.',
      { values: merit === null ? {} : { figureOfMerit: merit }, ...(over ? { threshold: MAX_FIGURE_OF_MERIT, unverified: true } : {}) },
    );
  });
}

function loopItems(doc: CadDocument): { items: ReviewItem[]; simulatable: Simulatable } {
  const dynamics = dynamicsOf(doc);
  const topology = buildTopology(dynamics);
  if (isRefusal(topology)) {
    const why = `${topology.code}: ${topology.error}`;
    return {
      items: [
        item(
          topology.code,
          'fail',
          topology.ids,
          `${topology.error} Change the joints (add_body_joint / delete_dynamics_item) and re-check.`,
        ),
      ],
      simulatable: { ok: false, why },
    };
  }
  if (topology.loops.length === 0) return { items: [], simulatable: { ok: true, loops: 0 } };
  const mobility = analyseMobility(dynamics, topology, toMetres(doc, 1));
  const gaps = Object.entries(openLoopGaps(mobility));
  const ids = topology.loops.map((loop) => loop.id);
  const items: ReviewItem[] = [];
  const limit = {
    value: LOOP_OPEN_TOLERANCE_M * 1000,
    unit: 'mm',
    source: 'FR-FPR-12 named default 1e-6 m',
    grade: 'C',
    defaulted: true,
  } as const;
  if (gaps.length > 0)
    items.push(
      item(
        'FPR_LOOP_OPEN',
        'fail',
        gaps.map(([id]) => id),
        'Fix the joint anchors (anchorOnChild) so both pins of each loop coincide at the start pose.',
        { values: { maxGapMm: Math.max(...gaps.map(([, gap]) => gap * 1000)), loops: ids.length }, threshold: limit },
      ),
    );
  else
    items.push(
      item('FPR_LOOP_OPEN', 'pass', ids, 'None.', {
        values: { loops: ids.length, maxGapMm: Math.max(0, ...Object.values(mobility.loopGapsM)) * 1000 },
        threshold: limit,
      }),
    );
  if (mobility.redundant.length > 0)
    items.push(
      item(
        'FPR_REDUNDANT_CONSTRAINT',
        'warn',
        [...new Set(mobility.redundant.map((row) => row.loop))],
        `Make one revolute joint of the loop spherical (add_body_joint kind spherical). ${mobility.suggestions.join(' ')}`.trim(),
        { values: { redundantRows: mobility.redundant.length }, note: mobility.redundant.map((row) => row.message).join(' | ') },
      ),
    );
  else items.push(item('FPR_REDUNDANT_CONSTRAINT', 'pass', ids, 'None.', { values: { loops: ids.length } }));
  return {
    items,
    simulatable:
      gaps.length > 0
        ? { ok: false, why: `FPR_LOOP_OPEN: ${gaps.length} loop(s) open at the start pose` }
        : { ok: true, loops: topology.loops.length },
  };
}

/** Static items of the document's dynamics model, and whether the simulation can start. */
export function staticChecks(doc: CadDocument, kernel: GeometryKernel | null): StaticOutcome {
  const loops = loopItems(doc);
  return { items: [...massItems(doc, kernel), ...propellerItems(doc), ...lossItems(doc), ...loops.items], simulatable: loops.simulatable };
}
