import { confirmExportControlled, defineCommand, z } from '@core/commands/schema';
import { execute } from '@core/commands/registry';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { readStep } from '@lib/stepRead';
import { checkIds } from '../ifcRead/idsCheck';
import { parseIds } from '../ifcRead/idsParse';
import { refuse } from './params';

const MAX_IDS_CHARS = 8_000_000;

/**
 * @affects none; data = { title, schema, specifications: [{ name, status, applicable, failed, failedGlobalIds }], status, failedSpecifications }
 * @invariant read-only; the IDS and the IFC are data (no DTD, bounded patterns); linear in specifications x entities; without ifc the export of the current document is checked
 * @failure invalid IDS -> DAT_IDS_PARSE; a facet or restriction outside the supported subset -> DAT_IDS_UNSUPPORTED_FACET; ifc that is not an IFC file -> DAT_IFC_PARSE; the export refused -> its refusal; document unchanged
 */
export const checkIfcRequirements = defineCommand({
  name: 'check_ifc_requirements',
  description:
    'Check an IFC file against client requirements written as an IDS 1.0 file (buildingSMART Information Delivery Specification), read-only (document unchanged). ids is the IDS XML text ' +
    '(CLI: file=<path>). ifc is the IFC text to check; omit it to check the IFC export of the current document (export_ifc with the schema named by the first specification ' +
    'ifcVersion, IFC4X3_ADD2 by default). Supported: facets entity (name, predefinedType), attribute (GlobalId, Name, Description, ObjectType, Tag, PredefinedType, LongName), property (' +
    'propertySet, baseName, value, dataType; single-value properties of the object itself), classification (system, value) and partOf (relation, entity); values as simpleValue, xs:enumeration, ' +
    'xs:pattern (anchored; patterns that can backtrack without limit are refused) and xs:minInclusive / maxInclusive / minExclusive / maxExclusive; cardinality required / optional / prohibited. ' +
    'Not supported (refused, never passed silently): material facet, xs:length / minLength / maxLength, properties reached through a type object. A specification passes when no applicable ' +
    'entity breaks a requirement and (applicability minOccurs >= 1) at least one entity is applicable. Returns data = { title, schema, status pass | fail, failedSpecifications, ' +
    'specifications [{ name, status, applicable, failed, failedGlobalIds (at most 100), skipped? }] }. Refusals: DAT_IDS_PARSE, DAT_IDS_UNSUPPORTED_FACET, DAT_IFC_PARSE. Next: export_ifc, ifc_summary.',
  annotations: { readOnly: true, idempotent: true },
  params: z.object({
    confirmExportControlled,
    ids: z.string().describe('The IDS 1.0 document (XML text). With the CLI send file=<path>.'),
    ifc: z.string().optional().describe('The IFC text (ISO 10303-21) to check. Omit to check the IFC export of the current document.'),
  }),
  run: (doc, params, ctx): CommandResult => {
    if (params.ids.length > MAX_IDS_CHARS)
      return refuse(doc, 'check_ifc_requirements', {
        code: 'DAT_IDS_PARSE',
        message: `the IDS is larger than ${MAX_IDS_CHARS} characters`,
        paths: ['ids'],
      });
    const parsed = parseIds(params.ids);
    if (!parsed.ok) return refuse(doc, 'check_ifc_requirements', { code: parsed.code, message: parsed.message, paths: ['ids'] });
    let text = params.ifc;
    if (text === undefined) {
      const wanted = parsed.ids.specifications.find((spec) => spec.ifcVersions.length > 0)?.ifcVersions[0]?.toUpperCase();
      const schema = wanted === 'IFC4' ? 'IFC4' : 'IFC4X3_ADD2';
      const exported = execute(doc, 'export_ifc', { schema, confirmExportControlled: params.confirmExportControlled }, ctx);
      const content = (exported.data as { ifc?: unknown } | undefined)?.ifc;
      if (exported.rejected === true || typeof content !== 'string')
        return refuse(doc, 'check_ifc_requirements', {
          code: exported.error?.code ?? 'DAT_IFC_PARSE',
          message: `the IFC export of the document failed: ${exported.summary}`,
          paths: ['ifc'],
        });
      text = content;
    }
    const file = readStep(text);
    if (file.entities.size === 0 || !file.schema.toUpperCase().startsWith('IFC'))
      return refuse(doc, 'check_ifc_requirements', {
        code: 'DAT_IFC_PARSE',
        message: 'ifc is not an IFC STEP file with entities',
        paths: ['ifc'],
      });
    const specifications = checkIds(file, parsed.ids);
    const failedSpecifications = specifications.filter((spec) => spec.status === 'fail').length;
    return report(
      doc,
      `check_ifc_requirements: ${failedSpecifications === 0 ? 'pass' : 'fail'}, ${specifications.length - failedSpecifications} of ${specifications.length} specification(s) pass${
        failedSpecifications === 0
          ? ''
          : `; failing: ${specifications
              .filter((spec) => spec.status === 'fail')
              .map((spec) => `${spec.name} (${spec.failed} of ${spec.applicable})`)
              .join('; ')}`
      }.`,
      {
        title: parsed.ids.title,
        schema: file.schema,
        status: failedSpecifications === 0 ? 'pass' : 'fail',
        failedSpecifications,
        specifications,
      },
    );
  },
});
