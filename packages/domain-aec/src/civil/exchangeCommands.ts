/**
 * Civil exchange (LandXML, DXF) commands.
 * @layer domain-aec/civil
 */

import type { CommandDefinition, CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { noop } from '@core/commands/noop';
import { fileSlug, getBuilding } from '../model';
import { getCivil } from './model';
import { buildLandXml } from './landxml';
import { buildCivilDxf } from './civilDxf';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * @command export_landxml
 * @pure read-only
 * @affects none; data = { text, fileName, counts }
 * @failure empty civil model -> no data
 */
export const exportLandxml = defineCommand({
  name: 'export_landxml',
  description:
    'Export the civil model as LandXML 1.2 (Civil 3D, BricsCAD, 12d, Trimble Business Center…): ' +
    'survey point groups (CgPoints), TIN surfaces (points + faces), alignments and the storm pipe ' +
    'network (structures + pipes). Coordinates are "northing easting elevation" in metres. ' +
    'data.text holds the file, data.fileName its name.',
  annotations: { readOnly: true, idempotent: true },
  params: z.object({
    date: z
      .string()
      .regex(ISO_DATE)
      .optional()
      .describe('Header date yyyy-mm-dd. Default: the project date, else 1970-01-01.'),
  }),
  run: (doc, { date }): CommandResult => {
    if (getCivil(doc).order.length === 0) {
      return noop(doc, 'export_landxml: nothing to export (no civil objects).');
    }
    const project = getBuilding(doc).project;
    const projectDate = ISO_DATE.test(project.date) ? project.date : '1970-01-01';
    const projectName = project.name.trim() === '' ? 'Site' : project.name;
    const { text, counts } = buildLandXml(doc, { projectName, date: date ?? projectDate });
    const fileName = `${fileSlug(project.name, 'site')}.xml`;
    return {
      document: doc,
      summary:
        `LandXML ${fileName}: ${counts.cgPoints} CgPoints, ${counts.surfaces} surface(s) with ` +
        `${counts.faces} faces, ${counts.structures} structure(s), ${counts.pipes} pipe(s).`,
      affected: [],
      data: { text, fileName, counts },
    };
  },
});

/**
 * @command export_civil_dxf
 * @pure read-only
 * @affects none; data = { text, fileName, entityCount, layers }
 * @failure no civil entity -> no data
 */
export const exportCivilDxf = defineCommand({
  name: 'export_civil_dxf',
  description:
    'Export every civil-generated entity as DXF (AutoCAD R12) on its C-* layer: survey POINTs, ' +
    'contours and linework as POLYLINE / LINE at their elevation, labels as TEXT and the TIN, ' +
    'platforms, corridors and drainage meshes as 3DFACE triangles. data.text holds the file.',
  annotations: { readOnly: true, idempotent: true },
  params: z.object({}),
  run: (doc): CommandResult => {
    const result = buildCivilDxf(doc);
    if (result.entityCount === 0) {
      return noop(doc, 'export_civil_dxf: nothing to export (no civil entities).');
    }
    const fileName = `${fileSlug(getBuilding(doc).project.name, 'site')}_civil.dxf`;
    return {
      document: doc,
      summary: `DXF ${fileName}: ${result.entityCount} entities on layers ${result.layers.join(', ')}.`,
      affected: [],
      data: { text: result.text, fileName, entityCount: result.entityCount, layers: result.layers },
    };
  },
});

export const civilExchangeCommands = [exportLandxml, exportCivilDxf] as ReadonlyArray<
  CommandDefinition<unknown>
>;
