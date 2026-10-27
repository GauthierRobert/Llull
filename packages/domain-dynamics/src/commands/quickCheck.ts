/** Analytic slider-crank / engine sanity check (engine_quick_check): no kernel, no physics engine. */

import { createSlider, rodAngle, sliderRate, sliderStroke, sliderTravel } from '../sim/slider';
import { buildTopology, isRefusal } from '../sim/topology';
import { engineLayout } from '../sim/engineGeometry';
import { pressureCurve } from '../sim/cylinderPressure';
import { gaugeAt } from '../sim/pressureCurve';
import { toMetres } from '@core/model/units';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { failer, report } from '@core/commands/noop';
import { dynamicsOf } from './bodies';
import { accuracy, RIGID_BODY_WARNING, type Accuracy } from '../sim/accuracy';
import { quickBrake } from '../sim/engine/quickBrake';

const DEFAULT_ANGLES = [0, 30, 60, 90, 120, 150, 180];

/**
 * @affects nothing — read-only; data { source, geometry, angles[], mean? }
 * @invariant exact slider-crank formulas (virtual work); mean torque = MEP · V_d / (4π) four-stroke, MEP · V_d / (2π) two-stroke
 * @failure unknown cylinder, no geometry (give the crank radius and rod length, or a cylinder id), rod not longer than the crank
 *          radius plus the offset, non-positive inputs -> no-op
 */
