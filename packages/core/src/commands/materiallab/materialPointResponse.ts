/** material_point_response (PHY-02 §4, §5.3): drive one material point of a constitutive set along a path, no mesh. */

import { convertValue, isUnitFailure } from '../../lib/quantity';
import { runMaterialPoint } from '../../model/materialLaws/driver';
import {
  COMPONENTS,
  DEFAULT_INCREMENTS,
  MAX_ROWS,
  PRESETS,
  type Component,
  type ComponentControl,
  type DriverOutcome,
  type PathStep,
} from '../../model/materialLaws/driverTypes';
import { modelUnverifiedReasonsOf, needsReview } from '../../model/materialLaws/references';
import type { MaterialModel, SetSlot } from '../../model/materialModel';
import type { NamedDefault, PropertyRecord } from '../../model/propertyModelEval';
import type { CadDocument } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { report } from '../noop';
import { matlRefusal } from '../document/materialModelRefusal';
import { isRefusal, selectSlots } from './setSelection';

const command = 'material_point_response';

const quantity = z.object({ value: z.number().describe('Numeric value.'), unit: z.string().describe("Unit, e.g. 'MPa', 's', 'K'.") });

const DEFAULTS: Readonly<Record<string, NamedDefault>> = {
  incrementsPerStep: { name: 'incrementsPerStep', value: DEFAULT_INCREMENTS, source: 'llull choice', defaulted: true },
  stepDuration: {
    name: 'stepDuration',
    value: 1,
    source: 'llull choice (seconds; only rate, time and temperature laws read it)',
    defaulted: true,
  },
  newtonTolerance: {
    name: 'newtonTolerance',
    value: '1e-10 σ_y local, 1e-9 relative global, 50 iterations',
    source: 'llull choice (TECHNICAL_SPEC §5.3)',
    defaulted: true,
  },
  johnsonCookBelowReferenceRate: {
    name: 'johnsonCookBelowReferenceRate',
    value: 1,
    source: 'llull rule: no softening below the reference rate (OQ-PROP-08)',
    defaulted: true,
  },
  kinematicsPreset: {
    name: 'kinematicsPreset',
    value: 'uniaxial_stress',
    source: 'llull choice for finite hyperelastic runs',
    defaulted: true,
  },
  output: { name: 'output', value: 'steps', source: 'llull choice: one row per step end', defaulted: true },
};

interface RawControl {
  readonly strain?: number | undefined;
  readonly stress?: { readonly value: number; readonly unit: string } | undefined;
}

type Conversion = { readonly steps: PathStep[] } | { readonly path: string; readonly message: string };

const convertTo = (q: { value: number; unit: string }, unit: string): number | null => {
  const converted = convertValue(q.value, q.unit, unit);
  return isUnitFailure(converted) ? null : converted.value;
};

/** Steps as params → numeric path (MPa, s, K). */
function toPath(
  steps: ReadonlyArray<{
    duration?: { value: number; unit: string } | undefined;
    temperature?: { value: number; unit: string } | undefined;
    increments?: number | undefined;
    control: Record<string, RawControl>;
  }>,
  used: Set<string>,
): Conversion {
  const out: PathStep[] = [];
  for (const [i, step] of steps.entries()) {
    const control: Partial<Record<Component, ComponentControl>> = {};
    for (const [key, raw] of Object.entries(step.control)) {
      const path = `steps[${i}].control.${key}`;
      if (!(COMPONENTS as readonly string[]).includes(key)) return { path, message: `unknown component '${key}' (xx, yy, zz, xy, xz, yz)` };
      if ((raw.strain === undefined) === (raw.stress === undefined))
        return { path, message: 'give exactly one of strain (dimensionless) or stress ({ value, unit })' };
      if (raw.strain !== undefined) control[key as Component] = { strain: raw.strain };
      else if (raw.stress !== undefined) {
        const mpa = convertTo(raw.stress, 'MPa');
        if (mpa === null) return { path: `${path}.stress.unit`, message: `'${raw.stress.unit}' is not a stress unit` };
        control[key as Component] = { stress: mpa };
      }
    }
    const duration = step.duration === undefined ? null : convertTo(step.duration, 's');
    if (step.duration !== undefined && duration === null)
      return { path: `steps[${i}].duration.unit`, message: `'${step.duration.unit}' is not a time unit` };
    const temperature = step.temperature === undefined ? null : convertTo(step.temperature, 'K');
    if (step.temperature !== undefined && temperature === null)
      return { path: `steps[${i}].temperature.unit`, message: `'${step.temperature.unit}' is not a temperature unit` };
    if (step.increments === undefined) used.add('incrementsPerStep');
    out.push({ duration, temperatureK: temperature, increments: step.increments ?? DEFAULT_INCREMENTS, control });
  }
  return { steps: out };
}

