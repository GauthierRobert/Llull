/** compute_aero_drag: drag force and power from CdA, Cd x a reference area or Cd x the frontal area of solids, plus flat-plate skin friction. */

import { defineCommand, z } from '@core/commands/schema';
import type { CadDocument } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { briefReport, sig } from '../shared/results';
import { refuseAero } from './codes';
import { flowParams, geometryArea } from './geometryArea';
import { airStateParams, isAirState, resolveAirState, type AirState } from '../shared/airState';
import { speedParam, toMetresPerSecond } from '../shared/speed';
import { FRICTION_MODELS, FRICTION_RANGE, skinFrictionCoefficient, type FrictionModel } from './skinFriction';

/** Below this Reynolds number every friction law is invalid (ITTC-1957 has its pole at Re 100). */
const MIN_FRICTION_REYNOLDS = 1e3;
/** Above this Mach number compressibility changes Cd (warning only). */
const INCOMPRESSIBLE_MACH = 0.3;

const aeroDragParams = z.object({
  speed: z.number().describe('Air speed in speedUnit, >= 0. Required.'),
  speedUnit: speedParam.speedUnit,
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
});

type AeroDragParams = z.infer<typeof aeroDragParams>;

interface Refusal {
  readonly code: string;
  readonly message: string;
  readonly paths: readonly string[];
  readonly ids?: readonly string[];
}

const isRefusal = (value: unknown): value is Refusal => typeof value === 'object' && value !== null && 'code' in value;

/** CdA in m² and where it came from; the measured frontal / wetted areas when solids were given. */
interface DragArea {
  readonly cdA: number;
  readonly source: 'cdA' | 'cd x referenceAreaM2' | 'cd x frontal area of entityIds';
  readonly measured?: { readonly frontal: number; readonly wetted: number; readonly uncertainty: number };
}

/**
 * Exactly one area source: `cdA`, `cd` + `referenceAreaM2`, or `cd` + `entityIds` (measured on the model).
 * @failure ambiguous or missing source -> AER_AREA_SOURCE_CONFLICT; non-positive value -> AER_PARAM_INVALID; geometry errors of geometryArea
 */
function resolveDragArea(doc: CadDocument, params: AeroDragParams): DragArea | Refusal {
  const sources = [params.cdA !== undefined, params.referenceAreaM2 !== undefined, params.entityIds !== undefined].filter(Boolean).length;
  if (sources !== 1 || (params.cdA !== undefined) === (params.cd !== undefined))
    return {
      code: 'AER_AREA_SOURCE_CONFLICT',
      message: 'give exactly one of cdA, cd + referenceAreaM2, or cd + entityIds',
      paths: ['cdA'],
    };
  if (
    [params.cdA, params.cd, params.referenceAreaM2, params.wettedAreaM2, params.lengthM].some(
      (value) => value !== undefined && !(value > 0),
    )
  )
    return { code: 'AER_PARAM_INVALID', message: 'cdA, cd, referenceAreaM2, wettedAreaM2 and lengthM must be > 0', paths: ['cd'] };
  if (params.cdA !== undefined) return { cdA: params.cdA, source: 'cdA' };
  const cd = params.cd as number;
  if (params.referenceAreaM2 !== undefined) return { cdA: cd * params.referenceAreaM2, source: 'cd x referenceAreaM2' };
  const result = geometryArea(doc, params.entityIds as string[], params.flowDirection, params.resolution);
  if (!result.ok) return { code: result.code, message: result.message, paths: [result.path], ids: result.ids };
  const measured = { frontal: result.area.area, wetted: result.area.wettedArea, uncertainty: result.area.uncertainty };
  return { cdA: cd * measured.frontal, source: 'cd x frontal area of entityIds', measured };
}

interface Friction {
  readonly model: FrictionModel;
  readonly formula: string;
  readonly cf: number;
  readonly wettedAreaM2: number;
  readonly dragN: number;
  readonly warning?: string;
}

