/**
 * Minimum wall thickness per manufacturing process (PHY-21 TECHNICAL_SPEC 5.2 step 7). Vendor guidance, not standards: every row is
 * grade B and carries its source; a threshold taken from this table is reported with `defaulted: true`.
 */

export const PROCESS_IDS = [
  'cnc_metal',
  'injection_abs',
  'injection_nylon',
  'injection_pc',
  'injection_pp',
  'dmls_aluminium',
  'sls',
  'mjf',
  'sla',
  'sand_cast_al',
  'sand_cast_steel',
] as const;

export type ProcessId = (typeof PROCESS_IDS)[number];

export interface ProcessRule {
  /** Minimum wall in millimetres. */
  readonly minWallMm: number;
  /** Where the number comes from. */
  readonly source: string;
  readonly grade: 'A' | 'B' | 'C';
}

const PROTOLABS_INJECTION = 'Protolabs injection moulding design guide (range low) [B-R12]';
const PROTOLABS_ADDITIVE = 'Protolabs 3D printing design guide (range low) [B-R15]';
const SAND_CASTING = 'Engineers Edge sand casting design guide [B-R16]';

export const PROCESS_RULES: Readonly<Record<ProcessId, ProcessRule>> = {
  cnc_metal: { minWallMm: 0.794, source: 'Xometry CNC thin walls guide [B-R14]', grade: 'B' },
  injection_abs: { minWallMm: 1.143, source: PROTOLABS_INJECTION, grade: 'B' },
  injection_nylon: { minWallMm: 0.762, source: PROTOLABS_INJECTION, grade: 'B' },
  injection_pc: { minWallMm: 1.016, source: PROTOLABS_INJECTION, grade: 'B' },
  injection_pp: { minWallMm: 0.889, source: PROTOLABS_INJECTION, grade: 'B' },
  dmls_aluminium: { minWallMm: 0.762, source: PROTOLABS_ADDITIVE, grade: 'B' },
  sls: { minWallMm: 0.762, source: PROTOLABS_ADDITIVE, grade: 'B' },
  mjf: { minWallMm: 0.508, source: PROTOLABS_ADDITIVE, grade: 'B' },
  sla: { minWallMm: 0.4064, source: PROTOLABS_ADDITIVE, grade: 'B' },
  sand_cast_al: { minWallMm: 2.54, source: `${SAND_CASTING} (0.10 in)`, grade: 'B' },
  sand_cast_steel: { minWallMm: 3.3, source: `${SAND_CASTING} (0.13 in)`, grade: 'B' },
};