const UNITS = {
  stress: 'MPa',
  strain: '1 (engineering shear for xy, xz, yz)',
  time: 's',
  T: 'K',
  energyDensity: 'MJ/m^3',
  backStress: 'MPa',
} as const;

/**
 * @affects nothing — read-only; data { rows, units, defaults[], warnings[], unverified, unverifiedReasons, reviewRequired, models[] }
 * @invariant deterministic; uncontrolled components stay stress-free; at most 10 000 rows
 * @failure unknown material / set -> MAT_RECORD_NOT_FOUND / MATL_MODEL_NOT_FOUND; bad control -> MATL_PATH_INVALID; Newton failure ->
 *   MATL_PATH_DIVERGED (step, increment); beyond validity -> warning MATL_STRAIN_OUT_OF_RANGE; property-model refusals pass through
 */
export const materialPointResponse = defineCommand({
  name: command,
  annotations: { readOnly: true },
  description:
    'Drive one material point of a constitutive set along a path and return stress-strain history without a mesh. Each step imposes strain ' +
    '(dimensionless; engineering shear for xy, xz, yz) or stress ({ value, unit }) per component xx, yy, zz, xy, xz, yz, reached linearly over ' +
    'its increments; uncontrolled components stay stress-free. Presets fill components a step leaves out: uniaxial_strain, plane_strain (zz, xz, yz ' +
    'held at zero strain, NAFEMS NL1), equibiaxial (yy follows xx), pure_shear (yy held), simple_shear, uniaxial_stress. Give increments per step ' +
    '(default 100, named). Small strain for elasticity, J2 plasticity, Ramberg-Osgood, Prony viscoelasticity and creep; finite for hyperelastic laws ' +
    '(incompressible, D = 0: modes uniaxial_stress / equibiaxial / pure_shear with xx = nominal strain λ − 1 or nominal stress; compressible, D1 > 0: general paths ' +
    'on any of the six components, shear by the simple-shear gradient, uncontrolled components stress-free and solved by Newton, so uniaxial stress contracts laterally; ' +
    'rows carry Hencky strain, Cauchy stress, principal stretches, nominal stress and volumeRatio J). ' +
    'Stress in MPa, time in s, T in K; step and increment are 1-based; at most 100 000 increments per call.  Next: compare with test data, then check_material_models.',
  params: z.object({
    material: z.string().describe('Material id (create_material name).'),
    set: z.string().optional().describe('Constitutive set id (default: the material default set).'),
    model: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'Ad-hoc law in add_material_model input form, not stored; it fills the slot of its behaviour (alone when no set is given).',
      ),
    kinematics: z.enum(['small', 'finite']).describe("'small' strain, or 'finite' for hyperelastic homogeneous modes."),
    preset: z.enum(PRESETS).optional().describe('State preset filling the components a step does not control.'),
    steps: z
      .array(
        z.object({
          duration: quantity.optional().describe('Step duration (default 1 s; read by rate, time and creep laws).'),
          temperature: quantity.optional().describe('Temperature of the step; referenced property models are evaluated there.'),
          increments: z.number().int().optional().describe('Equal increments in the step (default 100).'),
          control: z
            .record(
              z.string(),
              z.object({
                strain: z.number().optional().describe('Strain target at the end of the step.'),
                stress: quantity.optional().describe('Stress target at the end of the step.'),
              }),
            )
            .describe('Per component xx, yy, zz, xy, xz, yz: exactly one of strain or stress. Absolute targets at the end of the step.'),
        }),
      )
      .describe('The path: ordered steps.'),
    output: z
      .enum(['increments', 'steps'])
      .optional()
      .describe("'steps' (default): one row per step end; 'increments': every increment (at most 10 000 rows)."),
    forCertification: z
      .boolean()
      .optional()
      .describe('Refuse a result built on unverified data (MAT_VALUE_UNVERIFIED) and flag reviewRequired.'),
  }),
  run: (doc, params): CommandResult => {
    const material = Object.hasOwn(doc.materials, params.material) ? doc.materials[params.material] : undefined;
    if (material === undefined)
      return refuse(doc, 'MAT_RECORD_NOT_FOUND', `no material '${params.material}'`, [params.material], 'material');
    const selection = selectSlots(material, params.material, params.set, params.model);
    if (isRefusal(selection)) return refuse(doc, selection.code, selection.message, selection.ids, selection.path, selection.remediation);
    const used = new Set<string>();
    const converted = toPath(params.steps, used);
    if ('path' in converted) return refuse(doc, 'MATL_PATH_INVALID', converted.message, [], converted.path);
    const output = params.output ?? 'steps';
    if (params.output === undefined) used.add('output');
    const rowCount = output === 'steps' ? converted.steps.length : converted.steps.reduce((sum, step) => sum + step.increments, 0);
    if (rowCount > MAX_ROWS)
      return refuse(
        doc,
        'MATL_PATH_INVALID',
        `${rowCount} rows exceed the limit of ${MAX_ROWS}`,
        [],
        'output',
        "use output 'steps' or fewer increments",
      );
    const record = { name: params.material, ...(material.propertyModels !== undefined ? { propertyModels: material.propertyModels } : {}) };
    const outcome = runMaterialPoint({
      record,
      slots: selection.slots,
      kinematics: params.kinematics,
      preset: params.preset,
      steps: converted.steps,
      output,
    });
    if ('code' in outcome)
      return {
        ...refuse(
          doc,
          outcome.code,
          `${outcome.message}${outcome.step !== undefined ? ` (step ${outcome.step}${outcome.increment !== undefined ? `, increment ${outcome.increment}` : ''})` : ''}`,
          [],
          outcome.path,
          outcome.remediation,
        ),
        data: {
          code: outcome.code,
          path: outcome.path,
          step: outcome.step ?? null,
          increment: outcome.increment ?? null,
          remediation: outcome.remediation ?? null,
        },
      };
    return success(
      doc,
      params.material,
      selection.setId,
      selection.slots,
      record,
      outcome,
      [...used],
      converted.steps.length,
      params.forCertification === true,
    );
  },
});

