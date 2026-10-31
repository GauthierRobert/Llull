import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { refuseIso } from '../codes';
import type { FabricationRules, Quantity, SpoolLimits } from '../model';
import { getFabrication, withFabrication } from '../state';

const PREFIX = /^[A-Za-z0-9_-]{1,8}$/;

/**
 * @affects plant.fabrication.rules (merged: only the given fields change)
 * @invariant every number carries the `source` it came from; nothing is defaulted; rules are document-wide
 * @failure no rule given, or a prefix that is not 1-8 letters / digits / - / _ -> ISO_PARAM_INVALID; the document is unchanged
 */
export const setFabricationRules = defineCommand({
  name: 'set_fabrication_rules',
  description:
    'Store the fabrication rules of the document with the source they come from (company standard, shop, project spec): weld gap and field-fit allowance used by cut_list, the minimum cut piece, ' +
    'the spool shipping limits used by split_spools / spool_list (envelope length x width x height, weight, pipe pieces), and the weld / spool name prefixes. Only the given fields change; the others keep their value. ' +
    'No value is assumed anywhere in llull: cut_list refuses (ISO_GAP_UNDEFINED) until a gap is given as a param or stored here. The three envelope sizes are compared with the spool envelope after sorting both ' +
    'largest first (the spool may be turned on the truck); a size you omit is unlimited. Prefixes: weldPrefixFabrication for shop welds and weldPrefixErection for site and field-fit welds (PCF WELD-PREFIX-*; default "W"), ' +
    'spoolPrefix replaces the line number in spool names (<prefix>-SP01). Returns data = { rules }. Refusal: ISO_PARAM_INVALID when nothing is given.',
  params: z.object({
    source: z
      .string()
      .trim()
      .min(1)
      .describe('Where the numbers come from, e.g. "ACME shop standard rev C" (required, stored with each value).'),
    weldGapMm: z
      .number()
      .min(0)
      .optional()
      .describe('Weld gap between two welded pipe ends, mm (cut length = length - gap / 2 per welded end).'),
    fieldFitAllowanceMm: z.number().min(0).optional().describe('Extra length left on each cut that ends at a field-fit weld, mm.'),
    minCutPieceMm: z
      .number()
      .min(0)
      .optional()
      .describe('Shortest acceptable cut piece, mm; also the shortest piece a field weld may leave.'),
    maxSpoolLengthMm: z.number().positive().optional().describe('Spool envelope: largest dimension allowed, mm.'),
    maxSpoolWidthMm: z.number().positive().optional().describe('Spool envelope: second dimension allowed, mm.'),
    maxSpoolHeightMm: z.number().positive().optional().describe('Spool envelope: third dimension allowed, mm.'),
    maxSpoolWeightKg: z.number().positive().optional().describe('Largest spool weight, kg (sum of the weights the components carry).'),
    maxSpoolPieces: z.number().int().positive().optional().describe('Largest number of pipe pieces in one spool.'),
    weldPrefixFabrication: z.string().optional().describe('Prefix of shop weld numbers (1-8 letters, digits, - or _). Default W.'),
    weldPrefixErection: z
      .string()
      .optional()
      .describe('Prefix of site and field-fit weld numbers (1-8 letters, digits, - or _). Default W.'),
    spoolPrefix: z.string().optional().describe('Prefix of spool names instead of the line number (1-8 letters, digits, - or _).'),
  }),
  run: (doc, params): CommandResult => {
    const fabrication = getFabrication(doc);
    const old: FabricationRules = fabrication.rules ?? {};
    const quantity = (value: number | undefined, previous: Quantity | undefined): Quantity | undefined =>
      value === undefined ? previous : { value, source: params.source };
    const limitFields = [
      params.maxSpoolLengthMm,
      params.maxSpoolWidthMm,
      params.maxSpoolHeightMm,
      params.maxSpoolWeightKg,
      params.maxSpoolPieces,
    ];
    const prefixes = [params.weldPrefixFabrication, params.weldPrefixErection, params.spoolPrefix];
    const badPrefix = prefixes.find((prefix) => prefix !== undefined && !PREFIX.test(prefix));
    const given = [params.weldGapMm, params.fieldFitAllowanceMm, params.minCutPieceMm, ...limitFields, ...prefixes].some(
      (value) => value !== undefined,
    );
    if (!given || badPrefix !== undefined)
      return refuseIso(
        doc,
        'set_fabrication_rules',
        'ISO_PARAM_INVALID',
        badPrefix === undefined ? 'no rule given' : `prefix "${badPrefix}" must be 1-8 letters, digits, - or _`,
        [],
        badPrefix === undefined ? ['weldGapMm'] : ['weldPrefixFabrication', 'weldPrefixErection', 'spoolPrefix'],
      );
    const previousLimits = old.maxSpool;
    const maxSpool: SpoolLimits | undefined = limitFields.some((value) => value !== undefined)
      ? {
          ...previousLimits,
          ...(params.maxSpoolLengthMm === undefined ? {} : { lengthMm: params.maxSpoolLengthMm }),
          ...(params.maxSpoolWidthMm === undefined ? {} : { widthMm: params.maxSpoolWidthMm }),
          ...(params.maxSpoolHeightMm === undefined ? {} : { heightMm: params.maxSpoolHeightMm }),
          ...(params.maxSpoolWeightKg === undefined ? {} : { weightKg: params.maxSpoolWeightKg }),
          ...(params.maxSpoolPieces === undefined ? {} : { pieces: params.maxSpoolPieces }),
          source: params.source,
        }
      : previousLimits;
    const weldGapMm = quantity(params.weldGapMm, old.weldGapMm);
    const fieldFitAllowanceMm = quantity(params.fieldFitAllowanceMm, old.fieldFitAllowanceMm);
    const minCutPieceMm = quantity(params.minCutPieceMm, old.minCutPieceMm);
    const weldPrefix = {
      ...old.weldPrefix,
      ...(params.weldPrefixFabrication === undefined ? {} : { fabrication: params.weldPrefixFabrication }),
      ...(params.weldPrefixErection === undefined ? {} : { erection: params.weldPrefixErection }),
    };
    const spoolPrefix = params.spoolPrefix ?? old.spoolPrefix;
    const rules: FabricationRules = {
      ...(weldGapMm === undefined ? {} : { weldGapMm }),
      ...(fieldFitAllowanceMm === undefined ? {} : { fieldFitAllowanceMm }),
      ...(minCutPieceMm === undefined ? {} : { minCutPieceMm }),
      ...(maxSpool === undefined ? {} : { maxSpool }),
      ...(Object.keys(weldPrefix).length === 0 ? {} : { weldPrefix }),
      ...(spoolPrefix === undefined ? {} : { spoolPrefix }),
    };
    return {
      document: withFabrication(doc, { ...fabrication, rules }),
      summary: `set_fabrication_rules: stored ${Object.keys(rules).join(', ')} (source "${params.source}")`,
      affected: ['plant.fabrication.rules'],
      data: { rules },
    };
  },
});
