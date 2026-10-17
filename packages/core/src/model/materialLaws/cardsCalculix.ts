/**
 * CalculiX material cards (PHY-02 §6.1, manual 2.23): *ELASTIC (ISO / ENGINEERING CONSTANTS / ANISO), *PLASTIC (isotropic, kinematic,
 * combined + *CYCLIC HARDENING, Johnson-Cook + *RATE DEPENDENT), *DEFORMATION PLASTICITY, *HYPERELASTIC, *CREEP,LAW=NORTON.
 * Linear laws are tabulated up to the model's declared equivalent-plastic-strain validity (named rule).
 */

import type { LawOf, MaterialModel } from '../materialModel';
import { calculixLines, calculixNumber } from './cardFormat';
import type { CardOutput, CardRequest } from './cardTypes';
import { symmetricFromUpperTriangle } from './elastic';
import { multilinearCurve, resolveIsotropic } from './hardening';
import { resolveHyper, isIncompressible, type HyperLaw } from './hyperResolve';
import { warning, type MatlIssue } from './issues';
import {
  convertQuantity,
  failure,
  isLawFailure,
  newTrace,
  resolveAll,
  resolveParameter,
  type LawFailure,
  type ResolveEnv,
} from './resolve';
import { resolveOrthotropicConstants } from './elasticResolve';

const VOCE_POINTS = 21;

const unsupported = (kind: string, reason: string): LawFailure =>
  failure(
    'MATL_EXPORT_UNSUPPORTED',
    `law ${kind}`,
    `${kind} cannot be written for calculix: ${reason}`,
    'use another law or target, or the V2 MFront route',
  );

/** Upper bound of the equivalent-plastic-strain validity of a model (equation range, else data range), or null. */
function plasticStrainLimit(model: MaterialModel): number | null {
  const range = model.validity?.find((candidate) => candidate.variable === 'equivalentPlasticStrain');
  return range === undefined ? null : (range.equation ?? range.data)[1];
}

const row = (values: readonly number[], temperature: number | null): string =>
  [...values, ...(temperature === null ? [] : [temperature])].map(calculixNumber).join(',');

interface Context {
  readonly request: CardRequest;
  readonly temperatures: readonly (number | null)[];
  readonly trace: ReturnType<typeof newTrace>;
  readonly warnings: MatlIssue[];
  readonly defaults: Set<string>;
}

const envAt = (context: Context, temperature: number | null): ResolveEnv => ({
  record: context.request.record,
  at: temperature === null ? {} : { T: { value: temperature, unit: 'K' } },
  trace: context.trace,
});

function elasticCards(model: MaterialModel, context: Context): string[] | LawFailure {
  const law = model.model as LawOf<'elastic_isotropic' | 'elastic_orthotropic' | 'elastic_transversely_isotropic' | 'elastic_anisotropic'>;
  const path = `models.${model.id}`;
  const lines: string[] = [];
  let header = '*ELASTIC';
  for (const temperature of context.temperatures) {
    const env = envAt(context, temperature);
    let values: number[];
    if (law.kind === 'elastic_isotropic') {
      const resolved = resolveAll(
        { E: { parameter: law.E, dimension: 'stress' }, nu: { parameter: law.nu, dimension: 'dimensionless' } },
        env,
        path,
      );
      if (isLawFailure(resolved)) return resolved;
      values = [resolved.E, resolved.nu];
    } else if (law.kind === 'elastic_orthotropic' || law.kind === 'elastic_transversely_isotropic') {
      header = '*ELASTIC,TYPE=ENGINEERING CONSTANTS';
      const c = resolveOrthotropicConstants(law, env, path);
      if (isLawFailure(c)) return c;
      values = [c.E1, c.E2, c.E3, c.nu12, c.nu13, c.nu23, c.G12, c.G13, c.G23];
    } else {
      header = '*ELASTIC,TYPE=ANISO';
      const scale = convertQuantity(1, law.unit, 'stress', `${path}.unit`);
      if (isLawFailure(scale)) return scale;
      const d = symmetricFromUpperTriangle(law.stiffness).map((r) => r.map((value) => value * scale));
      const at = (i: number, j: number): number => d[i]?.[j] ?? 0;
      // Voigt 11 22 33 12 13 23 -> D1111 D1122 D2222 D1133 D2233 D3333 D1112 D2212 D3312 D1212 D1113 D2213 D3313 D1213 D1313 D1123 D2223 D3323 D1223 D1323 D2323
      values = [
        at(0, 0),
        at(0, 1),
        at(1, 1),
        at(0, 2),
        at(1, 2),
        at(2, 2),
        at(0, 3),
        at(1, 3),
        at(2, 3),
        at(3, 3),
        at(0, 4),
        at(1, 4),
        at(2, 4),
        at(3, 4),
        at(4, 4),
        at(0, 5),
        at(1, 5),
        at(2, 5),
        at(3, 5),
        at(4, 5),
        at(5, 5),
      ];
    }
    lines.push(...calculixLines([...values, ...(temperature === null ? [] : [temperature])].map(calculixNumber)));
  }
  return [header, ...lines];
}

