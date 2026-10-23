/** Standard torispherical head proportions (crown radius = f x D, knuckle radius = k x D). Every row carries sources and a grade (AF-30, AF-32). */

import type { SourceGrade, TorisphericalStandard } from '../model';

interface HeadStandardRow {
  readonly id: TorisphericalStandard;
  readonly label: string;
  readonly f: number;
  readonly k: number;
  readonly sources: readonly string[];
  readonly grade: SourceGrade;
}

/** validation/data/head_geometry_references.json standardHeadProportions (fluids TANK table + Wikipedia 'Head (vessel)'). */
export const HEAD_STANDARDS: Readonly<Record<TorisphericalStandard, HeadStandardRow>> = {
  asme_fd: {
    id: 'asme_fd',
    label: 'ASME flanged and dished',
    f: 1,
    k: 0.06,
    sources: ['fluids 1.3.1 TANK docstring', "Wikipedia 'Head (vessel)'"],
    grade: 'A',
  },
  asme_80_10: { id: 'asme_80_10', label: 'ASME 80/10 F&D', f: 0.8, k: 0.1, sources: ['fluids 1.3.1 TANK docstring'], grade: 'B' },
  asme_80_6: { id: 'asme_80_6', label: 'ASME 80/6', f: 0.8, k: 0.06, sources: ['fluids 1.3.1 TANK docstring'], grade: 'B' },
  din_28011: {
    id: 'din_28011',
    label: 'DIN 28011 (Kloepper)',
    f: 1,
    k: 0.1,
    sources: ['fluids 1.3.1 TANK docstring', "Wikipedia 'Head (vessel)'"],
    grade: 'A',
  },
  din_28013: {
    id: 'din_28013',
    label: 'DIN 28013 (Korbbogen)',
    f: 0.8,
    k: 0.154,
    sources: ['fluids 1.3.1 TANK docstring', "Wikipedia 'Head (vessel)'"],
    grade: 'A',
  },
};
