/** The `CfdGridStudy` as a zod schema: the load validation of `doc.cfd.studies` and the echoed `study` of `record_cfd_grid_study`. */

import { z } from '@core/commands/schema';

const finite = z.number();

const level = z.strictObject({
  resultsHash: z.string().min(1),
  cellM: finite.positive(),
  cells: finite.nonnegative(),
  value: finite,
  converged: z.boolean(),
});

export const studySchema = z
  .strictObject({
    caseId: z.string().min(1),
    quantity: z.enum(['cd', 'cl', 'cdAM2']),
    safetyFactor: finite.min(1),
    caseHash: z.string().min(1),
    geometryHash: z.string().min(1),
    levels: z.tuple([level, level, level]),
    status: z.enum(['monotone', 'oscillatory', 'divergent', 'converged_exactly', 'order_not_converged']),
    r21: finite,
    r32: finite,
    orderP: finite.optional(),
    extrapolated: finite.optional(),
    gci21Fine: finite.optional(),
    gci32Fine: finite.optional(),
    gciAbs: finite.optional(),
    relativeUndefined: z.literal(true).optional(),
    asymptoticRatio: finite.optional(),
    verified: z.boolean(),
  })
  .refine(({ levels: [fine, medium, coarse] }) => fine.cellM < medium.cellM && medium.cellM < coarse.cellM, {
    message: 'levels must be finest first (cell size strictly increasing)',
    path: ['levels'],
  });
