import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { report } from '@core/commands/noop';
import { isKindOf } from '../classes';
import { atLeast, checkFindings, checkStatus } from '../check';
import { resolveNode, subtreeIds } from '../hierarchy';
import { getPlantData } from '../model';
import { refuse } from './params';

/**
 * @affects none; data = { status, findings, counts, defaults }
 * @invariant status = fail if any finding fails, else warn if any warns, else pass (info findings never change it); findings ordered by rule then natural tag order
 * @failure unknown hierarchy node or class -> DAT_HIERARCHY_UNKNOWN, DAT_CLASS_UNKNOWN
 */
export const checkPlantData = defineCommand({
  name: 'check_plant_data',
  description:
    'Check the plant data and report findings, each with a stable code, severity (fail, warn, info), the object ids, the paths ("<tag>.<field>") and the one-line ' +
    'remediation. Rules: DAT_TAG_FORMAT (a tag that does not match its class format), DAT_TAG_DUPLICATE, DAT_TAG_CASE_COLLISION, DAT_REQUIRED_PROPERTY_MISSING, ' +
    'DAT_LINE_END_UNRESOLVED (a line from / to that is neither a tag nor a battery limit; the default battery-limit pattern ^(BL|TI)- is returned in data.defaults), ' +
    'DAT_LINE_SIZE_MISMATCH, DAT_TAG_MODEL_MISMATCH (the model object carries another tag), DAT_OBJECT_ORPHAN, DAT_UNCLASSIFIED_ELEMENT (equipment, pipes and ' +
    'routed lines without a plant object; only when no hierarchy / classes filter is given), DAT_OUTSIDE_HIERARCHY, DAT_VALUE_UNVERIFIED, ' +
    'DAT_RESERVED_TAG_UNMODELLED. hierarchy / classes restrict the objects checked (node code, path or id; class names with their subclasses). severity: ' +
    'report only findings at or above it (default info = all); status is always computed from all findings. Returns data = { status: pass | warn | fail, ' +
    'findings [{ code, severity, ids, paths, message, remediation }], counts { fail, warn, info }, checked (objects), defaults { batteryLimitPattern } }.',
  annotations: { readOnly: true, idempotent: true },
  params: z.object({
    hierarchy: z.string().optional().describe('Only objects at this hierarchy node or below (code, path S1/P1/U10, or id).'),
    classes: z.array(z.string()).optional().describe('Only objects of these classes and their subclasses.'),
    severity: z.enum(['info', 'warn', 'fail']).optional().describe('Minimum severity reported (default info).'),
  }),
  run: (doc, params): CommandResult => {
    const data = getPlantData(doc);
    let objects: Set<string> | undefined;
    if (params.hierarchy !== undefined) {
      const node = resolveNode(data, params.hierarchy);
      if (node === null || node === 'ambiguous')
        return refuse(doc, 'check_plant_data', {
          code: 'DAT_HIERARCHY_UNKNOWN',
          message: `no (or an ambiguous) hierarchy node "${params.hierarchy}"`,
          paths: ['hierarchy'],
        });
      const nodes = subtreeIds(data, node.id);
      objects = new Set(data.objectOrder.filter((id) => nodes.has(data.objects[id]?.hierarchyId ?? '')));
    }
    if (params.classes !== undefined) {
      for (const name of params.classes)
        if (data.classes[name] === undefined)
          return refuse(doc, 'check_plant_data', { code: 'DAT_CLASS_UNKNOWN', message: `no class "${name}"`, paths: ['classes'] });
      const byClass = data.objectOrder.filter((id) =>
        params.classes?.some((name) => isKindOf(data, data.objects[id]?.className ?? '', name)),
      );
      objects = objects === undefined ? new Set(byClass) : new Set(byClass.filter((id) => objects?.has(id)));
    }
    const all = checkFindings(doc, objects === undefined ? {} : { objects });
    const status = checkStatus(all);
    const findings = atLeast(all, params.severity ?? 'info');
    const counts = {
      fail: all.filter((finding) => finding.severity === 'fail').length,
      warn: all.filter((finding) => finding.severity === 'warn').length,
      info: all.filter((finding) => finding.severity === 'info').length,
    };
    const checked = objects?.size ?? data.objectOrder.length;
    return report(
      doc,
      `check_plant_data: ${status} - ${checked} object(s) checked, ${counts.fail} fail, ${counts.warn} warn, ${counts.info} info${
        findings.length === 0
          ? ''
          : `; ${findings
              .slice(0, 3)
              .map((finding) => `${finding.code} ${finding.paths[0] ?? finding.ids[0] ?? ''}`)
              .join(', ')}${findings.length > 3 ? ', ...' : ''}`
      }.`,
      { status, findings, counts, checked, defaults: { batteryLimitPattern: data.settings.batteryLimitPattern } },
    );
  },
});