const refuse = (
  doc: CadDocument,
  code: string,
  message: string,
  ids: readonly string[],
  path: string,
  remediation?: string,
): CommandResult => matlRefusal(doc, command, code, message, ids, path, remediation);

function success(
  doc: CadDocument,
  materialId: string,
  setId: string,
  slots: Readonly<Partial<Record<SetSlot, MaterialModel>>>,
  record: PropertyRecord,
  outcome: DriverOutcome,
  usedDefaults: readonly string[],
  stepCount: number,
  forCertification: boolean,
): CommandResult {
  const models = Object.entries(slots).flatMap(([slot, model]) => (model === undefined ? [] : [{ slot, model }]));
  const reasons = new Set<string>(outcome.unverifiedReasons);
  for (const { slot, model } of models)
    for (const reason of modelUnverifiedReasonsOf(model, record)) reasons.add(`${slot} '${model.id}': ${reason}`);
  const reviewRequired = forCertification || outcome.reviewRequired || models.some(({ model }) => needsReview(model));
  if (forCertification && reasons.size > 0)
    return {
      ...refuse(
        doc,
        'MAT_VALUE_UNVERIFIED',
        `the result is unverified (${[...reasons].join('; ')}) and cannot be used for certification`,
        [],
        'forCertification',
        'use verified bases and sourced, reviewed models',
      ),
      data: { code: 'MAT_VALUE_UNVERIFIED', reviewRequired: true, unverifiedReasons: [...reasons] },
    };
  const defaults = [...new Set([...usedDefaults, ...outcome.usedDefaults])].flatMap((name) =>
    DEFAULTS[name] === undefined ? [] : [DEFAULTS[name]],
  );
  const last = outcome.rows[outcome.rows.length - 1];
  const peak = outcome.rows.reduce((max, row) => Math.max(max, row.vonMises), 0);
  return report(
    doc,
    `${command} '${materialId}/${setId}': ${stepCount} step(s), ${outcome.rows.length} row(s); final von Mises ${last?.vonMises.toPrecision(8)} MPa, peak ${peak.toPrecision(8)} MPa, equivalent plastic strain ${last?.eqPlasticStrain.toPrecision(6)}; ${
      outcome.warnings.length
    } warning(s)${reasons.size > 0 ? `; unverified (${[...reasons].join('; ')})` : ''}${reviewRequired ? '; review required' : ''}.`,
    {
      rows: outcome.rows,
      units: UNITS,
      defaults,
      warnings: outcome.warnings,
      unverified: reasons.size > 0,
      unverifiedReasons: [...reasons],
      reviewRequired,
      set: setId,
      models: models.map(({ slot, model }) => ({ slot, id: model.id, kind: model.model.kind, parametersSha256: model.parametersSha256 })),
    },
  );
}
