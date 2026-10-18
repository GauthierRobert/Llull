/** draw_naca_airfoil (2D section into the sketch) and analyze_airfoil (inviscid panel method + thin-airfoil theory). */

import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { changed } from '@core/commands/noop';
import { execute } from '@core/commands/registry';
import { roundSignificant } from '@lib/significant';
import { briefReport } from './brief';
import { nacaOrdinates, parseNaca } from './naca';
import { refuseAero } from './codes';
import { nacaContour, polylineContour } from './airfoilContour';
import { solveVortexPanels, thinAirfoil } from './panelMethod';

const RAD = Math.PI / 180;
const sig = (value: number): number => roundSignificant(value, 10);
const MIN_PANELS = 20;
const MAX_PANELS = 400;

/**
 * @affects creates 1 closed polyline (the section, chord along local +x, leading edge at `position`)
 * @invariant ordinates of NACA Report 824 (closed trailing edge by default), cosine spacing, Selig order; composes draw_polyline
 * @failure unsupported designation -> AER_AIRFOIL_INVALID; chord <= 0 or pointsPerSide outside 10..400 -> AER_PARAM_INVALID
 */
export const drawNacaAirfoil = defineCommand({
  name: 'draw_naca_airfoil',
  description:
    'Draw a NACA 4-digit (e.g. "0012", "2412", "4415") or 230-series 5-digit ("23012") airfoil section as one closed 2D polyline ' +
    '(NACA Report 824 ordinates, cosine spacing, upper trailing edge -> leading edge -> lower trailing edge). `chord` in document units; ' +
    'leading edge at `position`, chord along +x; `incidenceDeg` rotates the section nose-up about the leading edge. `closedTrailingEdge` ' +
    '(default true) uses the 0.1036 last thickness coefficient (sharp TE); false gives the original open TE. Next: analyze_airfoil ' +
    '{ entityId } for lift / moment, extrude_profile for a constant-chord wing panel, loft_sections between sections for a tapered wing.',
  params: z.object({
    naca: z.string().describe('NACA designation, e.g. "2412" or "NACA 23012".'),
    chord: z.number().describe('Chord length in document units, > 0.'),
    pointsPerSide: z.number().int().optional().describe('Points per surface (10..400). Default 60.'),
    closedTrailingEdge: z.boolean().optional().describe('Sharp closed trailing edge (default true).'),
    incidenceDeg: z.number().optional().describe('Nose-up rotation about the leading edge in degrees. Default 0.'),
    position: z
      .array(z.number())
      .length(3)
      .optional()
      .describe('Leading-edge position [x, y, z] of the sketch plane in document units. Default origin.'),
  }),
  run: (doc, params, ctx): CommandResult => {
    const section = parseNaca(params.naca);
    if (typeof section === 'string') return refuseAero(doc, 'draw_naca_airfoil', 'AER_AIRFOIL_INVALID', section, [], ['naca']);
    const perSide = params.pointsPerSide ?? 60;
    if (!(params.chord > 0) || !(perSide >= 10 && perSide <= MAX_PANELS))
      return refuseAero(doc, 'draw_naca_airfoil', 'AER_PARAM_INVALID', 'chord must be > 0 and pointsPerSide within 10..400', [], ['chord']);
    const closed = params.closedTrailingEdge ?? true;
    const incidence = (params.incidenceDeg ?? 0) * RAD;
    const ordinates = nacaOrdinates(section, perSide, closed);
    const unique = closed ? ordinates.slice(0, -1) : ordinates;
    const points = unique.map(([x, y]) => {
      const [sx, sy] = [x * params.chord, y * params.chord];
      return [sx * Math.cos(incidence) + sy * Math.sin(incidence), -sx * Math.sin(incidence) + sy * Math.cos(incidence)];
    });
    const drawn = execute(doc, 'draw_polyline', { points, closed: true, ...(params.position ? { position: params.position } : {}) }, ctx);
    if (drawn.affected.length === 0) return drawn;
    return changed(
      drawn.document,
      `Drew ${section.designation} (t/c ${section.maxThickness}, chord ${params.chord}, ${points.length} points${incidence !== 0 ? `, incidence ${params.incidenceDeg}°` : ''}) as ${drawn.affected[0]}.`,
      drawn.affected,
    );
  },
});

