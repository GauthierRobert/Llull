/** frontal_area (projected / wetted area of solids along a flow) and aero_drag (drag force and power from CdA, Cd·A or the model). */

import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import type { Vec3 } from '@core/model/types';
import { roundSignificant } from '@lib/significant';
import { briefReport } from './brief';
import { refuseAero } from './codes';
import { DEFAULT_FLOW_DIRECTION, DEFAULT_RESOLUTION, geometryArea } from './geometryArea';
import { airStateParams, isAirState, resolveAirState } from './airState';
import { speedParam, toMetresPerSecond } from './speed';
import { FRICTION_MODELS, FRICTION_RANGE, skinFrictionCoefficient, type FrictionModel } from './skinFriction';

const sig = (value: number): number => roundSignificant(value, 10);

const flowParams = {
  flowDirection: z
    .array(z.number())
    .length(3)
    .optional()
    .describe('Direction the air moves relative to the body [x, y, z] (any length, not zero). Default [1, 0, 0]: a body moving along -x.'),
  resolution: z
    .number()
    .int()
    .optional()
    .describe('Silhouette grid cells along its larger extent, 50..2000. Default 400 (area error ~ ±0.5 %).'),
};

const directionOf = (raw: readonly number[] | undefined): Vec3 | null => {
  const direction = (raw ?? DEFAULT_FLOW_DIRECTION) as Vec3;
  return direction.every(Number.isFinite) && Math.hypot(...direction) > 0 ? direction : null;
};

/**
 * @affects none; data = { ids, flowDirection, frontalAreaM2, uncertaintyM2, wettedAreaM2, lengthM, extentsM, cellSizeM, unitScale }
 * @invariant union of the projected triangles (overlaps once); lengths converted from document units to metres
 * @failure unknown ids -> AER_ENTITY_NOT_FOUND; no 3D geometry -> AER_NO_GEOMETRY; zero direction / bad resolution -> AER_PARAM_INVALID
 */
export const frontalArea = defineCommand({
  name: 'frontal_area',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Read-only frontal (projected) area of 3D solids seen along the flow direction — the reference area A of drag D = ½ρV²·Cd·A — plus the ' +
    'wetted (surface) area for skin friction and the body length along the flow. Overlapping parts count once (silhouette union by ' +
    'rasterisation; `uncertaintyM2` = half the boundary cells). Lengths are converted from the document units to metres. Default flow ' +
    'direction [1, 0, 0]. Use for a cyclist + bike model, a fuselage, a car or any assembly; then aero_drag { cd, entityIds } or cycling_power.',
  params: z.object({ entityIds: z.array(z.string()).min(1).describe('Ids of the 3D solids / instances to project.'), ...flowParams }),
  run: (doc, params): CommandResult => {
    const direction = directionOf(params.flowDirection);
    const resolution = params.resolution ?? DEFAULT_RESOLUTION;
    if (direction === null || !(resolution >= 50 && resolution <= 2000))
      return refuseAero(
        doc,
        'frontal_area',
        'AER_PARAM_INVALID',
        'flowDirection must be a non-zero vector and resolution within 50..2000',
        [],
        ['flowDirection'],
      );
    const measured = geometryArea(doc, params.entityIds, direction, resolution);
    if (!measured.ok) return refuseAero(doc, 'frontal_area', measured.code, measured.message, measured.ids, ['entityIds']);
    const { area } = measured;
    const data = {
      ids: measured.ids,
      flowDirection: direction,
      frontalAreaM2: sig(area.area),
      uncertaintyM2: sig(area.uncertainty),
      wettedAreaM2: sig(area.wettedArea),
      lengthM: sig(area.length),
      extentsM: area.extents.map(sig),
      cellSizeM: sig(area.cellSize),
      unitScale: { documentUnits: doc.units, metresPerUnit: measured.scaleToMetres },
      notes: [
        'Areas come from the display tessellation: curved surfaces read slightly low (a 32-segment circle has 99.4 % of the true area).',
      ],
    };
    return briefReport(
      doc,
      `Frontal area of ${measured.ids.length} solid(s) along [${direction.join(', ')}]: ${data.frontalAreaM2} m² (± ${data.uncertaintyM2}), wetted ${data.wettedAreaM2} m², length ${data.lengthM} m.`,
      data,
    );
  },
});

