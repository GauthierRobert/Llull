/**
 * Single-cylinder Rotax-912-class demonstrator for the PHY-21 realism tests (README sec. 4): bore 84 mm, stroke 61 mm (r 30.5 mm), rod 130 mm
 * (low-confidence test value), CR 10.8, four cylinders' worth of brake torque shared by this one (cylinderCount 4). Friction constants and
 * masses are stated TEST values, not data of a real engine.
 */
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { sliderCrank } from './sliderCrankFixture';

export const BORE_MM = 84;
const R = 0.0305;
const L = 0.13;
const CYLINDER_COUNT = 4;
/** The rated brake torque of 73.5 kW at 5800 rpm (VC-FPR-15b). */
export const RATED_BRAKE_TORQUE_NM = 121.012637765;
export const RATED_RPM = 5800;

/** Chen-Flynn test constants: about 1.45 bar FMEP at the rated point. */
export const CHEN_FLYNN = {
  kind: 'chen_flynn',
  aPa: 40_000,
  bRatio: 0.005,
  cPaPerRpm: 5,
  dPaPerRpm2: 1.5e-6,
  source: 'test input (not measured data)',
};

export const singleZone = (heat: Record<string, unknown>): Record<string, unknown> => ({
  kind: 'single_zone',
  burn: { ca50Deg: 9, durationDeg: 50, a: 5, m: 2 },
  intakePressurePa: 95_000,
  intakeTempK: 330,
  heat,
  source: 'test input',
});

export function step(doc: CadDocument, command: string, params: Record<string, unknown>): { doc: CadDocument; id: string } {
  const result = execute(doc, command, params);
  if (result.affected.length === 0) throw new Error(result.summary);
  return { doc: result.document, id: result.affected[0] ?? '' };
}

/** The slider-crank with friction and a single-zone cylinder calibrated to the rated brake torque. */
export function calibratedEngine(options: { pistonKg?: number; rodKg?: number; crankInertia?: number } = {}): {
  doc: CadDocument;
  cylinder: string;
} {
  const { doc } = sliderCrank({
    rMm: R * 1000,
    lMm: L * 1000,
    crankRpm: RATED_RPM,
    crankInertia: options.crankInertia ?? 0.2,
    pistonKg: options.pistonKg ?? 0.4,
    rodKg: options.rodKg ?? 0.4,
    startDeg: 25,
  });
  const weightless = execute(doc, 'set_gravity', { gravity: [0, 0, 0] }).document;
  const losses = step(weightless, 'set_engine_losses', { crank: 'crank_j', model: CHEN_FLYNN });
  const cylinder = step(losses.doc, 'add_cylinder_pressure', {
    piston: 'slide_j',
    crank: 'crank_j',
    boreMm: BORE_MM,
    compressionRatio: 10.8,
    model: singleZone({
      kind: 'calibrate_brake',
      brake: [{ rpm: RATED_RPM, brakeTorqueNm: RATED_BRAKE_TORQUE_NM }],
      cylinderCount: CYLINDER_COUNT,
    }),
  });
  return { doc: cylinder.doc, cylinder: cylinder.id };
}
