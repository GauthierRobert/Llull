/** pipe_hydraulics: pressure drop of one pipe run (Darcy-Weisbach, Colebrook-White, bend losses, riser static head). */

import type { CadDocument } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { noop, report } from '@core/commands/noop';
import { isPositiveNumber } from '@lib/isFiniteNumber';
import { dot3, len3, sub3 } from '@lib/vec3';
import { GRAVITY, round } from '../../shared/numeric';
import { modelUnits } from '../steelDesign/steelMemberBars';
import { pipeRunOf } from './pipeSupportLayout';
import { pipeWallThickness } from './pipeWeight';
import { K_90_DEGREES, bendK, frictionFactor, pipeRoughnessMm, waterDensity, waterViscosity } from './pipeFlow';

/** Deflections below this (degrees) are not counted as bends. */
const MIN_BEND_DEGREES = 1;

const sig = (value: number): number => (value === 0 ? 0 : Number(value.toPrecision(5)));

/**
 * @affects none; data = { pipeId, diameter, fluid, flow, velocity, reynolds, regime, friction, losses, bends, pressureDrop, warnings, assumptions }
 * @invariant Δp total = straight (Darcy-Weisbach) + fittings (ΣK ρv²/2) + static (ρ g Δz, end minus start); flow runs start -> end
 * @failure unknown pipe / no or both flow inputs / non-positive flow, density, viscosity, roughness, extraK < 0 -> no-op, no data
 */
