/** analyze_wing: finite-wing lift, induced drag and span loading by Prandtl lifting-line theory (Glauert series). */

import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { roundSignificant } from '@lib/significant';
import { briefReport } from './brief';
import { refuseAero } from './codes';
import { solveLiftingLine, wingArea, type WingGeometry } from './liftingLine';
import { parseNaca } from './naca';
import { thinAirfoil } from './panelMethod';
import { airStateParams, isAirState, resolveAirState } from './airState';
import { speedParam, toMetresPerSecond } from './speed';

const RAD = Math.PI / 180;
const sig = (value: number): number => roundSignificant(value, 10);

/** Helmbold's low-aspect-ratio lift slope a0 / (√(1 + (a0/πA)²) + a0/πA) (per rad). */
export const helmboldLiftSlope = (a0: number, aspectRatio: number): number => {
  const k = a0 / (Math.PI * aspectRatio);
  return a0 / (Math.sqrt(1 + k * k) + k);
};

/**
 * @affects none; data = { geometry { span, area, aspectRatio, taperRatio, meanChord }, section, polar [{ alphaDeg, cl, cdi, spanEfficiency, forces? }], liftSlopePerDeg, helmboldLiftSlopePerDeg, stations, warnings, provenance }
 * @invariant odd Glauert terms, collocation on the half span; e = CL²/(π AR CDi); elliptical planform -> e = 1
 * @failure non-positive span / chords, taper outside 0..1, terms outside 2..80 -> AER_PARAM_INVALID; bad naca -> AER_AIRFOIL_INVALID; singular -> AER_SOLVER_FAILED
 */