/** [stress, plastic strain] rows of a tabulated curve for one temperature. */
function isotropicRows(
  model: MaterialModel,
  context: Context,
  temperature: number | null,
): ReadonlyArray<readonly [number, number]> | LawFailure {
  const law = (model.model as LawOf<'j2_plasticity'>).isotropic;
  const path = `models.${model.id}.isotropic`;
  const env = envAt(context, temperature);
  const resolved = resolveIsotropic(law, env, null, temperature, path);
  if (isLawFailure(resolved)) return resolved;
  const limit = plasticStrainLimit(model);
  if (law.kind === 'perfect') return [[resolved.y0, 0]];
  if (law.kind === 'multilinear') {
    const points = multilinearCurve(law, temperature, path);
    return isLawFailure(points) ? points : points.map(([strain, stress]) => [stress, strain] as const);
  }
  if (limit === null)
    return failure(
      'MATL_VALIDITY_MISSING',
      `models.${model.id}.validity`,
      `${law.kind} hardening is tabulated up to the equivalent-plastic-strain validity: give validity { variable: 'equivalentPlasticStrain' }`,
      'add validity (equivalentPlasticStrain, T)',
    );
  const points = law.kind === 'voce' ? VOCE_POINTS : 2;
  if (law.kind === 'voce') context.defaults.add('voceTablePoints');
  context.defaults.add('linearLawExtension');
  return Array.from({ length: points }, (_, i) => {
    const strain = (limit * i) / (points - 1);
    return [resolved.stress(strain), strain] as const;
  });
}

function plasticCards(model: MaterialModel, rate: MaterialModel | undefined, context: Context): string[] | LawFailure {
  const law = model.model as LawOf<'j2_plasticity' | 'ramberg_osgood'>;
  const path = `models.${model.id}`;
  if (law.kind === 'ramberg_osgood') {
    const lines = ['*DEFORMATION PLASTICITY'];
    for (const temperature of context.temperatures) {
      const resolved = resolveAll(
        {
          E: { parameter: law.E, dimension: 'stress' },
          nu: { parameter: law.nu, dimension: 'dimensionless' },
          sigma0: { parameter: law.sigma0, dimension: 'stress' },
        },
        envAt(context, temperature),
        path,
      );
      if (isLawFailure(resolved)) return resolved;
      lines.push(row([resolved.E, resolved.nu, resolved.sigma0, law.n, law.alpha], temperature));
    }
    return lines;
  }
  if (law.kinematic.kind === 'chaboche')
    return unsupported('j2_plasticity with chaboche back stresses', 'native CalculiX kinematic hardening takes one curve');
  if (law.isotropic.kind === 'johnson_cook') {
    const j = law.isotropic;
    const lines = ['*PLASTIC,HARDENING=JOHNSON COOK'];
    for (const temperature of context.temperatures) {
      const a = convertQuantity(j.A.value, j.A.unit, 'stress', `${path}.isotropic.A`);
      const b = convertQuantity(j.B.value, j.B.unit, 'stress', `${path}.isotropic.B`);
      const melt = convertQuantity(j.meltTemperature.value, j.meltTemperature.unit, 'temperature', `${path}.isotropic.meltTemperature`);
      const transition = convertQuantity(
        j.transitionTemperature.value,
        j.transitionTemperature.unit,
        'temperature',
        `${path}.isotropic.transitionTemperature`,
      );
      for (const part of [a, b, melt, transition]) if (isLawFailure(part)) return part;
      lines.push(row([a as number, b as number, j.n, j.m, melt as number, transition as number], temperature));
    }
    if (rate?.model.kind === 'rate_johnson_cook') {
      const reference = convertQuantity(
        rate.model.referenceRate.value,
        rate.model.referenceRate.unit,
        'rate',
        `models.${rate.id}.referenceRate`,
      );
      if (isLawFailure(reference)) return reference;
      lines.push('*RATE DEPENDENT,TYPE=JOHNSON COOK', row([rate.model.C, reference], null));
    }
    return lines;
  }
  if (rate?.model.kind === 'rate_cowper_symonds') return unsupported('rate_cowper_symonds', 'no native CalculiX card');
  const kinematic = law.kinematic.kind === 'linear' ? law.kinematic : null;
  const tables = (build: (temperature: number | null) => ReadonlyArray<readonly [number, number]> | LawFailure): string[] | LawFailure => {
    const out: string[] = [];
    for (const temperature of context.temperatures) {
      const points = build(temperature);
      if (isLawFailure(points)) return points;
      out.push(...points.map(([stress, strain]) => row([stress, strain], temperature)));
    }
    return out;
  };
  const kinematicRows = (temperature: number | null): ReadonlyArray<readonly [number, number]> | LawFailure => {
    if (kinematic === null) return [];
    const limit = plasticStrainLimit(model);
    const C = resolveParameter(kinematic.C, 'stress', envAt(context, temperature), `${path}.kinematic.C`);
    if (isLawFailure(C)) return C;
    const yieldStress = resolveIsotropic(law.isotropic, envAt(context, temperature), null, temperature, `${path}.isotropic`);
    if (isLawFailure(yieldStress)) return yieldStress;
    if (limit === null)
      return failure(
        'MATL_VALIDITY_MISSING',
        `${path}.validity`,
        'linear kinematic hardening is tabulated up to the equivalent-plastic-strain validity',
        'add validity (equivalentPlasticStrain, T)',
      );
    context.defaults.add('linearLawExtension');
    return [
      [yieldStress.y0, 0],
      [yieldStress.y0 + C * limit, limit],
    ];
  };
  if (kinematic === null) {
    const body = tables((temperature) => isotropicRows(model, context, temperature));
    return isLawFailure(body) ? body : ['*PLASTIC,HARDENING=ISOTROPIC', ...body];
  }
  if (law.isotropic.kind === 'perfect') {
    const body = tables(kinematicRows);
    return isLawFailure(body) ? body : ['*PLASTIC,HARDENING=KINEMATIC', ...body];
  }
  const combined = tables(kinematicRows);
  if (isLawFailure(combined)) return combined;
  const cyclic = tables((temperature) => isotropicRows(model, context, temperature));
  return isLawFailure(cyclic) ? cyclic : ['*PLASTIC,HARDENING=COMBINED', ...combined, '*CYCLIC HARDENING', ...cyclic];
}