export const pipeHydraulics = defineCommand({
  name: 'pipe_hydraulics',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Read-only pressure drop of one pipe run (add_pipe_run), flowing from its first to its last point. Give the run id (`pipeId`, e.g. ' +
    '"pipe-1") and exactly one flow: `flowM3h` (m³/h) or `massFlowKgS` (kg/s). Fluid is water at `temperatureC` (default 20 °C; ' +
    'density and viscosity from Kell / Vogel fits) unless `density` (kg/m³) and `viscosity` (Pa·s) are given for another liquid. Inner ' +
    'diameter = outside diameter minus twice the standard wall (Sch 40 / STD table of add_pipe_run, e.g. DN100 -> 102.26 mm). Roughness ' +
    'defaults by the pipe material (steel 0.045 mm, stainless 0.015, galvanised 0.15, cast iron 0.26, copper / plastic 0.0015). Friction: ' +
    'laminar 64/Re below Re 2300, else Colebrook-White solved iteratively. Straight loss = f (L/D) ρ v²/2 along the 3D centreline; ' +
    'fittings = ΣK ρ v²/2 with one K per interior bend from its deflection angle (K90 by `bendType`: long_radius 0.30, standard 0.40, ' +
    'mitre 1.10; K = K90 · sin(θ/2)/sin 45°) plus `extraK` (valves, entrance / exit); static = ρ g Δz (end minus start elevation, a ' +
    'riser adds head, a drop gives back). Returns data { diameter, velocity, reynolds, friction, losses (kPa), bends, pressureDrop ' +
    '{ kPa, bar, headM }, warnings }; warns when velocity is outside 0.5-3 m/s (liquids) or the flow is laminar / transitional. ' +
    'Incompressible single-phase only (not for gas, steam or slurries).',
  params: z.object({
    pipeId: z.string().describe('Id of the pipe run from add_pipe_run, e.g. "pipe-1".'),
    flowM3h: z.number().optional().describe('Volumetric flow in m³/h, > 0. Give this or massFlowKgS.'),
    massFlowKgS: z.number().optional().describe('Mass flow in kg/s, > 0 (converted with the fluid density). Give this or flowM3h.'),
    temperatureC: z.number().optional().describe('Water temperature in °C, 0..100. Default 20. Ignored for the property it overrides.'),
    density: z.number().optional().describe('Fluid density in kg/m³, > 0. Default: water at temperatureC.'),
    viscosity: z
      .number()
      .optional()
      .describe('Fluid dynamic viscosity in Pa·s (e.g. 0.001 for water), > 0. Default: water at temperatureC.'),
    roughnessMm: z.number().optional().describe('Absolute pipe roughness ε in mm, > 0. Default by the pipe material (steel 0.045).'),
    bendType: z
      .enum(['long_radius', 'standard', 'mitre'])
      .optional()
      .describe('Bend construction for K: long_radius (r/D 1.5, K90 0.30, default), standard (r/D 1, 0.40) or mitre (1.10).'),
    extraK: z.number().optional().describe('Extra loss coefficient ΣK of valves, strainers, entrance / exit, ≥ 0. Default 0.'),
  }),
  run: (doc: CadDocument, params): CommandResult => {
    const { pipeId, flowM3h, massFlowKgS, temperatureC = 20, bendType = 'long_radius', extraK = 0 } = params;
    const fail = (reason: string): CommandResult => noop(doc, `pipe_hydraulics failed: ${reason}`);
    if ((flowM3h === undefined) === (massFlowKgS === undefined)) return fail('give exactly one of flowM3h or massFlowKgS.');
    const checks: ReadonlyArray<readonly [string, number | undefined]> = [
      ['flowM3h', flowM3h],
      ['massFlowKgS', massFlowKgS],
      ['density', params.density],
      ['viscosity', params.viscosity],
      ['roughnessMm', params.roughnessMm],
    ];
    const bad = checks.find(([, value]) => value !== undefined && !isPositiveNumber(value));
    if (bad) return fail(`${bad[0]} must be a number > 0.`);
    if (!Number.isFinite(extraK) || extraK < 0) return fail('extraK must be a number >= 0.');
    if (!(temperatureC >= 0 && temperatureC <= 100)) return fail('temperatureC must be within 0..100 for the water property fits.');
    const units = modelUnits(doc);
    const element = Object.values(units.building.elements).find((candidate) => candidate.category === 'pipe' && candidate.id === pipeId);
    if (element?.category !== 'pipe') return fail(`no pipe run '${pipeId}' (add_pipe_run creates one).`);
    const run = pipeRunOf(units, element);
    const wallMm = pipeWallThickness(run.diameterMm);
    const insideMm = run.diameterMm - 2 * wallMm;
    if (!(insideMm > 0) || !(run.lengthMm > 0)) return fail(`pipe ${element.mark} has no bore or no length.`);

    const rho = params.density ?? waterDensity(temperatureC);
    const mu = params.viscosity ?? waterViscosity(temperatureC);
    const fluid = params.density === undefined && params.viscosity === undefined ? `water ${temperatureC} °C` : 'user fluid';
    const volumetric = flowM3h !== undefined ? flowM3h / 3600 : (massFlowKgS as number) / rho;
    const roughness = params.roughnessMm === undefined ? pipeRoughnessMm(element.material) : { mm: params.roughnessMm, basis: 'given' };
    const d = insideMm / 1000;
    const length = run.lengthMm / 1000;
    const velocity = volumetric / ((Math.PI / 4) * d ** 2);
    const reynolds = (rho * velocity * d) / mu;
    const { f, iterations } = frictionFactor(reynolds, roughness.mm / insideMm);
    const dynamic = (rho * velocity ** 2) / 2;
    const bends = run.points.slice(1, -1).flatMap((point, index) => {
      const before = run.points[index] as typeof point;
      const after = run.points[index + 2] as typeof point;
      const a = sub3(point, before);
      const b = sub3(after, point);
      const cosine = dot3(a, b) / (len3(a) * len3(b));
      const degrees = (Math.acos(Math.max(-1, Math.min(1, cosine))) * 180) / Math.PI;
      return degrees < MIN_BEND_DEGREES
        ? []
        : [{ atPoint: index + 1, deflectionDegrees: round(degrees, 1), k: sig(bendK(bendType, degrees)) }];
    });
    const bendKTotal = bends.reduce((sum, bend) => sum + bend.k, 0);
    const rise = ((run.points.at(-1)?.[2] ?? 0) - (run.points[0]?.[2] ?? 0)) / 1000;
    const straightPa = (f * length * dynamic) / d;
    const fittingsPa = (bendKTotal + extraK) * dynamic;
    const staticPa = rho * GRAVITY * rise;
    const totalPa = straightPa + fittingsPa + staticPa;
    const kPa = (pa: number): number => sig(pa / 1000);

    const warnings: string[] = [];
    if (velocity < 0.5 || velocity > 3) warnings.push(`velocity ${velocity.toFixed(2)} m/s is outside the typical liquid range 0.5-3 m/s.`);
    if (reynolds < 2300) warnings.push(`laminar flow (Re ${Math.round(reynolds)}): friction factor 64/Re.`);
    else if (reynolds < 4000) warnings.push(`transitional flow (Re ${Math.round(reynolds)}): friction factor is uncertain.`);
    if (rise < 0) warnings.push(`the run falls ${(-rise).toFixed(2)} m: static head is returned (negative); verify the line stays full.`);

    const data = {
      pipeId: element.id,
      mark: element.mark,
      line: element.line ?? '',
      diameter: { outsideMm: sig(run.diameterMm), wallMm, insideMm: sig(insideMm) },
      fluid: { name: fluid, densityKgM3: sig(rho), viscosityPaS: sig(mu) },
      flow: { m3h: sig(volumetric * 3600), massKgS: sig(volumetric * rho) },
      lengthM: sig(length),
      riseM: sig(rise),
      velocityMS: sig(velocity),
      reynolds: Math.round(reynolds),
      regime: reynolds < 2300 ? 'laminar' : reynolds < 4000 ? 'transitional' : 'turbulent',
      friction: {
        factor: sig(f),
        roughnessMm: roughness.mm,
        roughnessBasis: roughness.basis,
        relativeRoughness: sig(roughness.mm / insideMm),
        iterations,
      },
      velocityHeadKPa: kPa(dynamic),
      bends,
      fittingsK: { bendType, k90: K_90_DEGREES[bendType], bends: sig(bendKTotal), extra: extraK, total: sig(bendKTotal + extraK) },
      losses: { straightKPa: kPa(straightPa), fittingsKPa: kPa(fittingsPa), staticKPa: kPa(staticPa) },
      pressureDrop: { kPa: kPa(totalPa), bar: sig(totalPa / 1e5), headM: sig(totalPa / (rho * GRAVITY)) },
      warnings,
      assumptions: [
        'Incompressible single phase; Darcy-Weisbach with Colebrook-White (laminar 64/Re below Re 2300).',
        'Inner diameter from the standard wall table (Sch 40 / STD); bend K = K90 · sin(θ/2)/sin 45°, K90 long_radius 0.30 / standard 0.40 / mitre 1.10.',
        'Flow runs from the first to the last point; static head ρ g Δz uses the end-minus-start elevation.',
      ],
    };
    return report(
      doc,
      `Pipe ${element.mark} (${element.id}) ${fluid}, ${data.flow.m3h} m³/h: Ø${data.diameter.insideMm} mm bore, v ${data.velocityMS} m/s, ` +
        `Re ${data.reynolds}, f ${data.friction.factor}; Δp ${data.pressureDrop.kPa} kPa (${data.pressureDrop.bar} bar) = straight ` +
        `${data.losses.straightKPa} (${data.lengthM} m) + fittings ${data.losses.fittingsKPa} (ΣK ${data.fittingsK.total}, ${bends.length} bend(s)) + ` +
        `static ${data.losses.staticKPa} kPa (rise ${data.riseM} m)${warnings.length > 0 ? `. Warnings: ${warnings.join(' ')}` : '.'}`,
      data,
    );
  },
});
