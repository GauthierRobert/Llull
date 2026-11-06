/**
 * Piping code rules as data (07 PST TR-PST-06 / 07, §5.6 / §5.7): one row per rule with clause, formula text, sources and grade, and one
 * rule set per code edition. Rows are transcribed from `docs/plant/07-pipe-stress-flexibility/validation/data/{code_rules_b313,sif_flexibility}.json`
 * (facts as quoted by the secondary sources named per row; the codes themselves are paywalled). Only grade A rows are validation thresholds.
 */

export type RuleGrade = 'A' | 'B' | 'C';

export interface RuleRow {
  readonly id: string;
  readonly clause: string;
  readonly formula: string;
  readonly sources: readonly string[];
  readonly grade: RuleGrade;
}

export const RULE_SET_IDS = [
  'B31.3-2016',
  'B31.3-2018',
  'B31.3-2020',
  'B31.3-2022',
  'B31.3-2024',
  'B31.1-2016',
  'B31.1-2018',
  'B31.1-2020',
  'B31.1-2022',
] as const;

export type RuleSetId = (typeof RULE_SET_IDS)[number];

export interface RuleSet {
  readonly id: RuleSetId;
  readonly code: 'B31.3' | 'B31.1';
  readonly edition: number;
  /** `appendix-d`: SIF formulas of the code appendix; `b31j`: the edition requires ASME B31J (tables not public, import-only). */
  readonly sifBasis: 'appendix-d' | 'b31j';
  /** Cycle-count form of the stress range reduction factor: `n-0.2` is 6 N^-0.2, `n-1/3` is 20 N^(-1/3). */
  readonly fForm: 'n-0.2' | 'n-1/3';
  /** Upper cap fm when the material is ferrous, SMTS <= 517 MPa and metal temperature <= 371 degC; 1.0 otherwise. */
  readonly fCapLowStrength: number;
  /** Lower bound of f. */
  readonly fFloor: number;
  /** Occasional-load allowance as a multiple of S_h (B31.3 1.33; B31.1 1.15 or 1.2 by event duration). */
  readonly occasionalFactors: Readonly<Record<'default' | 'upTo10Percent' | 'upTo1Percent', number>>;
}

const b313 = (edition: number, id: RuleSetId): RuleSet => ({
  id,
  code: 'B31.3',
  edition,
  sifBasis: edition >= 2020 ? 'b31j' : 'appendix-d',
  fForm: edition >= 2022 ? 'n-1/3' : 'n-0.2',
  fCapLowStrength: 1.2,
  fFloor: 0.15,
  occasionalFactors: { default: 1.33, upTo10Percent: 1.33, upTo1Percent: 1.33 },
});

const b311 = (edition: number, id: RuleSetId): RuleSet => ({
  id,
  code: 'B31.1',
  edition,
  sifBasis: edition >= 2020 ? 'b31j' : 'appendix-d',
  fForm: 'n-0.2',
  fCapLowStrength: 1,
  fFloor: 0.15,
  occasionalFactors: { default: 1.15, upTo10Percent: 1.15, upTo1Percent: 1.2 },
});

export const RULE_SETS: readonly RuleSet[] = [
  b313(2016, 'B31.3-2016'),
  b313(2018, 'B31.3-2018'),
  b313(2020, 'B31.3-2020'),
  b313(2022, 'B31.3-2022'),
  b313(2024, 'B31.3-2024'),
  b311(2016, 'B31.1-2016'),
  b311(2018, 'B31.1-2018'),
  b311(2020, 'B31.1-2020'),
  b311(2022, 'B31.1-2022'),
];

export const ruleSetOf = (id: RuleSetId): RuleSet => RULE_SETS.find((set) => set.id === id) ?? (RULE_SETS[0] as RuleSet);

