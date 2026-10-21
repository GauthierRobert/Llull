/** compare_to_expected: judge one measured value against one `expected_results.json` case (PHY-00 §5.3). */

import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { commandError, rejection, report } from '@core/commands/noop';
import type { JsonValue } from './expected';
import { judgeCase } from './judge';

const measuredValue = z.union([z.number(), z.string(), z.boolean(), z.array(z.unknown()), z.record(z.string(), z.unknown())]);

/**
 * @affects nothing — read-only; data { verdict, code?, grade, relError?, absError?, convertedValue?, unit? }
 * @invariant grade A -> pass / fail, B -> pass / warn, C / TBD -> skip; numbers by tolerance, strings / booleans exactly, lists and
 *   records leaf-wise; units converted before comparing
 * @failure malformed case -> VNV_EXPECTED_INVALID rejection (document unchanged)
 */
export const compareToExpected = defineCommand({
  name: 'compare_to_expected',
  annotations: { readOnly: true },
  description:
    'Judge one measured value against one validation case of a physics pack (the `expected_results.json` schema: id, quantity, value, ' +
    'unit, tolerance { rel?, abs?, exact? }, source, grade, proves). Converts the measured unit to the case unit (e.g. Pa -> MPa, ' +
    'degF -> degC), applies the tolerance to every numeric leaf (lists and records leaf-wise; strings / booleans exactly; a `value: null` ' +
    'case is judged on its `expected` contract) and returns the verdict: grade A pass / fail (VNV_BENCHMARK_FAILED), grade B pass / ' +
    'warn (VNV_BENCHMARK_UNCONFIRMED), grade C or TBD skip (VNV_EXPECTED_TBD); error on VNV_UNIT_MISMATCH or VNV_RESULT_MISSING ' +
    '(measured null). Read-only.',
  params: z.object({
    expected: z.record(z.string(), z.unknown()).describe("One case object exactly as it appears in a pack's expected_results.json."),
    measured: z
      .object({
        value: measuredValue.describe('Measured value: a number, or a code string / boolean / list / record matching the case value.'),
        unit: z.string().describe("Unit of the measured value, e.g. 'MPa', 'degC', '1', or the case's tag ('-', 'code')."),
      })
      .nullable()
      .describe('The measured result, or null when the run produced none (verdict error VNV_RESULT_MISSING).'),
  }),
  run: (doc, params): CommandResult => {
    const measured = params.measured === null ? null : { value: params.measured.value as JsonValue, unit: params.measured.unit };
    const judgement = judgeCase(params.expected, measured);
    if (judgement.code === 'VNV_EXPECTED_INVALID') {
      return rejection(
        doc,
        `compare_to_expected: VNV_EXPECTED_INVALID — ${judgement.message}; no-op.`,
        commandError(
          'VNV_EXPECTED_INVALID',
          'Fix the pack file so the case follows docs/physics/README.md §6.3.',
          [],
          [judgement.path ?? 'expected'],
        ),
      );
    }
    const caseId = typeof params.expected['id'] === 'string' ? params.expected['id'] : 'case';
    return report(
      doc,
      `compare_to_expected ${caseId}: ${judgement.verdict}${judgement.code !== undefined ? ` (${judgement.code})` : ''}. ${judgement.message}.`,
      judgement,
    );
  },
});
