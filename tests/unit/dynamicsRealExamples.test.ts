/**
 * Real-world checks of simulate_motion: published engine + propeller data in, certified / published static rpm out.
 *
 * Propeller coefficients: NACA Report 684 (Hartman & Biermann 1940), "Static thrust and power characteristics of six full-scale
 * propellers", Figs. 20–21, Clark-Y 2-blade propeller, read from faired curves (±0.003):
 *   β0.75R 15°: CT 0.096, CP 0.042 · 20°: CT 0.104, CP 0.070  (linear between).
 * https://ntrs.nasa.gov/citations/19930091761
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { setPhysicsEngine } from '@core/dynamics/physicsEngine';
import type { SimulationData } from '@dynamics/sim/simulationReport';
import { createMujocoPhysics } from '@physics-mujoco/mujocoPhysics';

beforeAll(async () => {
  setPhysicsEngine(await createMujocoPhysics());
});
afterAll(() => setPhysicsEngine(null));

const HP = 745.7;
const INCH = 0.0254;

/** NACA TR-684 2-blade static coefficients at blade angle β (deg) at 0.75 R, linear between the 15° and 20° readings. */
function naca684TwoBlade(beta: number): { ct: number; cp: number } {
  const f = (beta - 15) / 5;
  return { ct: 0.096 + f * (0.104 - 0.096), cp: 0.042 + f * (0.07 - 0.042) };
}

/** Blade angle at 0.75 R of a propeller of pitch P and diameter D: tan β = P / (π · 0.75 · D). */
const bladeAngle = (pitch: number, diameter: number): number => (Math.atan(pitch / (Math.PI * 0.75 * diameter)) * 180) / Math.PI;

function step(doc: CadDocument, name: string, params: Record<string, unknown>): { doc: CadDocument; id: string } {
  const result = execute(doc, name, params);
  return { doc: result.document, id: result.affected[0] ?? '' };
}

/** Engine (flat torque `torque` N·m) → optional reduction `ratio` → propeller; returns the static (V = 0) speeds after 15 s. */
function staticRun(torque: number, ratio: number, propeller: { diameter: number; ct: number; cp: number }): SimulationData {
  let doc = createEmptyDocument();
  const crankDisc = step(doc, 'add_cylinder', { radius: 80, height: 60, axis: [0, 1, 0], position: [0, 0, 0] });
  const propDisc = step(crankDisc.doc, 'add_cylinder', { radius: 100, height: 40, axis: [0, 1, 0], position: [0, 300, 0] });
  const crank = step(propDisc.doc, 'add_rigid_body', { entityIds: [crankDisc.id], id: 'crank' });
  const prop = step(crank.doc, 'add_rigid_body', { entityIds: [propDisc.id], id: 'prop', density: 600 });
  doc = step(prop.doc, 'add_body_joint', {
    id: 'crank_j',
    kind: 'revolute',
    child: 'crank',
    anchor: [0, 0, 0],
    axis: [0, 1, 0],
    initialRpm: 600,
  }).doc;
  if (ratio === 1) {
    doc = execute(doc, 'add_body_joint', {
      id: 'prop_j',
      kind: 'revolute',
      child: 'prop',
      parent: 'crank',
      anchor: [0, 300, 0],
      axis: [0, 1, 0],
    }).document;
    doc = execute(doc, 'add_motor', { joint: 'crank_j', kind: 'torque_curve', torque }).document;
    doc = execute(doc, 'add_propeller', {
      joint: 'crank_j',
      diameter: propeller.diameter,
      thrustCoefficient: propeller.ct,
      powerCoefficient: propeller.cp,
    }).document;
  } else {
    doc = execute(doc, 'add_body_joint', { id: 'prop_j', kind: 'revolute', child: 'prop', anchor: [0, 300, 0], axis: [0, 1, 0] }).document;
    doc = execute(doc, 'add_gear_coupling', { driver: 'crank_j', driven: 'prop_j', ratio }).document;
    doc = execute(doc, 'add_motor', { joint: 'crank_j', kind: 'torque_curve', torque }).document;
    doc = execute(doc, 'add_propeller', {
      joint: 'prop_j',
      diameter: propeller.diameter,
      thrustCoefficient: propeller.ct,
      powerCoefficient: propeller.cp,
    }).document;
  }
  return execute(doc, 'simulate_motion', { duration: 15 }).data as SimulationData;
}

describe('real examples', () => {
  /**
   * Cessna 150, FAA TCDS 3A19 Rev 50 §I: Continental O-200-A, 100 hp at 2750 rpm, direct drive; 69" fixed-pitch propeller, certified
   * static rpm at full throttle 2320–2470 (Sensenich 69CK) / 2375–2475 (McCauley 1A100). Pitch 50" (McCauley 1A100/MCM 6950).
   * Torque at static rpm taken as the rated torque (flat-torque assumption; no published full-throttle curve was found).
   */
  it('Cessna 150 / O-200-A: simulated static rpm falls in the FAA-certified band', () => {
    const torque = (100 * HP) / ((2750 * 2 * Math.PI) / 60);
    const diameter = 69 * INCH;
    const coefficients = naca684TwoBlade(bladeAngle(50 * INCH, diameter));
    const data = staticRun(torque, 1, { diameter, ...coefficients });
    const rpm = data.joints['crank_j']?.finalRpm ?? 0;
    expect(data.joints['crank_j']?.steady).toBe(true);
    expect(rpm).toBeGreaterThan(2320 * 0.97);
    expect(rpm).toBeLessThan(2475 * 1.03);
    expect(Math.abs(rpm - 2397) / 2397).toBeLessThan(0.05);
  });

  /**
   * Rotec R3600 9-cylinder radial (the class of the llull R-9 model): 150 hp at 3600 engine rpm, 3:2 planetary PSRU, 2-blade 84" × 55"
   * propeller (store.rotecaerosport.com/R3600info). Rotec quotes 2300–2400 prop rpm at TAKE-OFF (with airspeed, so above static);
   * static must come out below that band and within the engine's range.
   */
  it('Rotec R3600 + 84x55 propeller: static prop rpm just below the take-off band, engine below its rated speed', () => {
    const torque = (150 * HP) / ((3600 * 2 * Math.PI) / 60);
    const diameter = 84 * INCH;
    const coefficients = naca684TwoBlade(bladeAngle(55 * INCH, diameter));
    const data = staticRun(torque, 2 / 3, { diameter, ...coefficients });
    const propRpm = data.joints['prop_j']?.finalRpm ?? 0;
    const engineRpm = data.joints['crank_j']?.finalRpm ?? 0;
    expect(propRpm).toBeGreaterThan(1800);
    expect(propRpm).toBeLessThan(2300);
    expect(engineRpm).toBeLessThan(3600);
    expect(engineRpm / propRpm).toBeCloseTo(1.5, 3);
    // the propeller absorbs the full engine power at that point (no losses modelled)
    expect(data.propellers[Object.keys(data.propellers)[0] ?? '']?.power ?? 0).toBeCloseTo(torque * ((engineRpm * 2 * Math.PI) / 60), -1);
  });
});
