import type { CheckOutcome, Criterion, GradeContext } from '../contract';
import { buildingOf, levelsByElevation } from '../oracle/geometry';
import { parseIfc, stepString } from '../oracle/ifc';
import { drawingIdentity, parseSheet } from '../oracle/svg';
import type { PlantIntent } from '../plant/intent';

/**
 * @layer tests/production/criteria
 *
 * Revision acceptance: the change is issued under the new revision, and every element of the
 * previous issue keeps its identity — id and mark (drawings, schedules, site references) and IFC
 * GlobalId (the coordination model is diffed by GlobalId).
 */

function issuedCheck(intent: PlantIntent, { document, deliverable }: GradeContext): CheckOutcome {
  const project = buildingOf(document).project;
  const problems: string[] = [];
  if (project.revision !== intent.project.revision)
    problems.push(`revision "${project.revision}", expected "${intent.project.revision}"`);
  if (project.date !== intent.project.date)
    problems.push(`date "${project.date}", expected "${intent.project.date}"`);
  const sheets = [
    ...levelsByElevation(document).map((level) => `plan:${level.id}`),
    'elevation:south',
  ];
  for (const id of sheets) {
    const printed = drawingIdentity(parseSheet(deliverable(id)));
    if (printed.revision !== intent.project.revision || printed.date !== intent.project.date) {
      problems.push(
        `${id} title block at revision "${printed.revision}" / ${printed.date}, expected ${intent.project.revision} / ${intent.project.date}`,
      );
    }
  }
  return {
    pass: problems.length === 0,
    detail:
      problems.length === 0
        ? `issued at revision ${project.revision} (${project.date}) on ${sheets.length} sheets`
        : problems.join('; '),
  };
}

function identityCheck({ document, baseline }: GradeContext): CheckOutcome {
  const before = buildingOf(baseline).elements;
  const after = buildingOf(document).elements;
  const problems: string[] = [];
  for (const [id, element] of Object.entries(before)) {
    const now = after[id];
    if (!now) problems.push(`${element.mark} (${id}) removed or replaced`);
    else if (now.mark !== element.mark)
      problems.push(`${id} renumbered ${element.mark} → ${now.mark}`);
  }
  return {
    pass: problems.length === 0,
    detail:
      problems.length === 0
        ? `${Object.keys(before).length} elements of the previous issue keep their id and mark`
        : `${problems.length} identity break(s): ${problems.slice(0, 6).join('; ')}`,
  };
}

/** Element id (IFC Tag, 8th attribute) → GlobalId, for products exported from building elements. */
function guidsByTag(ifc: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const entity of parseIfc(ifc).entities.values()) {
    const tag = stepString(entity.args[7]);
    const guid = stepString(entity.args[0]);
    if (tag !== '' && guid.length === 22) map.set(tag, guid);
  }
  return map;
}

function guidCheck({ deliverable, baselineDeliverable }: GradeContext): CheckOutcome {
  const before = guidsByTag(baselineDeliverable('ifc'));
  const after = guidsByTag(deliverable('ifc'));
  const changed = [...before].filter(([tag, guid]) => after.get(tag) !== guid).map(([tag]) => tag);
  return {
    pass: before.size > 0 && changed.length === 0,
    detail:
      changed.length === 0
        ? `${before.size} IFC products keep their GlobalId across the revision`
        : `${changed.length}/${before.size} GlobalIds changed or lost, e.g. ${changed.slice(0, 6).join(', ')}`,
  };
}

export function revisionCriteria(intent: PlantIntent, changedTags: string[]): Criterion[] {
  return [
    {
      id: 'revision-issued',
      area: 'deliverables',
      requirement: `Project, plan and elevation sheets issued at revision ${intent.project.revision} (${changedTags.join(', ')} changed).`,
      check: (ctx) => issuedCheck(intent, ctx),
    },
    {
      id: 'stable-identity',
      area: 'data-integrity',
      requirement: 'Every element of the previous issue keeps its id and mark.',
      check: identityCheck,
    },
    {
      id: 'ifc-guid-stability',
      area: 'data-integrity',
      requirement: 'Every IFC product of the previous issue keeps its GlobalId.',
      check: guidCheck,
    },
  ];
}