export const engineQuickCheck = defineCommand({
  name: 'engine_quick_check',
  annotations: { readsMeshTriangles: true, readOnly: true },
  description:
    'Sanity-check a slider-crank engine analytically in milliseconds, with no simulation: exact piston travel, rod angle, crank torque ' +
    'per newton of piston force, and with forceN the crank torque T = F·dx/dθ, rod force F/cos β and cylinder side thrust F·tan β at ' +
    'chosen crank angles; and the mean-torque / mean-effective-pressure / power relation (T = MEP·V_d/(4π) four-stroke, MEP·V_d/(2π) ' +
    'two-stroke; P = T·ω). Geometry comes from `cylinder` (an add_cylinder_pressure id: crank radius, rod length, bore and the pressure ' +
    'model; angles are then CYCLE angles, 0 = firing TDC, and the gas force at each angle is used) or from crankRadiusMm + rodLengthMm ' +
    '(+ optional offsetMm of the cylinder axis; angles are crank degrees from TDC). Units: lengths mm, force N, pressure bar, ' +
    'displacement cm³, speed rpm, torque N·m, power kW. Use it before simulate_motion to check the model against hand numbers: the ' +
    'simulated static torque and bearing forces must match these within 0.5 %. With a `cylinder` whose crank has set_engine_losses and an `rpm`, ' +
    'data.brake gives the friction (FMEP), BMEP = IMEP - FMEP, brake torque / power and mechanical efficiency at that speed. data.accuracy states ' +
    'for each number its band (null = "± ?"), basis and origin: "calibrated" at a speed the heat release was calibrated at (not validation ' +
    'evidence), "predicted" elsewhere, "input" for a pressure table or a MEP you give. Read-only; needs no kernel or physics engine.',
  params: z.object({
    cylinder: z
      .string()
      .optional()
      .describe('Id of a cylinder pressure (add_cylinder_pressure): geometry and pressure are taken from the model.'),
    crankRadiusMm: z.number().positive().optional().describe('Crank radius (half the stroke), mm. Required without `cylinder`.'),
    rodLengthMm: z.number().positive().optional().describe('Connecting-rod length between pin centres, mm. Required without `cylinder`.'),
    offsetMm: z.number().optional().describe('Lateral offset of the cylinder axis from the crank axis, mm (default 0).'),
    forceN: z
      .number()
      .optional()
      .describe('Constant force on the piston toward the crank, N: adds torque, rod force and side thrust per angle.'),
    anglesDeg: z.array(z.number()).max(721).optional().describe('Angles in deg. Default 0, 30, ..., 180.'),
    rpm: z.number().positive().optional().describe('Crank speed, rpm: adds power and piston speed.'),
    mepBar: z.number().optional().describe('Mean effective pressure, bar: gives the mean torque (needs displacementCm3 or a cylinder).'),
    displacementCm3: z
      .number()
      .positive()
      .optional()
      .describe('Swept volume of the engine, cm³ (all cylinders), for the MEP relation. Default: the cylinder or 2·r·π·bore²/4 if known.'),
    cycle: z
      .enum(['four_stroke', 'two_stroke'])
      .optional()
      .describe("Cycle for the MEP relation. Default the cylinder's, else four_stroke."),
  }),
  run: (doc, params): CommandResult => {
    const fail = failer(doc, 'engine_quick_check');
    let radius = params.crankRadiusMm !== undefined ? params.crankRadiusMm / 1000 : undefined;
    let rod = params.rodLengthMm !== undefined ? params.rodLengthMm / 1000 : undefined;
    let offset = (params.offsetMm ?? 0) / 1000;
    let cycle = params.cycle ?? 'four_stroke';
    let displacement = params.displacementCm3 !== undefined ? params.displacementCm3 * 1e-6 : undefined;
    let model: { gauge: (phi: number) => number; areaM2: number; imepBar: number; peakBar: number } | undefined;
    if (params.cylinder !== undefined) {
      const dynamics = dynamicsOf(doc);
      const cylinder = dynamics.cylinders?.[params.cylinder];
      if (cylinder === undefined) return fail(`cylinder '${params.cylinder}' not found (add_cylinder_pressure first)`);
      const topology = buildTopology(dynamics);
      if (isRefusal(topology)) return fail(`${topology.code}: ${topology.error}`);
      const layout = engineLayout(dynamics, topology, cylinder, toMetres(doc, 1));
      if ('error' in layout) return fail(layout.error);
      const curve = pressureCurve(cylinder, layout, params.rpm ?? 1000);
      if ('error' in curve) return fail(`${curve.code}: ${curve.error}`);
      [radius, rod, offset, cycle] = [layout.slider.r, layout.slider.l, layout.slider.offset, cylinder.cycle];
      displacement ??= layout.displacementM3;
      model = {
        gauge: (phi) => gaugeAt(curve, phi),
        areaM2: layout.pistonAreaM2,
        imepBar: curve.imepPa / 1e5,
        peakBar: curve.peakPa / 1e5,
      };
    }
    if (radius === undefined || rod === undefined) return fail('give crankRadiusMm and rodLengthMm, or a cylinder id');
    if (rod <= radius + Math.abs(offset)) return fail('the rod must be longer than the crank radius plus the offset');
    const slider = createSlider(radius, rod, offset);
    const stroke = sliderStroke(slider);
    const omega = params.rpm !== undefined ? (params.rpm * 2 * Math.PI) / 60 : undefined;
    const angles = (params.anglesDeg ?? DEFAULT_ANGLES).map((angleDeg) => {
      const psi = (angleDeg * Math.PI) / 180;
      const rate = sliderRate(slider, psi);
      const beta = rodAngle(slider, psi);
      const force = model !== undefined ? model.gauge(angleDeg) * model.areaM2 : params.forceN;
      return {
        angleDeg,
        travelMm: sliderTravel(slider, psi) * 1000,
        rodAngleDeg: (beta * 180) / Math.PI,
        torquePerNewtonNm: rate,
        pistonSpeedMs: omega !== undefined ? rate * omega : null,
        ...(model !== undefined ? { gaugeBar: model.gauge(angleDeg) / 1e5 } : {}),
        ...(force !== undefined
          ? { forceN: force, torqueNm: force * rate, rodForceN: force / Math.cos(beta), sideThrustN: force * Math.tan(beta) }
          : {}),
      };
    });
    const revolutionsPerCycle = cycle === 'four_stroke' ? 2 : 1;
    const mep = params.mepBar !== undefined ? params.mepBar * 1e5 : model !== undefined ? model.imepBar * 1e5 : undefined;
    let mean: Record<string, number> | undefined;
    if (mep !== undefined) {
      if (displacement === undefined) return fail('mepBar needs displacementCm3 or a cylinder');
      const torque = (mep * displacement) / (2 * Math.PI * revolutionsPerCycle);
      mean = {
        mepBar: mep / 1e5,
        displacementCm3: displacement * 1e6,
        meanTorqueNm: torque,
        ...(omega !== undefined ? { powerKW: (torque * omega) / 1000, rpm: params.rpm ?? 0 } : {}),
      };
    }
    const dynamics = dynamicsOf(doc);
    const record = params.cylinder === undefined ? undefined : dynamics.cylinders?.[params.cylinder];
    const quick =
      record !== undefined && model !== undefined
        ? quickBrake({
            model: record.model,
            losses: Object.values(dynamics.losses ?? {}).find((losses) => losses.crank === record.crank),
            imepPa: model.imepBar * 1e5,
            peakPa: model.peakBar * 1e5,
            rpm: params.rpm,
            displacementM3: displacement ?? 0,
            cycle,
          })
        : null;
    const given = accuracy(null, 'mean effective pressure given by the caller; its uncertainty is not stated', 'input', {
      warnings: [RIGID_BODY_WARNING],
    });
    const accuracies: Record<string, Accuracy> = {
      kinematics: accuracy(
        null,
        'exact slider-crank kinematics and virtual work [C-R12]; no uncertainty of the stated geometry is available',
        'predicted',
      ),
      ...(quick !== null ? quick.accuracy : mean !== undefined ? { meanTorqueNm: given, powerKW: given } : {}),
    };
    const data = {
      source: params.cylinder !== undefined ? `model:${params.cylinder}` : 'parameters',
      basis: 'exact slider-crank kinematics and virtual work; MEP relation of a four-/two-stroke engine (no simulation, no losses)',
      geometry: {
        crankRadiusMm: radius * 1000,
        rodLengthMm: rod * 1000,
        offsetMm: offset * 1000,
        strokeMm: stroke * 1000,
        lambda: radius / rod,
      },
      cycle,
      angles,
      ...(model !== undefined ? { cylinder: { id: params.cylinder, imepBar: model.imepBar, peakPressureBar: model.peakBar } } : {}),
      ...(mean !== undefined ? { mean } : {}),
      ...(quick?.brake != null ? { brake: quick.brake } : {}),
      accuracy: accuracies,
    };
    const first = angles.find((a) => a.angleDeg === 90) ?? angles[0];
    const text = [
      `engine_quick_check: r ${(radius * 1000).toPrecision(5)} mm, l ${(rod * 1000).toPrecision(5)} mm, stroke ${(stroke * 1000).toPrecision(5)} mm, λ ${(radius / rod).toPrecision(4)}.`,
      first !== undefined
        ? `At ${first.angleDeg} deg: travel ${first.travelMm.toPrecision(5)} mm, rod angle ${first.rodAngleDeg.toPrecision(4)} deg, ${first.torquePerNewtonNm.toPrecision(5)} N·m per N.`
        : '',
      mean !== undefined
        ? `Mean torque ${(mean['meanTorqueNm'] ?? 0).toPrecision(5)} N·m at MEP ${(mean['mepBar'] ?? 0).toPrecision(5)} bar.`
        : '',
      mean?.['powerKW'] !== undefined ? `Power ${mean['powerKW'].toPrecision(5)} kW.` : '',
      quick?.brake != null
        ? `Brake ${quick.brake.brakeTorqueNm.toPrecision(5)} N·m (${quick.brake.brakePowerKW.toPrecision(4)} kW, BMEP ${quick.brake.bmepBar.toPrecision(5)} bar = IMEP - FMEP ${quick.brake.fmepBar.toPrecision(4)} bar, mechanical efficiency ${(quick.brake.mechanicalEfficiency * 100).toFixed(1)} %), ${quick.accuracy['brakeTorqueNm']?.origin ?? ''}.`
        : '',
    ];
    return report(doc, text.filter((t) => t !== '').join(' '), data);
  },
});
