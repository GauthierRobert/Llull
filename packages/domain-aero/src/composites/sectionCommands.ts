/** create_laminate_sections and export_laminate_sections: the laminate as shell-section data for analysis (06 CMP FR-CMP-34, hand-off to 05 FEA). */

import { confirmExportControlled, defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { changed, exportRefusal, report } from '@core/commands/noop';
import type { CompositePart, CompositesModel, LaminateSection } from '@core/model/composites';
import { nextId } from '@lib/id';
import { sig } from '../shared/results';
import { refuseCmp } from './codes';
import { representativePoint, stackAt } from './sample';
import { compositesOf, findPart, withComposites, zonesOf } from './state';

/** One section per zone (the plies laid where the zone governs), or one for the whole part when it has no zones. */
function sectionsOf(model: CompositesModel, part: CompositePart): Omit<LaminateSection, 'id'>[] {
  const zones = zonesOf(model, part.id);
  const stations =
    zones.length === 0
      ? [{ name: part.name, zoneId: undefined, uv: representativePointOfPart(part) }]
      : zones.map((zone) => ({ name: zone.name, zoneId: zone.id as string | undefined, uv: representativePoint(model, part, zone) }));
  return stations.flatMap((station) => {
    const entries = stackAt(model, part, station.uv);
    if (entries.length === 0) return [];
    return [
      {
        partId: part.id,
        name: station.name,
        ...(station.zoneId === undefined ? {} : { zoneId: station.zoneId }),
        plies: entries.map((entry) => ({
          material: entry.ply.materialName,
          thickness: entry.material.plyThickness,
          angleDeg: entry.ply.orientation,
        })),
        thickness: entries[entries.length - 1]?.z1 ?? 0,
        laminateSide: part.laminateSide,
      },
    ];
  });
}

const representativePointOfPart = (part: CompositePart): [number, number] => {
  const n = part.outline.length;
  return [part.outline.reduce((sum, [x]) => sum + x, 0) / n, part.outline.reduce((sum, [, y]) => sum + y, 0) / n];
};

/**
 * @affects replaces doc.composites.sections of the part with one LaminateSection per zone (ids section-<step>.<k>)
 * @invariant a section lists the plies at a point where its zone governs, tool side first, with cured thickness (document units) and the angle from the part rosette; materials stay in doc.composites.materials
 * @failure unknown part -> CMP_REF_MISSING; no plies anywhere -> CMP_NO_PLIES
 */
export const createLaminateSections = defineCommand({
  name: 'create_laminate_sections',
  description:
    'Store the laminate of a composite part as shell sections for structural analysis: one section per zone (the stack laid where that zone ' +
    'governs; one section for the whole part when it has no zones), each with its plies from the tool side up: material name (the lamina ' +
    'record in the composites materials), cured thickness in document units, angle in degrees from the part rosette 0-degree direction, ' +
    'and the total thickness. The analysis plugin reads doc.composites.sections to write PCOMP / composite shell sections; re-run after ' +
    'changing plies or zones (earlier sections of the part are replaced). Returns the section ids. Refused when the part has no plies.',
  params: z.object({ part: z.string().describe('Part id or name.') }),
  run: (doc, { part: partRef }): CommandResult => {
    const model = compositesOf(doc);
    const part = findPart(model, partRef);
    if (part === null) return refuseCmp(doc, 'create_laminate_sections', 'CMP_REF_MISSING', `no part '${partRef}'`, [], ['params.part']);
    const built = sectionsOf(model, part);
    if (built.length === 0)
      return refuseCmp(doc, 'create_laminate_sections', 'CMP_NO_PLIES', `part "${part.name}" has no plies`, [part.id], ['params.part']);
    const kept = Object.fromEntries(Object.entries(model.sections ?? {}).filter(([, section]) => section.partId !== part.id));
    const created = built.map((section) => ({ ...section, id: nextId('section') }) as LaminateSection);
    const next = withComposites(doc, { sections: { ...kept, ...Object.fromEntries(created.map((section) => [section.id, section])) } });
    return changed(
      next,
      `create_laminate_sections: part "${part.name}": ${created.length} section(s): ${created.map((section) => `"${section.name}" ${section.plies.length} plies, ${sig(section.thickness)} ${doc.units}`).join('; ')}.`,
      created.map((section) => section.id),
    );
  },
});

/**
 * @affects nothing (read-only)
 * @invariant sections come from the stored doc.composites.sections of the part (create_laminate_sections), never recomputed; materials lists the lamina records they use
 * @failure unknown part -> CMP_REF_MISSING; no stored sections -> CMP_NO_PLIES
 */
export const exportLaminateSections = defineCommand({
  name: 'export_laminate_sections',
  annotations: { readOnly: true },
  description:
    'Export the stored laminate shell sections of a composite part (create_laminate_sections) as solver-neutral JSON: sections with plies ' +
    '(material, thickness in document units, angle in degrees) and the lamina records they use (moduli and strengths in MPa, density, ' +
    'expansion coefficients). The text is in data.files[0].content (application/json); the Nastran PCOMP / CalculiX writers belong to the analysis ' +
    'plugin. Read-only.',
  params: z.object({ part: z.string().describe('Part id or name.'), confirmExportControlled }),
  run: (doc, { part: partRef, confirmExportControlled: confirmation }, ctx): CommandResult => {
    const refused = exportRefusal(doc, 'export_laminate_sections', 'data', confirmation, ctx);
    if (refused !== null) return refused;
    const model = compositesOf(doc);
    const part = findPart(model, partRef);
    if (part === null) return refuseCmp(doc, 'export_laminate_sections', 'CMP_REF_MISSING', `no part '${partRef}'`, [], ['params.part']);
    const sections = Object.values(model.sections ?? {}).filter((section) => section.partId === part.id);
    if (sections.length === 0)
      return refuseCmp(
        doc,
        'export_laminate_sections',
        'CMP_NO_PLIES',
        `part "${part.name}" has no stored sections (create_laminate_sections first)`,
        [part.id],
        ['params.part'],
      );
    const used = [...new Set(sections.flatMap((section) => section.plies.map((ply) => ply.material)))];
    const materials = Object.fromEntries(
      used.flatMap((name) => (model.materials[name] === undefined ? [] : [[name, model.materials[name]]])),
    );
    const payload = {
      format: 'llull-laminate-sections',
      version: 1,
      lengthUnit: doc.units,
      stressUnit: 'MPa',
      angleUnit: 'deg',
      part: part.name,
      sections,
      materials,
    };
    return report(doc, `export_laminate_sections: part "${part.name}": ${sections.length} section(s), ${used.length} material(s).`, {
      part: part.id,
      sections,
      materials,
      files: [
        {
          name: `${part.name.replace(/[^A-Za-z0-9_-]/g, '_')}_sections.json`,
          mime: 'application/json',
          content: JSON.stringify(payload, null, 1),
        },
      ],
    });
  },
});