/**
 * @affects none; data = { airfoil, method, panels, polar [{ alphaDeg, cl, clCirculation, cm, cdPressure }], liftSlopePerDeg, zeroLiftAngleDeg, thinAirfoil?, surface?, warnings, provenance }
 * @invariant inviscid incompressible potential flow; Kutta condition at the trailing edge; cl from integrated pressure
 * @failure both / neither of naca and entityId -> AER_AIRFOIL_SOURCE_CONFLICT; bad section or entity -> AER_AIRFOIL_INVALID; bad alpha / panels -> AER_PARAM_INVALID; singular system -> AER_SOLVER_FAILED
 */
export const analyzeAirfoil = defineCommand({
  name: 'analyze_airfoil',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Read-only inviscid analysis of a 2D airfoil section: linear-strength vortex panel method with the Kutta condition (Kuethe & Chow), ' +
    'giving lift cl, pitching moment cm about `momentReference` (fraction of chord, default 0.25) and the pressure distribution Cp; plus ' +
    'thin-airfoil theory (zero-lift angle, cm c/4) for NACA sections. Give `naca` ("2412") or `entityId` of a closed 2D polyline (chord ' +
    'along its local x; any size). `alphasDeg` angles of attack in degrees (default [0, 5]); lift slope and zero-lift angle are fitted ' +
    'from them. Inviscid: no drag, no stall, no Reynolds effect — real sections reach about 85-95 % of the inviscid lift slope below ' +
    'stall (NACA 0012 measured 0.106/deg vs 0.1195 here). `includeSurface` returns Cp per panel. Next: analyze_wing with the section ' +
    'lift slope and zero-lift angle.',
  params: z.object({
    naca: z.string().optional().describe('NACA designation, e.g. "0012", "2412", "23012". Give this or entityId.'),
    entityId: z.string().optional().describe('Id of a closed 2D polyline airfoil (e.g. from draw_naca_airfoil). Give this or naca.'),
    alphasDeg: z.array(z.number()).optional().describe('Angles of attack in degrees, each within -20..20, at most 41. Default [0, 5].'),
    panelsPerSide: z.number().int().optional().describe('NACA only: panels per surface, 20..400. Default 100.'),
    closedTrailingEdge: z.boolean().optional().describe('NACA only: sharp closed trailing edge (default true).'),
    momentReference: z.number().optional().describe('Moment reference point as a fraction of chord. Default 0.25.'),
    includeSurface: z.boolean().optional().describe('Return x/c, y/c, Cp, V/V∞ per panel for every angle. Default false.'),
  }),
  run: (doc, params): CommandResult => {
    const fail = (code: string, message: string, paths: string[] = []): CommandResult =>
      refuseAero(doc, 'analyze_airfoil', code, message, [], paths);
    if ((params.naca === undefined) === (params.entityId === undefined))
      return fail('AER_AIRFOIL_SOURCE_CONFLICT', 'give exactly one of naca or entityId', ['naca']);
    const perSide = params.panelsPerSide ?? 100;
    const alphas = params.alphasDeg ?? [0, 5];
    if (!(perSide >= MIN_PANELS && perSide <= MAX_PANELS))
      return fail('AER_PARAM_INVALID', 'panelsPerSide must be within 20..400', ['panelsPerSide']);
    if (alphas.length === 0 || alphas.length > 41 || alphas.some((alpha) => !(Math.abs(alpha) <= 20)))
      return fail('AER_PARAM_INVALID', 'alphasDeg needs 1..41 angles within -20..20 degrees', ['alphasDeg']);
    const reference = params.momentReference ?? 0.25;
    if (!Number.isFinite(reference)) return fail('AER_PARAM_INVALID', 'momentReference must be finite', ['momentReference']);
    const contour =
      params.naca !== undefined
        ? nacaContour(params.naca, perSide, params.closedTrailingEdge ?? true)
        : polylineContour(doc, params.entityId as string);
    if (typeof contour === 'string') return fail('AER_AIRFOIL_INVALID', contour, [params.naca !== undefined ? 'naca' : 'entityId']);
    const solutions = alphas.map((alphaDeg) => ({ alphaDeg, solution: solveVortexPanels(contour.nodes, alphaDeg * RAD, reference) }));
    if (solutions.some(({ solution }) => solution === null)) return fail('AER_SOLVER_FAILED', 'singular panel influence matrix');
    const polar = solutions.map(({ alphaDeg, solution }) => {
      const s = solution as NonNullable<typeof solution>;
      return { alphaDeg, cl: sig(s.cl), clCirculation: sig(s.clCirculation), cm: sig(s.cm), cdPressure: sig(s.cdPressure) };
    });
    const fit = liftFit(polar);
    const thin =
      contour.section === null ? undefined : thinAirfoil((x) => (contour.section as NonNullable<typeof contour.section>).camber(x).slope);
    const warnings = [
      'Inviscid potential flow: no drag, no stall, no Reynolds or Mach effect; measured lift slopes are typically 5-10 % lower.',
      ...(alphas.some((alpha) => Math.abs(alpha) > 12)
        ? ['Angles above about 12° are usually beyond the linear range of real sections (stall is not modelled).']
        : []),
    ];
    const data = {
      airfoil: { label: contour.label, chord: sig(contour.chord), panels: contour.nodes.length - 1 },
      method: 'linear-strength vortex panels, Kutta condition (Kuethe & Chow program VORTEX)',
      momentReference: reference,
      polar,
      ...(fit === null
        ? {}
        : { liftSlopePerDeg: sig(fit.slope), liftSlopePerRad: sig(fit.slope / RAD), zeroLiftAngleDeg: sig(fit.zeroLift) }),
      ...(thin === undefined
        ? {}
        : {
            thinAirfoil: {
              zeroLiftAngleDeg: sig(thin.zeroLiftAngle / RAD),
              liftSlopePerRad: sig(thin.liftSlope),
              cmQuarterChord: sig(thin.cmQuarterChord),
            },
          }),
      ...(params.includeSurface
        ? {
            surface: solutions.map(({ alphaDeg, solution }) => ({
              alphaDeg,
              points: (solution as NonNullable<typeof solution>).surface.map((point) => ({
                x: sig(point.x),
                y: sig(point.y),
                cp: sig(point.cp),
                velocityRatio: sig(point.velocityRatio),
              })),
            })),
          }
        : {}),
      warnings,
      provenance: {
        formulas: {
          panels: 'Kuethe & Chow, Foundations of Aerodynamics, 5th ed., §5.10 (linear vortex, γ_1 + γ_N+1 = 0)',
          thinAirfoil: 'α_L0 = -(1/π)∫ dz/dx (cos θ - 1) dθ, cm_c/4 = (π/4)(A2 - A1) (Glauert; Abbott & von Doenhoff §4.3)',
          geometry: contour.section === null ? 'document polyline' : 'NACA Report 824 ordinates',
        },
      },
    };
    const head = polar.map((row) => `α ${row.alphaDeg}°: cl ${row.cl}, cm ${row.cm}`).join('; ');
    return briefReport(
      doc,
      `analyze_airfoil ${contour.label} (${data.airfoil.panels} panels, inviscid): ${head}` +
        (fit === null ? '' : `; cl_α ${data.liftSlopePerDeg}/deg, α_L0 ${data.zeroLiftAngleDeg}°`) +
        (thin === undefined
          ? '.'
          : `; thin-airfoil α_L0 ${data.thinAirfoil?.zeroLiftAngleDeg}°, cm_c/4 ${data.thinAirfoil?.cmQuarterChord}.`),
      data,
    );
  },
});

/** Least-squares cl = slope (α - α_L0) over distinct angles, or null with fewer than two. */
function liftFit(polar: ReadonlyArray<{ alphaDeg: number; cl: number }>): { slope: number; zeroLift: number } | null {
  const distinct = new Set(polar.map((row) => row.alphaDeg));
  if (distinct.size < 2) return null;
  const n = polar.length;
  const mx = polar.reduce((sum, row) => sum + row.alphaDeg, 0) / n;
  const my = polar.reduce((sum, row) => sum + row.cl, 0) / n;
  const sxy = polar.reduce((sum, row) => sum + (row.alphaDeg - mx) * (row.cl - my), 0);
  const sxx = polar.reduce((sum, row) => sum + (row.alphaDeg - mx) ** 2, 0);
  const slope = sxy / sxx;
  return { slope, zeroLift: mx - my / slope };
}