/**
 * Flat-plate skin friction Cf(Re_L) · q · S_wet of the chosen correlation.
 * @failure no length / wetted area, or Re below 1e3 -> AER_PARAM_INVALID
 */
function resolveFriction(model: FrictionModel, wetted: number | undefined, reynolds: number | undefined, q: number): Friction | Refusal {
  if (wetted === undefined || reynolds === undefined || !(reynolds > 1))
    return {
      code: 'AER_PARAM_INVALID',
      message: 'skin friction needs lengthM, speed > 0 and wettedAreaM2 (or entityIds)',
      paths: ['frictionModel'],
    };
  if (reynolds < MIN_FRICTION_REYNOLDS)
    return {
      code: 'AER_PARAM_INVALID',
      message: `Re ${sig(reynolds)} is below ${MIN_FRICTION_REYNOLDS}: no flat-plate correlation applies (check speed and lengthM)`,
      paths: ['lengthM'],
    };
  const cf = skinFrictionCoefficient(model, reynolds);
  const [low, high] = FRICTION_RANGE[model];
  return {
    model,
    formula: FRICTION_MODELS[model],
    cf,
    wettedAreaM2: wetted,
    dragN: cf * q * wetted,
    ...(reynolds < low || reynolds > high ? { warning: `Re ${sig(reynolds)} is outside the ${model} range ${low}..${high}.` } : {}),
  };
}

/**
 * @affects none; data = { air, speedMS, dynamicPressurePa, area { source, cdA, cd?, referenceAreaM2? }, dragN, powerW, reynolds?, friction?, warnings, provenance }
 * @invariant D = ½ ρ V² CdA (+ friction Cf q S_wet when wetted area is given); P = D V
 * @failure area sources conflicting / missing -> AER_AREA_SOURCE_CONFLICT; bad air state -> AER_* of resolveAirState; geometry errors as frontal_area
 */
export const aeroDrag = defineCommand({
  name: 'compute_aero_drag',
  annotations: { readsMeshTriangles: true, readOnly: true, idempotent: true },
  description:
    'Read-only aerodynamic drag force and the power to overcome it: D = ½ρV²·CdA, P = D·V. Give exactly one area source: `cdA` (m², ' +
    'e.g. a cyclist 0.21-0.27), `cd` + `referenceAreaM2`, or `cd` + `entityIds` (frontal area measured on the model, see frontal_area). ' +
    'Air from the standard atmosphere at `altitudeM` (default sea level, 1.225 kg/m³) or `densityKgM3`. Optional flat-plate skin ' +
    'friction: `frictionModel` (laminar_blasius, turbulent_power_law, turbulent_prandtl_schlichting, ittc_1957) with `wettedAreaM2` (or the ' +
    'wetted area of entityIds) and `lengthM` (Reynolds length) adds Cf·q·S_wet. Cd is never defaulted: take it from tests or references ' +
    '(flat plate normal to flow 1.28, sphere ~0.47 at Re 1e4-2e5).',
  params: aeroDragParams,
  run: (doc, params): CommandResult => {
    const fail = ({ code, message, paths, ids = [] }: Refusal): CommandResult =>
      refuseAero(doc, 'compute_aero_drag', code, message, [...ids], [...paths]);
    const speed = toMetresPerSecond(params.speed, params.speedUnit ?? 'm/s');
    if (!(speed >= 0)) return fail({ code: 'AER_PARAM_INVALID', message: 'speed must be >= 0', paths: ['speed'] });
    const area = resolveDragArea(doc, params);
    if (isRefusal(area)) return fail(area);
    const air = resolveAirState(params);
    if (!isAirState(air)) return fail({ code: air.code, message: air.message, paths: ['altitudeM'] });
    const q = 0.5 * air.densityKgM3 * speed * speed;
    const reynolds = params.lengthM === undefined ? undefined : (air.densityKgM3 * speed * params.lengthM) / air.viscosityPaS;
    const friction =
      params.frictionModel === undefined
        ? undefined
        : resolveFriction(params.frictionModel, params.wettedAreaM2 ?? area.measured?.wetted, reynolds, q);
    if (isRefusal(friction)) return fail(friction);
    const data = dragData(params, area, air, speed, q, reynolds, friction);
    return briefReport(
      doc,
      `Drag at ${data.speedMS} m/s (${air.source}, ρ ${data.air.densityKgM3}): CdA ${data.area.cdA} m², q ${data.dynamicPressurePa} Pa -> D ${data.dragN} N, P ${data.powerW} W` +
        (data.friction === undefined ? '.' : ` (friction ${data.friction.dragN} N, Cf ${data.friction.cf}).`),
      data,
    );
  },
});