/**
 * @affects none; data = { air, speedMS, dynamicPressurePa, area { source, cdA, cd?, referenceAreaM2? }, dragN, powerW, reynolds?, friction?, warnings, provenance }
 * @invariant D = ½ ρ V² CdA (+ friction Cf q S_wet when wetted area is given); P = D V
 * @failure area sources conflicting / missing -> AER_AREA_SOURCE_CONFLICT; bad air state -> AER_* of resolveAirState; geometry errors as frontal_area
 */
export const aeroDrag = defineCommand({
  name: 'aero_drag',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Read-only aerodynamic drag force and the power to overcome it: D = ½ρV²·CdA, P = D·V. Give exactly one area source: `cdA` (m², ' +
    'e.g. a cyclist 0.21-0.27), `cd` + `referenceAreaM2`, or `cd` + `entityIds` (frontal area measured on the model, see frontal_area). ' +
    'Air from the standard atmosphere at `altitudeM` (default sea level, 1.225 kg/m³) or `densityKgM3`. Optional flat-plate skin ' +
    'friction: `frictionModel` (laminar_blasius, turbulent_power_law, turbulent_prandtl_schlichting, ittc_1957) with `wettedAreaM2` (or the ' +
    'wetted area of entityIds) and `lengthM` (Reynolds length) adds Cf·q·S_wet. Cd is never defaulted: take it from tests or references ' +
    '(flat plate normal to flow 1.28, sphere ~0.47 at Re 1e4-2e5).',
  params: z.object({
    ...speedParam,
    cdA: z.number().optional().describe('Drag area CdA in m², > 0.'),
    cd: z.number().optional().describe('Drag coefficient Cd (> 0) on referenceAreaM2 or on the frontal area of entityIds.'),
    referenceAreaM2: z.number().optional().describe('Reference area in m², > 0 (with cd).'),
    entityIds: z.array(z.string()).optional().describe('Solids whose frontal area is the reference area (with cd).'),
    ...flowParams,
    frictionModel: z
      .enum(['laminar_blasius', 'turbulent_power_law', 'turbulent_prandtl_schlichting', 'ittc_1957'])
      .optional()
      .describe('Add flat-plate skin friction with this mean Cf correlation (needs lengthM and a wetted area).'),
    wettedAreaM2: z.number().optional().describe('Wetted area in m² for skin friction (default: wetted area of entityIds).'),
    lengthM: z.number().optional().describe('Reynolds length in m (body length along the flow) for skin friction and the Reynolds number.'),
    ...airStateParams,
  }),
  run: (doc, params): CommandResult => {
    const fail = (code: string, message: string, paths: string[] = [], ids: string[] = []): CommandResult =>
      refuseAero(doc, 'aero_drag', code, message, ids, paths);
    if (params.speed === undefined) return fail('AER_PARAM_INVALID', 'speed is required', ['speed']);
    const speed = toMetresPerSecond(params.speed, params.speedUnit ?? 'm/s');
    if (!(speed >= 0)) return fail('AER_PARAM_INVALID', 'speed must be >= 0', ['speed']);
    const sources = [params.cdA !== undefined, params.referenceAreaM2 !== undefined, params.entityIds !== undefined].filter(Boolean).length;
    if (sources !== 1 || (params.cdA !== undefined && params.cd !== undefined) || (params.cdA === undefined && params.cd === undefined))
      return fail('AER_AREA_SOURCE_CONFLICT', 'give exactly one of cdA, cd + referenceAreaM2, or cd + entityIds', ['cdA']);
    if (
      [params.cdA, params.cd, params.referenceAreaM2, params.wettedAreaM2, params.lengthM].some(
        (value) => value !== undefined && !(value > 0),
      )
    )
      return fail('AER_PARAM_INVALID', 'cdA, cd, referenceAreaM2, wettedAreaM2 and lengthM must be > 0', ['cd']);
    const air = resolveAirState(params);
    if (!isAirState(air)) return fail(air.code, air.message, ['altitudeM']);
    let measured: { frontal: number; wetted: number; uncertainty: number } | undefined;
    if (params.entityIds !== undefined) {
      const direction = directionOf(params.flowDirection);
      const resolution = params.resolution ?? DEFAULT_RESOLUTION;
      if (direction === null || !(resolution >= 50 && resolution <= 2000))
        return fail('AER_PARAM_INVALID', 'flowDirection must be a non-zero vector and resolution within 50..2000', ['flowDirection']);
      const result = geometryArea(doc, params.entityIds, direction, resolution);
      if (!result.ok) return fail(result.code, result.message, ['entityIds'], [...result.ids]);
      measured = { frontal: result.area.area, wetted: result.area.wettedArea, uncertainty: result.area.uncertainty };
    }
    const cdA = params.cdA ?? (params.cd as number) * (params.referenceAreaM2 ?? (measured as NonNullable<typeof measured>).frontal);
    const q = 0.5 * air.densityKgM3 * speed * speed;
    const pressureDrag = q * cdA;
    const reynolds = params.lengthM === undefined ? undefined : (air.densityKgM3 * speed * params.lengthM) / air.viscosityPaS;
    const warnings: string[] = [];
    let friction: { model: FrictionModel; formula: string; cf: number; wettedAreaM2: number; dragN: number } | undefined;
    if (params.frictionModel !== undefined) {
      const wetted = params.wettedAreaM2 ?? measured?.wetted;
      if (wetted === undefined || reynolds === undefined || !(reynolds > 1))
        return fail('AER_PARAM_INVALID', 'skin friction needs lengthM, speed > 0 and wettedAreaM2 (or entityIds)', ['frictionModel']);
      const cf = skinFrictionCoefficient(params.frictionModel, reynolds);
      const [low, high] = FRICTION_RANGE[params.frictionModel];
      if (reynolds < low || reynolds > high)
        warnings.push(`Re ${sig(reynolds)} is outside the ${params.frictionModel} range ${low}..${high}.`);
      friction = {
        model: params.frictionModel,
        formula: FRICTION_MODELS[params.frictionModel],
        cf: sig(cf),
        wettedAreaM2: sig(wetted),
        dragN: sig(cf * q * wetted),
      };
    }
    const mach = speed / air.speedOfSoundMS;
    if (mach > 0.3) warnings.push(`Mach ${sig(mach)} > 0.3: compressibility raises Cd; use test data for the Mach number.`);
    const drag = pressureDrag + (friction?.dragN ?? 0);
    const data = {
      air: { densityKgM3: sig(air.densityKgM3), viscosityPaS: sig(air.viscosityPaS), source: air.source, defaulted: air.defaulted },
      speedMS: sig(speed),
      mach: sig(mach),
      dynamicPressurePa: sig(q),
      area: {
        source:
          params.cdA !== undefined
            ? 'cdA'
            : params.referenceAreaM2 !== undefined
              ? 'cd x referenceAreaM2'
              : 'cd x frontal area of entityIds',
        cdA: sig(cdA),
        ...(params.cd === undefined ? {} : { cd: params.cd }),
        ...(measured === undefined ? {} : { frontalAreaM2: sig(measured.frontal), frontalUncertaintyM2: sig(measured.uncertainty) }),
        ...(params.referenceAreaM2 === undefined ? {} : { referenceAreaM2: params.referenceAreaM2 }),
      },
      pressureDragN: sig(pressureDrag),
      ...(friction === undefined ? {} : { friction }),
      ...(reynolds === undefined ? {} : { reynolds: sig(reynolds) }),
      dragN: sig(drag),
      powerW: sig(drag * speed),
      warnings,
      provenance: {
        formulas: { drag: 'D = ½ ρ V² Cd A', power: 'P = D V', ...(friction === undefined ? {} : { friction: friction.formula }) },
      },
    };
    return briefReport(
      doc,
      `Drag at ${data.speedMS} m/s (${air.source}, ρ ${data.air.densityKgM3}): CdA ${data.area.cdA} m², q ${data.dynamicPressurePa} Pa -> D ${data.dragN} N, P ${data.powerW} W` +
        (friction === undefined ? '.' : ` (friction ${friction.dragN} N, Cf ${friction.cf}).`),
      data,
    );
  },
});
