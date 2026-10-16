/** check_material_models (PHY-02, AF-20): readiness check over the material models and constitutive sets of the document. */

import { isConstitutive, lawIssues } from '../../model/materialLawCatalog';
import { writeCalculixCards } from '../../model/materialLaws/cardsCalculix';
import { writeNastranCards } from '../../model/materialLaws/cardsNastran';
import { combinationIssues, setMembers } from '../../model/materialLaws/combination';
import { druckerScan } from '../../model/materialLaws/drucker';
import { constantOrthotropic } from '../../model/materialLaws/validateElastic';
import {
  expandTransverselyIsotropic,
  isotropicStiffness,
  orthotropicReport,
  stiffnessReport,
  symmetricFromUpperTriangle,
} from '../../model/materialLaws/elastic';
import { resolveHyper, type HyperLaw } from '../../model/materialLaws/hyperResolve';
import { constantValue } from '../../model/materialLaws/issues';
import { isLawFailure } from '../../model/materialLaws/resolve';
import { modelUnverifiedReasonsOf } from '../../model/materialLaws/references';
import type { MaterialModel } from '../../model/materialModel';
import { SET_SLOTS } from '../../model/materialModel';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { report } from '../noop';
import { MATL_REMEDIATION } from './materialModelRefusal';

interface Item {
  readonly code: string;
  readonly severity: 'error' | 'warning' | 'info';
  readonly ids: readonly string[];
  readonly message: string;
  readonly remediation: string;
}

const remediationOf = (code: string): string => MATL_REMEDIATION[code] ?? 'see `llull describe add_material_model`';

const item = (code: string, severity: Item['severity'], ids: readonly string[], message: string, remediation?: string): Item => ({
  code,
  severity,
  ids,
  message,
  remediation: remediation ?? remediationOf(code),
});

/** Stability report of a model whose parameters are constants (elastic: pivots and bounds; hyperelastic: Drucker scan), else null. */
function stabilityOf(model: MaterialModel): unknown {
  const law = model.model;
  switch (law.kind) {
    case 'elastic_isotropic': {
      const E = constantValue(law.E, 'stress');
      const nu = constantValue(law.nu, 'dimensionless');
      return E === null || nu === null || !(nu > -1 && nu < 0.5) || !(E > 0) ? null : stiffnessReport(isotropicStiffness(E, nu));
    }
    case 'elastic_orthotropic': {
      const constants = constantOrthotropic(law);
      return constants === null ? null : orthotropicReport(constants);
    }
    case 'elastic_transversely_isotropic': {
      const values = [law.Ep, law.Et, law.nuP, law.nuPT, law.Gt].map((p, i) =>
        constantValue(p, i === 2 || i === 3 ? 'dimensionless' : 'stress'),
      );
      if (values.some((v) => v === null)) return null;
      const [Ep, Et, nuP, nuPT, Gt] = values as number[];
      return orthotropicReport(expandTransverselyIsotropic(law.isotropyPlane, Ep ?? 0, Et ?? 0, nuP ?? 0, nuPT ?? 0, Gt ?? 0));
    }
    case 'elastic_anisotropic':
      return law.stiffness.length === 21 ? stiffnessReport(symmetricFromUpperTriangle(law.stiffness)) : null;
    case 'hyper_neo_hooke':
    case 'hyper_mooney_rivlin':
    case 'hyper_polynomial':
    case 'hyper_reduced_polynomial':
    case 'hyper_yeoh':
    case 'hyper_ogden':
    case 'hyper_arruda_boyce': {
      const resolved = resolveHyper(law as HyperLaw);
      return resolved === null ? null : { drucker: druckerScan(resolved), shearModulus: resolved.shearModulus };
    }
    default:
      return null;
  }
}

/** Monotonic and cyclic Ramberg-Osgood with inconsistent E (MATL_RO_FORMS_DIFFER). */
function roForms(materialName: string, models: readonly MaterialModel[]): Item[] {
  const items: Item[] = [];
  const monotonic = models.filter((m) => m.model.kind === 'ramberg_osgood');
  const cyclic = models.filter((m) => m.model.kind === 'cyclic_ramberg_osgood');
  for (const a of monotonic) {
    for (const b of cyclic) {
      if (a.model.kind !== 'ramberg_osgood' || b.model.kind !== 'cyclic_ramberg_osgood') continue;
      const ea = constantValue(a.model.E, 'stress');
      const cyclicE = constantValue(b.model.E, 'stress');
      if (ea !== null && cyclicE !== null && Math.abs(ea - cyclicE) > 1e-6 * Math.max(ea, cyclicE))
        items.push(
          item(
            'MATL_RO_FORMS_DIFFER',
            'warning',
            [`${materialName}/${a.id}`, `${materialName}/${b.id}`],
            `E differs: ${ea} vs ${cyclicE} MPa`,
            'align E of the monotonic and cyclic Ramberg-Osgood models',
          ),
        );
    }
  }
  return items;
}

/**
 * @affects nothing — read-only; data { status, items[], stability, unverified[], defaults[], notes[] }
 * @invariant status = fail on any error item, warn on any warning, else pass
 */