export const RULE_ROWS: Readonly<Record<string, RuleRow>> = {
  'B313-SA-1A': {
    id: 'B313-SA-1A',
    clause: 'B31.3 302.3.5(d) eq. (1a)',
    formula: 'SA = f (1.25 Sc + 0.25 Sh)',
    sources: ['S10', 'S11', 'S3 (B31.1 form in psi/codes/b311.py)'],
    grade: 'A',
  },
  'B313-SA-1B': {
    id: 'B313-SA-1B',
    clause: 'B31.3 302.3.5(d) eq. (1b), when Sh > SL',
    formula: 'SA = f [1.25 (Sc + Sh) - SL]',
    sources: ['S10', 'S11 (structure)', "S3 (B31.1 'liberal' form f(1.25Sc + 0.25Sh + (Sh - SL)))"],
    grade: 'A',
  },
  'B313-F-PRE2022': {
    id: 'B313-F-PRE2022',
    clause: 'B31.3 302.3.5(d) eq. (1c), editions up to 2020',
    formula:
      'f = 6.0 N^-0.2 <= fm; fm = 1.2 for ferrous materials with SMTS <= 517 MPa and metal temperature <= 371 degC, else 1.0; f >= 0.15',
    sources: ['S12 (Paulin)', 'S13 (Vibrationdata)', 'S10'],
    grade: 'A',
  },
  'B313-F-2022': {
    id: 'B313-F-2022',
    clause: 'B31.3-2022 302.3.5(d)',
    formula: 'f = 20 N^(-1/3) (slope 3:1 instead of 5:1), same fm caps and floor',
    sources: ['S12', 'S13', 'S14 (Becht summary, constant not shown)'],
    grade: 'B',
  },
  'B313-OCC': {
    id: 'B313-OCC',
    clause: 'B31.3 302.3.6(a)',
    formula: 'S_L(sustained) + S_L(occasional) <= 1.33 Sh',
    sources: ['S11', 'S15'],
    grade: 'B',
  },
  'B311-F': {
    id: 'B311-F',
    clause: 'B31.1 102.3.2(B) stress range reduction factor',
    formula: 'f = 6 N^-0.2, 0.15 <= f <= 1.0 (no 1.2 cap)',
    sources: ['S3 (psi/codes/b311.py)', 'S17'],
    grade: 'B',
  },
  'B311-OCC': {
    id: 'B311-OCC',
    clause: 'B31.1 104.8.2',
    formula: 'occasional allowance k Sh, k = 1.15 (events <= 10 % of any 24 h) or 1.2 (<= 1 %)',
    sources: ['S3 b311.py k_from_hours (1.2 / 1.15)'],
    grade: 'B',
  },
  'B311-EXP': {
    id: 'B311-EXP',
    clause: 'B31.1 104.8.3',
    formula: 'SE = i M_C / Z <= SA + f (Sh - SL); single SIF for in- and out-of-plane',
    sources: ['S3', 'S17'],
    grade: 'B',
  },
  'SIF-BEND': {
    id: 'SIF-BEND',
    clause: 'B31.3 up to 2018 App. D; B31.1 App. D (bend or welding elbow)',
    formula: 'h = T R1 / r2^2; k = 1.65 / h (>= 1); ii = 0.9 / h^(2/3) (>= 1); io = 0.75 / h^(2/3) (>= 1)',
    sources: ['S5 (whatispiping.com)', 'S6 (projectmaterials.com)', 'S3 (psi/codes/b311.py)'],
    grade: 'A',
  },
  'SIF-TEE-UNREINFORCED': {
    id: 'SIF-TEE-UNREINFORCED',
    clause: 'B31.3 up to 2018 App. D (unreinforced fabricated tee)',
    formula: 'h = T / r2; io = 0.9 / h^(2/3) (>= 1); ii = 0.75 io + 0.25 (>= 1)',
    sources: ['S3 (psi test_sifs.py)', 'S5'],
    grade: 'B',
  },
  'SIF-TEE-WELDING': {
    id: 'SIF-TEE-WELDING',
    clause: 'B31.3 up to 2018 App. D (welding tee, ASME B16.9)',
    formula: 'h = 3.1 T / r2; io = 0.9 / h^(2/3) (>= 1); ii = 0.75 io + 0.25 (>= 1)',
    sources: ['S3 (psi test_sifs.py)', 'S5'],
    grade: 'B',
  },
  'SIF-TEE-REINFORCED': {
    id: 'SIF-TEE-REINFORCED',
    clause: 'B31.3 up to 2018 App. D (reinforced fabricated tee, pad or saddle)',
    formula: 'h = (T + tr/2)^2.5 / (T^1.5 r2); io = 0.9 / h^(2/3) (>= 1); ii = 0.75 io + 0.25 (>= 1)',
    sources: ['S3 (psi test_sifs.py)', 'S5'],
    grade: 'B',
  },
  'SIF-BRANCH-WELDOLET': {
    id: 'SIF-BRANCH-WELDOLET',
    clause: 'B31.3 up to 2018 App. D (branch welded-on fitting)',
    formula: 'h = 3.3 T / r2; io = 0.9 / h^(2/3) (>= 1); ii = 0.75 io + 0.25 (>= 1)',
    sources: ['S3 (psi test_sifs.py)', 'S5'],
    grade: 'B',
  },
  'SIF-BUTT-WELD': {
    id: 'SIF-BUTT-WELD',
    clause: 'B31.3 / B31.1 App. D (girth butt weld, nominal thickness)',
    formula: 'i = 1.0',
    sources: ['07 TECHNICAL_SPEC 5.6'],
    grade: 'B',
  },
  'SPRING-VARIABILITY': {
    id: 'SPRING-VARIABILITY',
    clause: 'MSS SP-58 practice (attribution not confirmed: B31.1 or SP-58)',
    formula: 'P_cold = P_hot + k d (d up positive); V = |k d| / P_hot <= 0.25 (0.15 near rotating equipment)',
    sources: ['S18'],
    grade: 'B',
  },
  'NOZZLE-NEMA-SM23': {
    id: 'NOZZLE-NEMA-SM23',
    clause: 'NEMA SM 23, one connection',
    formula: '3 F + M <= 500 De (F resultant force lbf, M resultant moment ft.lbf; De = D for D <= 8 in, (16 + D) / 3 above)',
    sources: ['S19', 'S20'],
    grade: 'B',
  },
  'NOZZLE-API617': {
    id: 'NOZZLE-API617',
    clause: 'API 617, one connection (1.85 x NEMA SM 23)',
    formula: '3 F + M <= 1.85 x 500 De',
    sources: ['S19', 'S20', 'FR-PST-14'],
    grade: 'B',
  },
  'NOZZLE-API610-F12A': {
    id: 'NOZZLE-API610-F12A',
    clause: 'API 610 Annex F F.1.2 a',
    formula:
      'each force and moment component <= 2 x the Table 5 value of the nozzle size and orientation (Table 5 values imported by the user)',
    sources: ['S21', 'S22', 'S23'],
    grade: 'B',
  },
  'NOZZLE-USER': {
    id: 'NOZZLE-USER',
    clause: 'user nozzle limits',
    formula: 'each stated component or resultant <= its stated limit (the caller owns the source)',
    sources: ['caller'],
    grade: 'C',
  },
  'SIF-B31J': {
    id: 'SIF-B31J',
    clause: 'ASME B31J (mandatory for B31.3-2020 and later)',
    formula: 'tables not public: import-only (D9)',
    sources: ['R16'],
    grade: 'C',
  },
};

export const ruleRows = (...ids: readonly string[]): readonly RuleRow[] => ids.flatMap((id) => RULE_ROWS[id] ?? []);
