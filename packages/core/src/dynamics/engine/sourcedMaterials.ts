/**
 * Materials with a cited density, offered by `assign_material` by name when the document does not define them (FR-FPR-73). A piston is
 * aluminium, not the 7850 kg/m³ default: the density of the part drives inertia, which is of the order of the gas load at rated speed.
 */

import type { CadDocument, Material } from '../../model/types';
import { toMetres } from '../../model/units';

interface SourcedMaterial {
  /** kg/m³. */
  readonly densityKgPerM3: number;
  readonly source: string;
  readonly grade: 'B';
  readonly color: string;
  readonly metalness: number;
  readonly roughness: number;
}

const SOURCED_MATERIALS: Readonly<Record<string, SourcedMaterial>> = {
  al_4032: {
    densityKgPerM3: 2680,
    source:
      'Smiths 4032 aluminium datasheet, specific gravity 2.68 [E-R32] https://www.smithshp.com/assets/pdf/aluminium/high-performance-aluminium/4032-aluminium-english.pdf',
    grade: 'B',
    color: '#b8bcc2',
    metalness: 1,
    roughness: 0.35,
  },
  steel_4340: {
    densityKgPerM3: 7850,
    source: 'AISI 4340 steel sheet, 7.85 g/cm3 [E-R31] https://quickparts.com/wp-content/uploads/2024/05/Steel-4340.pdf',
    grade: 'B',
    color: '#8a8d91',
    metalness: 1,
    roughness: 0.4,
  },
};

/** The catalogue material `name` as a document material (density converted to g per document unit³), or null when it is not catalogued. */
export function sourcedMaterial(doc: Pick<CadDocument, 'units'>, name: string): Material | null {
  const entry = Object.hasOwn(SOURCED_MATERIALS, name) ? SOURCED_MATERIALS[name] : undefined;
  if (entry === undefined) return null;
  return {
    name,
    density: entry.densityKgPerM3 * 1000 * toMetres(doc, 1) ** 3,
    densityUnit: 'kg/m^3',
    source: entry.source,
    grade: entry.grade,
    color: entry.color,
    metalness: entry.metalness,
    roughness: entry.roughness,
  };
}
