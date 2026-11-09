/**
 * Rule tables of PHY-13 (spec §3.2), transcribed from docs/physics/13-corrosion-compatibility/validation/{galvanic_anodic_index.csv,
 * anodic_index_limits.csv,compatibility_rules.json}. Every row names its source (validation/sources.md ids) and grade; the values are published
 * engineering facts (an industrial rule of thumb), no licensed text is bundled. The MIL-STD-889D matrix and the MSFC-STD-3029A rows are NOT shipped
 * (no free, reviewed source): `GALVANIC_889D_MATRIX` is empty and the check refuses with COR_889_TABLE_MISSING.
 */

import type { CorrosionEnvironment } from './types';

export interface AnodicGroup {
  readonly id: string;
  readonly description: string;
  /** Volts; null = no value (graphite: sign convention unexplained in the source). */
  readonly anodicIndexV: number | null;
  readonly status: 'secondary' | 'tbd';
  readonly source: string;
}

export const ANODIC_GROUPS: readonly AnodicGroup[] = [
  {
    id: 'gold',
    description: 'Gold (solid or plated)',
    anodicIndexV: 0.0,
    status: 'secondary',
    source: 'S5 (Misumi table) + S6 (Pietenpol list reproduction)',
  },
  {
    id: 'nickel_titanium_group',
    description: 'Nickel (solid or plated); titanium and its alloys listed in the same group',
    anodicIndexV: 0.3,
    status: 'secondary',
    source: 'S6',
  },
  {
    id: 'aluminium_wrought_2000',
    description: 'Aluminium wrought 2000 series (e.g. 2024)',
    anodicIndexV: 0.75,
    status: 'secondary',
    source: 'S6',
  },
  {
    id: 'aluminium_wrought_other',
    description: 'Aluminium wrought alloys other than 2000 series (e.g. 7075; also cast Al-Si per S6)',
    anodicIndexV: 0.9,
    status: 'secondary',
    source: 'S6',
  },
  { id: 'cadmium_plate', description: 'Cadmium plating', anodicIndexV: 0.95, status: 'secondary', source: 'S6' },
  { id: 'zinc', description: 'Zinc (wrought / plated)', anodicIndexV: 1.25, status: 'secondary', source: 'S6' },
  { id: 'magnesium', description: 'Magnesium and magnesium alloys', anodicIndexV: 1.75, status: 'secondary', source: 'S5 + S6' },
  {
    id: 'graphite',
    description: 'Graphite / carbon fibre (no index: rule COR-R-04 applies)',
    anodicIndexV: null,
    status: 'tbd',
    source: 'S5 lists +0.25 with an unexplained sign convention',
  },
];

export interface AnodicLimit {
  readonly environment: Exclude<CorrosionEnvironment, 'artificial_seawater'>;
  readonly maxDifferenceV: number;
  readonly description: string;
  readonly source: string;
}

/** Rule of thumb limits (S7 Engineers Edge + S8 Carr Lane; "not for critical applications such as aerospace flying parts"). */
export const ANODIC_LIMITS: readonly AnodicLimit[] = [
  { environment: 'harsh', maxDifferenceV: 0.15, description: 'outdoor / high humidity / salt', source: 'S7 + S8' },
  {
    environment: 'normal',
    maxDifferenceV: 0.25,
    description: 'warehouse / indoor without temperature and humidity control',
    source: 'S7 + S8',
  },
  { environment: 'controlled', maxDifferenceV: 0.5, description: 'temperature- and humidity-controlled', source: 'S7 + S8' },
];

/** Aluminium groups of the CFRP rule (COR-R-04). */
export const ALUMINIUM_GROUPS: readonly string[] = ['aluminium_wrought_2000', 'aluminium_wrought_other'];
export const CFRP_GROUP = 'graphite';

export interface Remedy {
  readonly id: string;
  readonly spec: string;
  readonly source: string;
}

/** Remedy vocabulary (COR-R-07): options with their sources, never requirements. */
export const REMEDIES: readonly Remedy[] = [
  { id: 'sealant_faying', spec: 'MIL-PRF-81733 Type IV (faying surface)', source: 'S16' },
  { id: 'sealant_wet_install', spec: 'MIL-PRF-81733 Type II (extrusion) / wet installation of fasteners', source: 'S16' },
  { id: 'primer', spec: 'MIL-PRF-23377 epoxy primer', source: 'S17' },
  { id: 'conversion_coating', spec: 'MIL-DTL-81706', source: 'S17' },
  { id: 'glass_isolation_ply', spec: 'company practice', source: 'S10' },
  { id: 'isolating_washer_or_tape', spec: 'company practice', source: 'S9' },
];

export interface RuleRow {
  readonly id: string;
  readonly name: string;
  readonly method: string;
  readonly grade: 'A' | 'B' | 'C';
  readonly status: string;
  readonly source: string;
  readonly scopeLimit?: string;
}

export const RULES: readonly RuleRow[] = [
  {
    id: 'COR-R-01',
    name: 'MIL-STD-889D galvanic corrosion rate matrix',
    method:
      'Anodic-member corrosion rate (mil/year) of a 1:1 area couple under artificial seawater; rows = anodic member, columns = cathodic member; compatible below 0.009 mil/yr.',
    grade: 'B',
    status: 'structure only: the matrix is not shipped (COR_889_TABLE_MISSING)',
    source: 'S1, S2, S3',
    scopeLimit: 'The table shall not be used to indicate the level of risk of a couple nor the level of protection required (S2, S3).',
  },
  {
    id: 'COR-R-02',
    name: 'Anodic index difference (non-889 screening)',
    method: '|AI(anode) - AI(cathode)| <= limit(environment); the member with the larger index is the anode; a tie is compatible.',
    grade: 'B',
    status: 'limits verified (A), indices secondary (B)',
    source: 'S5, S6, S7, S8',
    scopeLimit: 'Industrial rule of thumb, NOT MIL-STD-889; not for critical applications such as aerospace flying parts (S8).',
  },
  {
    id: 'COR-R-03',
    name: 'Small anode / large cathode',
    method: 'Report Aa/Ac (anode surface area / cathode surface area); warn when the anode is the smaller member (Aa/Ac < 1).',
    grade: 'B',
    status: 'directional only: no numeric limit found',
    source: 'S9, S2',
  },
  {
    id: 'COR-R-04',
    name: 'Carbon fibre composite in contact with aluminium',
    method: 'CFRP (galvanic group graphite) is noble to aluminium: direct contact fails unless an isolation is declared.',
    grade: 'B',
    status: 'secondary',
    source: 'S10',
  },
  {
    id: 'COR-R-07',
    name: 'Remedy vocabulary',
    method: 'Isolation methods offered as options with their sources (declare_isolation); selecting one is a design decision.',
    grade: 'B',
    status: 'vocabulary',
    source: 'S9, S10, S16, S17',
  },
];

/** MIL-STD-889D cells (anode|cathode -> mil/yr): intentionally empty until transcribed from the standard and reviewed. */
export const GALVANIC_889D_MATRIX: Readonly<Record<string, number>> = {};

export const groupOf = (id: string): AnodicGroup | undefined => ANODIC_GROUPS.find((group) => group.id === id);
export const limitOf = (environment: string): AnodicLimit | undefined => ANODIC_LIMITS.find((limit) => limit.environment === environment);