export const checkMaterialModels = defineCommand({
  name: 'check_material_models',
  annotations: { readOnly: true },
  description:
    'Readiness check of the material models and constitutive sets of the document (or of the listed materials): elastic positive definiteness and ' +
    'Poisson bounds, hyperelastic initial modulus and Drucker stability (MATL_HYPERELASTIC_UNSTABLE: error inside the declared stretch validity, ' +
    'warning outside), hardening curves, Prony and creep parameters, missing validity ranges (MATL_VALIDITY_MISSING), set combination rules ' +
    '(MATL_COMBINATION_INVALID), inconsistent monotonic / cyclic Ramberg-Osgood (MATL_RO_FORMS_DIFFER) and, with target, whether every set can be ' +
    'exported to that solver (MATL_EXPORT_UNSUPPORTED, MATL_INCOMPRESSIBLE_DEFAULT). data.stability holds the pivot / Drucker reports per model; ' +
    'data.unverified lists models with the reasons they are unverified. Read-only; run it before handing a law to the owner or a solver.',
  params: z.object({
    material: z.array(z.string()).optional().describe('Only these material ids (default: every material with material models).'),
    target: z.enum(['calculix', 'nastran']).optional().describe('Also check that every constitutive set can be written for this solver.'),
    usedBy: z
      .enum(['analyses', 'all'])
      .optional()
      .describe("'analyses': only sets an analysis uses (no analyses exist yet: nothing is checked); 'all' (default): every set."),
  }),
  run: (doc, params): CommandResult => {
    const names = params.material ?? Object.keys(doc.materials).filter((name) => (doc.materials[name]?.materialModels?.length ?? 0) > 0);
    const items: Item[] = [];
    const stability: Record<string, unknown> = {};
    const unverified: { id: string; reasons: string[] }[] = [];
    const notes: string[] = [];
    if (params.usedBy === 'analyses') notes.push('no analyses reference constitutive sets yet: only model checks ran');
    for (const name of names) {
      const material = Object.hasOwn(doc.materials, name) ? doc.materials[name] : undefined;
      if (material === undefined) {
        items.push(item('MAT_RECORD_NOT_FOUND', 'error', [name], `no material '${name}'`, remediationOf('MAT_RECORD_NOT_FOUND')));
        continue;
      }
      const models = material.materialModels ?? [];
      const record = { name, ...(material.propertyModels !== undefined ? { propertyModels: material.propertyModels } : {}) };
      for (const model of models) {
        const id = `${name}/${model.id}`;
        const reasons = modelUnverifiedReasonsOf(model, record);
        if (reasons.length > 0) unverified.push({ id, reasons });
        if (isConstitutive(model.model) && (model.validity === undefined || model.validity.length === 0))
          items.push(
            item(
              'MATL_VALIDITY_MISSING',
              'warning',
              [id],
              'constitutive law without validity ranges',
              'add validity (strain, T, stretch) with add_material_model replace: true',
            ),
          );
        for (const issue of lawIssues(model.model, { record, ...(model.validity !== undefined ? { validity: model.validity } : {}) }))
          items.push(item(issue.code, issue.severity, [id], `${issue.path}: ${issue.message}`));
        const report_ = stabilityOf(model);
        if (report_ !== null) stability[id] = report_;
      }
      items.push(...roForms(name, models));
      for (const set of material.constitutiveSets ?? []) {
        const id = `${name}/${set.id}`;
        const problems = combinationIssues(set, models);
        for (const problem of problems) items.push(item(problem.code, 'error', [id], `${problem.path}: ${problem.message}`));
        if (problems.length > 0 || params.target === undefined) continue;
        const slots = setMembers(set, models);
        for (const slot of SET_SLOTS) {
          const model = slots[slot];
          if (model !== undefined && (model.validity === undefined || model.validity.length === 0))
            items.push(
              item(
                'MATL_VALIDITY_MISSING',
                'error',
                [`${name}/${model.id}`],
                `set '${set.id}' cannot be exported without validity on '${model.id}'`,
                'add validity (equivalentPlasticStrain, T, stretch …)',
              ),
            );
        }
        const request = { record, slots, name: id.toUpperCase(), mid: 1, temperaturesK: [] };
        const written = params.target === 'calculix' ? writeCalculixCards(request) : writeNastranCards(request);
        if (isLawFailure(written)) {
          if (written.code === 'MATL_EXPORT_UNSUPPORTED' || written.code === 'MATL_LAW_PARAMS_INVALID')
            items.push(item(written.code, 'error', [id], `${written.message} (target ${params.target})`, written.remediation));
        } else {
          for (const warning of written.warnings)
            items.push(item(warning.code, 'warning', [id], `${warning.message} (target ${params.target})`));
        }
      }
      if (
        material.defaultConstitutiveSet !== undefined &&
        !(material.constitutiveSets ?? []).some((set) => set.id === material.defaultConstitutiveSet)
      )
        items.push(
          item(
            'MATL_MODEL_NOT_FOUND',
            'error',
            [`${name}/${material.defaultConstitutiveSet}`],
            'the default constitutive set does not exist',
            'define_constitutive_set with makeDefault',
          ),
        );
    }
    const status = items.some((i) => i.severity === 'error') ? 'fail' : items.some((i) => i.severity === 'warning') ? 'warn' : 'pass';
    const counted = items.filter((i) => i.severity !== 'info');
    return report(
      doc,
      `check_material_models: ${status} — ${counted.length} finding(s)${counted.length > 0 ? ` (${[...new Set(counted.map((i) => i.code))].join(', ')})` : ''}, ${unverified.length} unverified model(s), ${
        Object.keys(stability).length
      } stability report(s).`,
      { status, items, stability, unverified, defaults: [], notes },
    );
  },
});