/** `data` of compute_aero_drag (forces N, power W, pressures Pa, areas m², speeds m/s). */
interface DragData {
  readonly air: { readonly densityKgM3: number; readonly viscosityPaS: number; readonly source: string; readonly defaulted: boolean };
  readonly speedMS: number;
  readonly mach: number;
  readonly dynamicPressurePa: number;
  readonly area: {
    readonly source: DragArea['source'];
    readonly cdA: number;
    readonly cd?: number;
    readonly frontalAreaM2?: number;
    readonly frontalUncertaintyM2?: number;
    readonly referenceAreaM2?: number;
  };
  readonly pressureDragN: number;
  readonly friction?: {
    readonly model: FrictionModel;
    readonly formula: string;
    readonly cf: number;
    readonly wettedAreaM2: number;
    readonly dragN: number;
  };
  readonly reynolds?: number;
  readonly dragN: number;
  readonly powerW: number;
  readonly warnings: readonly string[];
  readonly provenance: { readonly formulas: Readonly<Record<string, string>> };
}

/** The command's `data`: air, area source, pressure + friction drag, power, warnings and provenance. */
function dragData(
  params: AeroDragParams,
  area: DragArea,
  air: AirState,
  speed: number,
  q: number,
  reynolds: number | undefined,
  friction: Friction | undefined,
): DragData {
  const mach = speed / air.speedOfSoundMS;
  const pressureDrag = q * area.cdA;
  const drag = pressureDrag + (friction?.dragN ?? 0);
  const warnings = [
    ...(friction?.warning === undefined ? [] : [friction.warning]),
    ...(mach > INCOMPRESSIBLE_MACH ? [`Mach ${sig(mach)} > 0.3: compressibility raises Cd; use test data for the Mach number.`] : []),
  ];
  return {
    air: { densityKgM3: sig(air.densityKgM3), viscosityPaS: sig(air.viscosityPaS), source: air.source, defaulted: air.defaulted },
    speedMS: sig(speed),
    mach: sig(mach),
    dynamicPressurePa: sig(q),
    area: {
      source: area.source,
      cdA: sig(area.cdA),
      ...(params.cd === undefined ? {} : { cd: params.cd }),
      ...(area.measured === undefined
        ? {}
        : { frontalAreaM2: sig(area.measured.frontal), frontalUncertaintyM2: sig(area.measured.uncertainty) }),
      ...(params.referenceAreaM2 === undefined ? {} : { referenceAreaM2: params.referenceAreaM2 }),
    },
    pressureDragN: sig(pressureDrag),
    ...(friction === undefined
      ? {}
      : {
          friction: {
            model: friction.model,
            formula: friction.formula,
            cf: sig(friction.cf),
            wettedAreaM2: sig(friction.wettedAreaM2),
            dragN: sig(friction.dragN),
          },
        }),
    ...(reynolds === undefined ? {} : { reynolds: sig(reynolds) }),
    dragN: sig(drag),
    powerW: sig(drag * speed),
    warnings,
    provenance: {
      formulas: { drag: 'D = ½ ρ V² Cd A', power: 'P = D V', ...(friction === undefined ? {} : { friction: friction.formula }) },
    },
  };
}