export const analyzeWing = defineCommand({
  name: 'analyze_wing',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Read-only finite-wing aerodynamics by Prandtl lifting-line theory (Glauert Fourier series, symmetric loading): lift coefficient CL, ' +
    'induced drag CDi, span efficiency e (Oswald factor of induced drag), lift slope and the spanwise lift distribution. Planform ' +
    '`trapezoidal` (rootChord, tipChord; rectangular when equal) or `elliptical` (rootChord = centre chord); `twistDeg` = linear twist ' +
    'root -> tip (negative = washout). Section: `naca` gives the thin-airfoil zero-lift angle (lift slope 2π), or set ' +
    '`sectionLiftSlopePerRad` (default 2π, flagged defaulted; use analyze_airfoil or test data) and `zeroLiftAngleDeg`. Lengths are in any ' +
    'one unit (metres when forces are wanted). With `speed` + air state (altitudeM or densityKgM3) it returns lift and induced drag in N. ' +
    'Valid for unswept wings of aspect ratio above about 4, attached flow, low Mach (no compressibility, no stall).',
  params: z.object({
    span: z.number().describe('Wing span b tip to tip, > 0 (metres when forces are wanted).'),
    rootChord: z.number().describe('Root chord (centre chord of an elliptical wing), > 0, same unit as span.'),
    tipChord: z.number().optional().describe('Tip chord of a trapezoidal wing, 0 < tip <= root. Default = rootChord (rectangular).'),
    planform: z.enum(['trapezoidal', 'elliptical']).optional().describe('trapezoidal (default) or elliptical.'),
    twistDeg: z.number().optional().describe('Linear geometric twist at the tip relative to the root, degrees (washout < 0). Default 0.'),
    naca: z.string().optional().describe('Section NACA designation: zero-lift angle from thin-airfoil theory.'),
    sectionLiftSlopePerRad: z
      .number()
      .optional()
      .describe('Section lift slope a0 per radian. Default 2π (thin-airfoil theory, flagged defaulted).'),
    zeroLiftAngleDeg: z.number().optional().describe('Section zero-lift angle in degrees (overrides the naca value). Default 0.'),
    alphasDeg: z.array(z.number()).optional().describe('Root angles of attack in degrees within -15..15, at most 31. Default [0, 5].'),
    terms: z.number().int().optional().describe('Number of odd Fourier terms, 2..80. Default 40.'),
    ...speedParam,
    ...airStateParams,
  }),
  run: (doc, params): CommandResult => {
    const fail = (code: string, message: string, paths: string[] = []): CommandResult =>
      refuseAero(doc, 'analyze_wing', code, message, [], paths);
    const planform = params.planform ?? 'trapezoidal';
    const root = params.rootChord;
    const tip = params.tipChord ?? root;
    const terms = params.terms ?? 40;
    const alphas = params.alphasDeg ?? [0, 5];
    if (!(params.span > 0) || !(root > 0) || !(tip > 0 && tip <= root))
      return fail('AER_PARAM_INVALID', 'span and chords must be > 0 with tipChord <= rootChord', ['span']);
    if (!(terms >= 2 && terms <= 80)) return fail('AER_PARAM_INVALID', 'terms must be within 2..80', ['terms']);
    if (alphas.length === 0 || alphas.length > 31 || alphas.some((alpha) => !(Math.abs(alpha) <= 15)))
      return fail('AER_PARAM_INVALID', 'alphasDeg needs 1..31 angles within -15..15 degrees', ['alphasDeg']);
    const slopeDefaulted = params.sectionLiftSlopePerRad === undefined;
    const a0 = params.sectionLiftSlopePerRad ?? 2 * Math.PI;
    if (!(a0 > 0 && a0 < 10)) return fail('AER_PARAM_INVALID', 'sectionLiftSlopePerRad must be within (0, 10)', ['sectionLiftSlopePerRad']);
    let zeroLift = (params.zeroLiftAngleDeg ?? 0) * RAD;
    let zeroLiftSource = params.zeroLiftAngleDeg === undefined ? 'default 0 (symmetric section)' : 'given';
    if (params.naca !== undefined) {
      const section = parseNaca(params.naca);
      if (typeof section === 'string') return fail('AER_AIRFOIL_INVALID', section, ['naca']);
      if (params.zeroLiftAngleDeg === undefined) {
        zeroLift = thinAirfoil((x) => section.camber(x).slope).zeroLiftAngle;
        zeroLiftSource = `thin-airfoil theory of ${section.designation}`;
      }
    }
    const twist = (params.twistDeg ?? 0) * RAD;
    const wing: WingGeometry = {
      span: params.span,
      chordAt: planform === 'elliptical' ? (eta) => root * Math.sqrt(Math.max(0, 1 - eta * eta)) : (eta) => root + (tip - root) * eta,
      twistAt: (eta) => twist * eta,
      sectionLiftSlope: a0,
      zeroLiftAngle: zeroLift,
    };
    const speed = params.speed === undefined ? undefined : toMetresPerSecond(params.speed, params.speedUnit ?? 'm/s');
    const air = speed === undefined ? undefined : resolveAirState(params);
    if (air !== undefined && !isAirState(air)) return fail(air.code, air.message, ['altitudeM']);
    if (speed !== undefined && !(speed >= 0)) return fail('AER_PARAM_INVALID', 'speed must be >= 0', ['speed']);
    const area = planform === 'elliptical' ? (Math.PI / 4) * params.span * root : wingArea(wing);
    const aspectRatio = (params.span * params.span) / area;
    const q = speed !== undefined && air !== undefined && isAirState(air) ? 0.5 * air.densityKgM3 * speed * speed : undefined;
    const solved = alphas.map((alphaDeg) => ({ alphaDeg, solution: solveLiftingLine(wing, alphaDeg * RAD, terms, area) }));
    if (solved.some(({ solution }) => solution === null)) return fail('AER_SOLVER_FAILED', 'singular lifting-line system');
    const polar = solved.map(({ alphaDeg, solution }) => {
      const s = solution as NonNullable<typeof solution>;
      return {
        alphaDeg,
        cl: sig(s.cl),
        cdi: sig(s.cdi),
        spanEfficiency: sig(s.spanEfficiency),
        ...(q === undefined ? {} : { liftN: sig(q * area * s.cl), inducedDragN: sig(q * area * s.cdi) }),
      };
    });
    const unit = solveLiftingLine(wing, 1 * RAD, terms, area);
    const zero = solveLiftingLine(wing, 0, terms, area);
    const slope = unit !== null && zero !== null ? unit.cl - zero.cl : Number.NaN;
    const last = solved[solved.length - 1]?.solution as NonNullable<(typeof solved)[number]['solution']>;
    const warnings = [
      ...(aspectRatio < 4
        ? [`aspect ratio ${sig(aspectRatio)} < 4: lifting-line over-predicts lift slope; compare helmboldLiftSlopePerDeg.`]
        : []),
      ...(slopeDefaulted ? ['section lift slope defaulted to 2π per rad (thin airfoil); real sections are ~5-10 % lower.'] : []),
      'Attached incompressible flow: no stall, no compressibility, no sweep, no fuselage interference.',
    ];
    const data = {
      geometry: {
        planform,
        span: params.span,
        area: sig(area),
        aspectRatio: sig(aspectRatio),
        taperRatio: planform === 'elliptical' ? null : sig(tip / root),
        meanChord: sig(area / params.span),
        twistDeg: params.twistDeg ?? 0,
      },
      section: { liftSlopePerRad: sig(a0), liftSlopeDefaulted: slopeDefaulted, zeroLiftAngleDeg: sig(zeroLift / RAD), zeroLiftSource },
      polar,
      liftSlopePerDeg: sig(slope),
      liftSlopePerRad: sig(slope / RAD),
      helmboldLiftSlopePerDeg: sig(helmboldLiftSlope(a0, aspectRatio) * RAD),
      ...(q === undefined || air === undefined || !isAirState(air)
        ? {}
        : { flow: { speedMS: speed, dynamicPressurePa: sig(q), air: air.source } }),
      stations: last.stations.map((station) => ({
        eta: sig(station.eta),
        chord: sig(station.chord),
        cl: sig(station.cl),
        loading: sig(station.loading),
      })),
      stationsAtAlphaDeg: solved[solved.length - 1]?.alphaDeg,
      warnings,
      provenance: {
        formulas: {
          monoplane: 'Σ A_n sin nθ (sin θ + n μ) = μ (α - α_L0) sin θ, μ = c a0 / 4b (Glauert 1926)',
          coefficients: 'CL = π AR A1; CDi = π AR Σ n A_n²; e = CL²/(π AR CDi)',
          helmbold: 'a = a0 / (√(1 + (a0/πA)²) + a0/πA) (Helmbold 1942)',
        },
        terms,
      },
    };
    return briefReport(
      doc,
      `analyze_wing ${planform} b ${params.span}, AR ${data.geometry.aspectRatio}${data.geometry.taperRatio === null ? '' : `, λ ${data.geometry.taperRatio}`}: ` +
        polar.map((row) => `α ${row.alphaDeg}°: CL ${row.cl}, CDi ${row.cdi}`).join('; ') +
        `; e ${polar[polar.length - 1]?.spanEfficiency}, CL_α ${data.liftSlopePerDeg}/deg (Helmbold ${data.helmboldLiftSlopePerDeg}).`,
      data,
    );
  },
});