const HYPER_CARD: Readonly<Record<HyperLaw['kind'], string>> = {
  hyper_neo_hooke: 'NEO HOOKE',
  hyper_mooney_rivlin: 'MOONEY-RIVLIN',
  hyper_polynomial: 'POLYNOMIAL',
  hyper_reduced_polynomial: 'REDUCED POLYNOMIAL',
  hyper_yeoh: 'YEOH',
  hyper_ogden: 'OGDEN',
  hyper_arruda_boyce: 'ARRUDA-BOYCE',
};

/** Values in manual field order: C or μ/α first, then the compressibility terms D (1/MPa). */
function hyperValues(law: HyperLaw): number[] | null {
  const mpa = (value: number, unit: string, inverse = false): number | null => {
    const c = convertQuantity(1, unit, 'stress', '');
    return isLawFailure(c) ? null : inverse ? value / c : value * c;
  };
  const q = (quantity: { value: number; unit: string }): number | null => mpa(quantity.value, quantity.unit);
  const d = (quantity: { value: number; unit: string }): number | null => {
    const c = convertQuantity(1, quantity.unit.replace(/^1\//, ''), 'stress', '');
    return isLawFailure(c) ? null : quantity.value / c;
  };
  const all = (values: readonly (number | null)[]): number[] | null =>
    values.some((value) => value === null) ? null : (values as number[]);
  switch (law.kind) {
    case 'hyper_neo_hooke':
      return all([q(law.C10), d(law.D1)]);
    case 'hyper_mooney_rivlin':
      return all([q(law.C10), q(law.C01), d(law.D1)]);
    case 'hyper_yeoh':
      return all([q(law.C10), q(law.C20), q(law.C30), ...law.D.map((value) => d({ value, unit: law.compliance }))]);
    case 'hyper_polynomial': {
      const keys = (['C10', 'C01', 'C20', 'C11', 'C02', 'C30', 'C21', 'C12', 'C03'] as const).slice(
        0,
        law.order === 1 ? 2 : law.order === 2 ? 5 : 9,
      );
      return all([...keys.map((key) => mpa(law.C[key] ?? 0, law.stressUnit)), ...law.D.map((value) => mpa(value, law.stressUnit, true))]);
    }
    case 'hyper_reduced_polynomial':
      return all([...law.Ci0.map((value) => mpa(value, law.stressUnit)), ...law.D.map((value) => mpa(value, law.stressUnit, true))]);
    case 'hyper_ogden':
      return all([
        ...law.terms.flatMap((term) => [mpa(term.mu, law.stressUnit), term.alpha]),
        ...law.D.map((value) => mpa(value, law.stressUnit, true)),
      ]);
    case 'hyper_arruda_boyce':
      return all([q(law.mu), law.lambdaM, d(law.D)]);
  }
}

function hyperCards(model: MaterialModel, context: Context): string[] | LawFailure {
  const law = model.model as HyperLaw;
  if (resolveHyper(law) === null)
    return failure('MATL_LAW_PARAMS_INVALID', `models.${model.id}`, 'the hyperelastic law does not resolve to numbers');
  const values = hyperValues(law);
  if (values === null) return failure('MATL_LAW_PARAMS_INVALID', `models.${model.id}`, 'a unit of the hyperelastic law does not convert');
  if (isIncompressible(law))
    context.warnings.push(
      warning(
        'MATL_INCOMPRESSIBLE_DEFAULT',
        `models.${model.id}`,
        'D = 0 means incompressible; CalculiX substitutes a small compressibility: give D explicitly if bulk behaviour matters',
      ),
    );
  const count =
    law.kind === 'hyper_ogden'
      ? law.terms.length
      : law.kind === 'hyper_polynomial' || law.kind === 'hyper_reduced_polynomial'
        ? law.order
        : 0;
  const suffix = count > 0 ? `,N=${count}` : '';
  const lines: string[] = [];
  for (const temperature of context.temperatures)
    lines.push(...calculixLines([...values, ...(temperature === null ? [] : [temperature])].map(calculixNumber)));
  return [`*HYPERELASTIC,${HYPER_CARD[law.kind]}${suffix}`, ...lines];
}

function creepCards(model: MaterialModel, context: Context): string[] | LawFailure {
  const law = model.model as LawOf<'creep_norton' | 'creep_garofalo'>;
  if (law.kind === 'creep_garofalo') return unsupported('creep_garofalo', '*CREEP,LAW=USER needs a creep.f user routine (V2)');
  if (law.hardening !== 'time') return unsupported('creep_norton', 'only time hardening has a native card');
  const inMpa = convertQuantity(1, law.stressUnit, 'stress', `models.${model.id}.stressUnit`);
  if (isLawFailure(inMpa)) return inMpa;
  const A = law.A / inMpa ** law.n;
  return ['*CREEP,LAW=NORTON', ...context.temperatures.map((temperature) => row([A, law.n, law.m], temperature))];
}

/**
 * CalculiX cards of a constitutive set.
 * @failure law or combination CalculiX cannot represent -> MATL_EXPORT_UNSUPPORTED (law named); missing validity -> MATL_VALIDITY_MISSING;
 *   property-model refusals pass through
 */
export function writeCalculixCards(request: CardRequest): CardOutput | LawFailure {
  const { slots } = request;
  const trace = newTrace();
  const warnings: MatlIssue[] = [];
  const defaults = new Set<string>();
  const plastic = slots.plastic?.model;
  const curveTemperatures =
    plastic?.kind === 'j2_plasticity' && plastic.isotropic.kind === 'multilinear' && plastic.isotropic.curves.length > 1
      ? plastic.isotropic.curves.flatMap((curve) => {
          const kelvin =
            curve.temperature === undefined ? null : convertQuantity(curve.temperature.value, curve.temperature.unit, 'temperature', '');
          return kelvin === null || isLawFailure(kelvin) ? [] : [kelvin];
        })
      : [];
  const context: Context = {
    request,
    temperatures: request.temperaturesK.length > 0 ? request.temperaturesK : curveTemperatures.length > 0 ? curveTemperatures : [null],
    trace,
    warnings,
    defaults,
  };
  if (slots.viscoelastic !== undefined) return unsupported('visco_prony', 'CalculiX has no native Prony viscoelasticity');
  const lines = [`*MATERIAL,NAME=${request.name}`];
  const parts: (string[] | LawFailure)[] = [];
  if (slots.elastic !== undefined) parts.push(elasticCards(slots.elastic, context));
  if (slots.hyperelastic !== undefined) parts.push(hyperCards(slots.hyperelastic, context));
  if (slots.plastic !== undefined) parts.push(plasticCards(slots.plastic, slots.rate, context));
  if (slots.creep !== undefined) parts.push(creepCards(slots.creep, context));
  for (const part of parts) {
    if (isLawFailure(part)) return part;
    lines.push(...part);
  }
  return {
    lines,
    warnings,
    usedDefaults: [...defaults],
    unverifiedReasons: [...trace.unverifiedReasons],
    reviewRequired: trace.reviewRequired,
  };
}
