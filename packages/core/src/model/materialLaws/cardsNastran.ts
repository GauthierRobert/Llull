/**
 * Nastran small-field cards (PHY-02 §6.2, pyNastran definitions): MAT1 for isotropic elasticity and MATS1 (TYPE PLASTIC) for J2 with perfect
 * or linear isotropic hardening (HR 1) and perfect + linear kinematic hardening (HR 2). Everything else is refused: MAT9, MATHE, TABLES1
 * tables, creep and viscoelastic cards are not verified yet (OQ-MATL-06).
 */

import type { LawOf } from '../materialModel';
import { field, nastranReal } from './cardFormat';
import type { CardOutput, CardRequest } from './cardTypes';
import { resolveIsotropic } from './hardening';
import { failure, isLawFailure, newTrace, resolveAll, resolveParameter, type LawFailure } from './resolve';

const unsupported = (kind: string, reason: string): LawFailure =>
  failure('MATL_EXPORT_UNSUPPORTED', `law ${kind}`, `${kind} cannot be written for nastran: ${reason}`, 'use another law or target');

/**
 * Nastran cards of a constitutive set.
 * @failure other laws / more than one temperature / a value wider than 8 characters -> MATL_EXPORT_UNSUPPORTED; missing validity is not needed
 */
export function writeNastranCards(request: CardRequest): CardOutput | LawFailure {
  const { slots } = request;
  const temperature = request.temperaturesK[0] ?? null;
  if (request.temperaturesK.length > 1) return unsupported('temperature table', 'temperature-dependent data needs MATT cards');
  const elastic = slots.elastic;
  if (elastic === undefined || elastic.model.kind !== 'elastic_isotropic')
    return unsupported(
      elastic?.model.kind ?? 'set without isotropic elasticity',
      'only elastic_isotropic (MAT1) is verified; MAT9 is pending',
    );
  for (const slot of ['hyperelastic', 'viscoelastic', 'creep', 'rate'] as const)
    if (slots[slot] !== undefined)
      return unsupported(slots[slot]?.model.kind ?? slot, 'MATHE, creep, rate and viscoelastic cards are not verified');
  const trace = newTrace();
  const env = { record: request.record, at: temperature === null ? {} : { T: { value: temperature, unit: 'K' } }, trace };
  const law = elastic.model as LawOf<'elastic_isotropic'>;
  const e = resolveAll(
    { E: { parameter: law.E, dimension: 'stress' }, nu: { parameter: law.nu, dimension: 'dimensionless' } },
    env,
    `models.${elastic.id}`,
  );
  if (isLawFailure(e)) return e;
  const text = (value: number): string | LawFailure =>
    nastranReal(value) ?? unsupported('number', `${value} does not fit the 8-character small field`);
  const mid = String(request.mid);
  const E = text(e.E);
  const nu = text(e.nu);
  if (isLawFailure(E)) return E;
  if (isLawFailure(nu)) return nu;
  const lines = [`MAT1    ${field(mid)}${field(E)}${field('')}${nu}`.trimEnd()];
  const plastic = slots.plastic;
  if (plastic !== undefined) {
    const j2 = plastic.model;
    if (j2.kind !== 'j2_plasticity') return unsupported(j2.kind, 'only j2_plasticity maps to MATS1');
    if (j2.isotropic.kind !== 'perfect' && j2.isotropic.kind !== 'linear')
      return unsupported(`j2_plasticity (${j2.isotropic.kind} hardening)`, 'a TABLES1 stress-strain table is not verified (OQ-MATL-06)');
    if (j2.kinematic.kind === 'chaboche') return unsupported('j2_plasticity with chaboche back stresses', 'no MATS1 mapping');
    const isotropic = resolveIsotropic(j2.isotropic, env, e.E, temperature, `models.${plastic.id}.isotropic`);
    if (isLawFailure(isotropic)) return isotropic;
    let hardening = 1;
    let slope = isotropic.linearSlope ?? 0;
    if (j2.kinematic.kind === 'linear') {
      if (j2.isotropic.kind !== 'perfect')
        return unsupported('j2_plasticity (isotropic + kinematic)', 'combined hardening is not verified');
      const C = resolveParameter(j2.kinematic.C, 'stress', env, `models.${plastic.id}.kinematic.C`);
      if (isLawFailure(C)) return C;
      hardening = 2;
      slope = C;
    }
    const h = text(slope);
    const yieldText = text(isotropic.y0);
    if (isLawFailure(h)) return h;
    if (isLawFailure(yieldText)) return yieldText;
    lines.push(
      `MATS1   ${field(mid)}${field('')}${field('PLASTIC')}${field(h)}${field('1')}${field(String(hardening))}${yieldText}`.trimEnd(),
    );
  }
  return { lines, warnings: [], usedDefaults: [], unverifiedReasons: [...trace.unverifiedReasons], reviewRequired: trace.reviewRequired };
}
