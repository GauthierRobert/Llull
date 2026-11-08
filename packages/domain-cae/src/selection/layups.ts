/** Composite candidates (PHY-12 FR-SEL-15, TR-SEL-12): a 06 lamina material compared through the in-plane constants of a named layup, never as an isotropic material. */

import { z } from '@core/commands/schema';
import { execute } from '@core/commands/registry';
import { kgPerM3FromDocDensity } from '@core/geometry/resolveDensity';
import type { LaminaMaterial } from '@core/model/composites';
import type { CadDocument } from '@core/model/types';
import { issue } from './codes';
import { resolveProperty, type ResolveOptions, type Resolved } from './properties';
import type { SelIssue } from './types';

export const layupSchema = z.object({
  laminate: z
    .string()
    .describe('Stacking string of the layup, bottom to top, e.g. "[0/+-45/90]s" (06 create_lamina_material / analyze_laminate notation).'),
  lamina: z
    .string()
    .optional()
    .describe('Lamina material (create_lamina_material) the plies are made of. Omit when it is the candidate id itself.'),
});

export type Layup = z.output<typeof layupSchema>;

/** The lamina material a candidate id names (composites plugin slice), when it is not a plain document material. */
function laminaOf(doc: CadDocument, id: string): LaminaMaterial | undefined {
  return Object.hasOwn(doc.materials, id) ? undefined : laminaNamed(doc, id);
}

function laminaNamed(doc: CadDocument, id: string): LaminaMaterial | undefined {
  const materials = (doc.composites as { materials?: Record<string, LaminaMaterial> } | undefined)?.materials;
  return materials !== undefined && Object.hasOwn(materials, id) ? materials[id] : undefined;
}

/** Candidate ids that are neither a document material nor a lamina material. */
export const unknownCandidates = (doc: CadDocument, ids: readonly string[]): string[] =>
  ids.filter((id) => !Object.hasOwn(doc.materials, id) && laminaOf(doc, id) === undefined);

/** Lamina candidates without a layup: they have no scalar E and cannot be ranked. */
export const layupRequired = (doc: CadDocument, ids: readonly string[], layups: Readonly<Record<string, Layup>> | undefined): string[] =>
  ids.filter((id) => laminaOf(doc, id) !== undefined && !(layups !== undefined && Object.hasOwn(layups, id)));

interface LaminateConstants {
  readonly constantsMembrane?: { readonly Ex: number; readonly nuxy: number };
  readonly unverified?: boolean;
  readonly unverifiedMaterials?: readonly string[];
}

/** SEL_ANISOTROPIC: a laminate is compared through its in-plane stiffness only. */
export const anisotropicWarning = (candidate: string, layup: Layup): SelIssue =>
  issue(
    'SEL_ANISOTROPIC',
    'warning',
    `'${candidate}' is compared through the in-plane membrane constants of ${layup.laminate}: through-thickness stiffness and failure modes are not represented by a scalar index`,
    [candidate],
  );

const refused = (property: string, reason: string, code = 'SEL_PROPERTY_MISSING'): Resolved => ({ ok: false, code, property, reason });

/**
 * `property` of the candidate `material` with an optional layup: without one this is `resolveProperty`; with one E is the laminate's in-plane Ex
 * (`analyze_laminate`, GPa), density the lamina's, and any other property (a strength is a first-ply-failure result, not a scalar) is missing.
 * @invariant the lamina E1 is never used as an isotropic E
 */
export function resolveCandidateProperty(
  doc: CadDocument,
  material: string,
  property: string,
  unit: string,
  options: ResolveOptions,
  layup: Layup | undefined,
): Resolved {
  if (layup === undefined) return resolveProperty(doc, material, property, unit, options);
  const laminaId = layup.lamina ?? material;
  const lamina = laminaNamed(doc, laminaId);
  if (lamina === undefined) return refused(property, `no lamina material '${laminaId}' (create_lamina_material)`, 'SEL_MATERIAL_NOT_FOUND');
  const label = `layup ${layup.laminate} of lamina '${laminaId}' (${lamina.source})`;
  const weakBasis = lamina.basis === 'mean' || lamina.basis === 'unknown';
  const basisReasons = weakBasis ? [`lamina basis ${lamina.basis}`] : [];
  if (property === 'density') {
    if (lamina.density === undefined || !(lamina.density > 0))
      return refused('density', `lamina '${laminaId}' has no sourced density (06 create_lamina_material density)`);
    return {
      ok: true,
      use: {
        property,
        value: kgPerM3FromDocDensity(doc, lamina.density) / 1000,
        unit,
        basis: `laminate:${lamina.basis}`,
        propertyValueId: `lamina:${laminaId}`,
        provenance: label,
        unverified: weakBasis,
        unverifiedReasons: basisReasons,
      },
    };
  }
  if (property !== 'E')
    return refused(property, `${property} of a laminate is a first-ply-failure result (analyze_laminate), not a scalar property`);
  const analysed = execute(doc, 'analyze_laminate', { laminate: layup.laminate, material: laminaId });
  const data = analysed.data as LaminateConstants | undefined;
  const constants = data?.constantsMembrane;
  if (analysed.rejected === true || constants === undefined || !(constants.Ex > 0))
    return refused(
      'E',
      `analyze_laminate gave no in-plane Ex for ${layup.laminate}: ${analysed.summary}`,
      analysed.error?.code ?? 'SEL_PROPERTY_MISSING',
    );
  const unverifiedNames = data?.unverifiedMaterials ?? [];
  const unverified = weakBasis || data?.unverified === true;
  return {
    ok: true,
    use: {
      property: 'E',
      value: constants.Ex / 1000,
      unit,
      basis: `laminate:${lamina.basis}`,
      propertyValueId: `laminate:${layup.laminate}`,
      provenance: `${label}; membrane Ex, nuxy ${constants.nuxy}`,
      unverified,
      unverifiedReasons: [...basisReasons, ...unverifiedNames.map((name) => `lamina '${name}' data unverified`)],
    },
  };
}
