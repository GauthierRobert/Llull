/** check_materials (08 MAT, AF-20): read-only readiness check of the materials in use before a result is handed to the owner. */

import { resolveDensity } from '../../geometry/resolveDensity';
import { isControlledMarking } from '../../model/materialLibrary';
import { modelUnverifiedReasons } from '../../model/propertyModelEval';
import type { CadDocument } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { report } from '../noop';
import { exportGate } from './exportGate';
import { markingText } from './marking';
import { materialsInUse } from './materialsInUse';
import { preferredConflicts } from './propertyKey';

export interface MaterialCheckItem {
  readonly code: string;
  readonly severity: 'error' | 'warning' | 'info';
  readonly ids: readonly string[];
  readonly message: string;
  readonly remediation: string;
}

const item = (
  code: string,
  severity: MaterialCheckItem['severity'],
  ids: readonly string[],
  message: string,
  remediation: string,
): MaterialCheckItem => ({ code, severity, ids, message, remediation });

function valueItems(doc: CadDocument, name: string, users: readonly string[]): MaterialCheckItem[] {
  const material = doc.materials[name];
  if (material === undefined)
    return [
      item('MAT_RECORD_NOT_FOUND', 'error', users, `entities use material '${name}' that does not exist`, 'assign an existing material'),
    ];
  if (material.record?.unresolved !== undefined) return [];
  const items: MaterialCheckItem[] = [];
  const density = resolveDensity(doc, name);
  if (density?.available === true && density.modelId === undefined)
    items.push(
      item(
        'MAT_VALUE_UNVERIFIED',
        'warning',
        [name],
        `density of '${name}' is a bare number (${density.unverifiedReasons.join(', ')}): no basis, no source`,
        'set_material_property with a basis and a source',
      ),
    );
  const unverified = (material.propertyModels ?? []).filter((model) => modelUnverifiedReasons(model).length > 0);
  if (unverified.length > 0)
    items.push(
      item(
        'MAT_VALUE_UNVERIFIED',
        'warning',
        unverified.map((model) => `${name}/${model.id}`),
        `'${name}' uses unverified value(s): ${unverified.map((model) => `${model.id} (${modelUnverifiedReasons(model).join(', ')})`).join('; ')}`,
        'replace with a verified, sourced value (basis A, B, S or company)',
      ),
    );
  return items;
}

/**
 * @affects nothing — read-only; data { status, items[{ code, severity, ids, message, remediation }] }
 * @invariant status = fail on any error item, warn on any warning, else pass
 */
export const checkMaterials = defineCommand({
  name: 'check_materials',
  annotations: { readOnly: true },
  description:
    'Readiness check of the materials in use (read-only): unverified values the mass or allowables rest on (MAT_VALUE_UNVERIFIED: typical, ' +
    'supplier_unstated, unspecified basis or legacy density), records from superseded sources (MAT_SOURCE_SUPERSEDED), private-library records ' +
    'without values on this machine (MAT_LIBRARY_UNRESOLVED), two preferred values on one key (MAT_PREFERRED_CONFLICT), export-controlled records ' +
    '(MAT_EXPORT_CONTROLLED: ITAR / EAR content is refused by every export), and fastener parts built from placeholder geometry ' +
    '(FAST_GEOMETRY_REPRESENTATIVE). Each item has code, severity, ids, message and remediation. Run it before handing a weight or margin to the owner.',
  params: z.object({
    entityIds: z.array(z.string()).optional().describe('Only the materials of these entities (default: every entity of the document).'),
  }),
  run: (doc, { entityIds }): CommandResult => {
    const items: MaterialCheckItem[] = [];
    const users = materialsInUse(doc, entityIds);
    for (const id of entityIds ?? [])
      if (doc.entities[id] === undefined)
        items.push(item('MAT_ENTITY_NOT_FOUND', 'error', [id], `no entity '${id}'`, 'use describe_scene to list the entity ids'));
    for (const [name, entities] of [...users].sort(([a], [b]) => (a < b ? -1 : 1))) {
      items.push(...valueItems(doc, name, entities));
      const record = doc.materials[name]?.record;
      if (record?.superseded !== undefined)
        items.push(
          item(
            'MAT_SOURCE_SUPERSEDED',
            'warning',
            [name],
            `'${name}' comes from a superseded source (${record.superseded.note}); use ${record.superseded.by} for certification`,
            'use the current MMPDS value (licensed library)',
          ),
        );
    }
    const unresolved = new Map<string, { names: string[]; reason: string }>();
    for (const [name, material] of Object.entries(doc.materials)) {
      const pending = material.record?.unresolved;
      if (pending === undefined) continue;
      const libraryId = material.record?.libraryRef?.libraryId ?? '?';
      const group = unresolved.get(libraryId) ?? { names: [], reason: pending.reason };
      unresolved.set(libraryId, { names: [...group.names, name], reason: group.reason });
    }
    for (const [libraryId, { names, reason }] of unresolved)
      items.push(
        item(
          'MAT_LIBRARY_UNRESOLVED',
          'warning',
          [libraryId, ...names],
          `library '${libraryId}' has no values on this machine (${reason}); mass and allowables answer available: false`,
          'register the library file (register_material_library), then run resolve_material_libraries',
        ),
      );
    for (const [name, material] of Object.entries(doc.materials)) {
      for (const group of preferredConflicts(material.propertyModels ?? []))
        items.push(
          item(
            'MAT_PREFERRED_CONFLICT',
            'error',
            group.map((model) => `${name}/${model.id}`),
            `${group.length} values of ${group[0]?.property ?? ''} on '${name}' are all preferred`,
            'clear preferred on all but one (set_material_property replace: true)',
          ),
        );
    }
    const gate = exportGate(doc, 'save');
    if (gate.controlled)
      items.push(
        item(
          'MAT_EXPORT_CONTROLLED',
          'warning',
          gate.ids,
          `the document uses ${markingText(gate.marking)} content (${gate.items
            .filter((i) => isControlledMarking(i.marking))
            .map((i) => `${i.kind} ${i.id}`)
            .join(', ')}): every export is refused without a human`,
          'hand over to a human (export-control officer)',
        ),
      );
    const representative = Object.values(doc.components).filter((component) => component.partRef?.representative === true);
    if (representative.length > 0)
      items.push(
        item(
          'FAST_GEOMETRY_REPRESENTATIVE',
          'warning',
          representative.map((component) => component.partRef?.partNumber ?? component.id),
          `${representative.length} standard part(s) are built from placeholder proportions and excluded from mass${doc.fasteners !== undefined ? ` (${Object.keys(doc.fasteners.stacks).length} fastener stack(s))` : ''}`,
          'import the catalogue dimensions of the part',
        ),
      );
    const status = items.some((i) => i.severity === 'error') ? 'fail' : items.some((i) => i.severity === 'warning') ? 'warn' : 'pass';
    const codes = [...new Set(items.map((i) => i.code))];
    return report(doc, `check_materials: ${status} — ${items.length} finding(s)${codes.length > 0 ? ` (${codes.join(', ')})` : ''}.`, {
      status,
      items,
    });
  },
});
