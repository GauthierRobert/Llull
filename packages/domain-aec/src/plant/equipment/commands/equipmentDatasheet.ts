import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { canonicalJson } from '@lib/canonicalJson';
import { sha256Hex } from '@lib/sha256';
import { getBuilding } from '../../../building/model';
import { itemsCsv, nozzlesCsv } from '../datasheet/csv';
import { buildDatasheet } from '../datasheet/record';
import { refuse } from '../model';
import { angleConventionParam, type AngleConvention } from './angles';
import { equipmentRefParam, findEquipment } from './equipmentRef';

/** A file-name safe form of a tag (`E-301/A` -> `E-301_A`). */
const slug = (tag: string): string => tag.replace(/[^A-Za-z0-9._-]+/g, '_');

/**
 * @affects none (query: returns the same document; the sheet is in `data`, the file text in `data.text` for `--save`)
 * @invariant composes vessel_volume, equipment_weights, vessel_thickness / tank_shell_thickness, check_equipment and equipment_ports (one source of
 *   truth); lengths in mm, a query that refuses becomes a section { available: false, code, message } (never omitted); reviewRequired always true;
 *   byte-deterministic (canonical JSON, fixed row order); CSV text cells pass the spreadsheet formula guard
 * @failure unknown equipment -> EQP_NOT_FOUND; legacy footprint equipment or a block -> EQP_NOT_PARAMETRIC
 */
export const equipmentDatasheet = defineCommand({
  name: 'equipment_datasheet',
  description:
    'Query: the data sheet of one parametric equipment (tag or id of a vessel, process column, heat exchanger, storage tank or pump) as JSON ' +
    '(llull-equipment-datasheet/1) or CSV. Sections: identification (tag, template, level, location, plan rotation), design (pressure, temperature, ' +
    'material, allowable stress with its source, joint efficiency, corrosion allowance; `missing` lists the inputs not given - never defaulted), ' +
    'geometry (template dimensions, supports, inside surface area of a vessel), nozzles (schedule: mark, service, DN, rating, facing, location, ' +
    'orientationDeg, projection, port id, flange position and direction), volumes (vessel_volume), weights (equipment_weights with the method of every ' +
    'line, defaulted values, unverified), codeResults (check_equipment findings and the ASME / API 650 thickness result), provenance and review ' +
    '(status not_reviewed, reviewRequired always true with reasons, unverified, defaulted). Lengths are millimetres whatever the document unit; ' +
    'volumes m3, masses kg, stresses and pressures MPa. A section whose query refuses (for example thickness without design data) is ' +
    '{ available: false, reason, code, message } - never silently left out. format json (default) returns the record; format csv returns `data.text`: ' +
    'table items (default; one row per value of every section EXCEPT the nozzle schedule: section,item,value,unit,source) or table nozzles (the nozzle schedule only, one row per nozzle). The same sections are ' +
    'returned in `data` for both formats; `data.text` is the file text (for json it repeats the record; use --save FILE) with `fileName` and `sha256`. Refusals: EQP_NOT_FOUND, ' +
    'EQP_NOT_PARAMETRIC (legacy box or nozzle-only block). Does not modify the document.',
  annotations: { readOnly: true, idempotent: true },
  params: z.object({
    equipment: equipmentRefParam,
    format: z.enum(['json', 'csv']).optional().describe('json (default): the canonical record. csv: a table in data.text.'),
    table: z
      .enum(['items', 'nozzles'])
      .optional()
      .describe('csv only: items (default) = every value of the sheet, one per row; nozzles = the nozzle schedule, one row per nozzle.'),
    angleConvention: angleConventionParam,
  }),
  run: (doc, { equipment, format = 'json', table = 'items', angleConvention }): CommandResult => {
    const building = getBuilding(doc);
    const element = findEquipment(building, equipment);
    if (element === undefined)
      return refuse(doc, 'equipment_datasheet', 'EQP_NOT_FOUND', `no equipment with tag or id '${equipment}'`, [], ['equipment']);
    const convention: AngleConvention = angleConvention ?? 'north_cw';
    const sheet = buildDatasheet(doc, element, convention);
    if (sheet === null)
      return refuse(
        doc,
        'equipment_datasheet',
        'EQP_NOT_PARAMETRIC',
        `${element.mark} (${element.id}) is ${element.plant === undefined ? 'a legacy footprint equipment' : 'a block that only carries nozzles'}: it has no template to put on a data sheet`,
        [element.id],
        ['equipment'],
      );
    const text = format === 'json' ? canonicalJson(sheet) : table === 'nozzles' ? nozzlesCsv(sheet) : itemsCsv(sheet);
    const fileName = `${slug(element.mark)}-${format === 'json' ? 'datasheet.json' : table === 'nozzles' ? 'nozzles.csv' : 'datasheet.csv'}`;
    return report(
      doc,
      `equipment_datasheet: ${element.mark} (${sheet.identification['template']}), ${sheet.nozzles.length} nozzle(s), ${format}${format === 'csv' ? ` ${table}` : ''}, ${new TextEncoder().encode(text).length} bytes; review required.`,
      {
        ...sheet,
        format,
        ...(format === 'csv' ? { table } : {}),
        fileName,
        text,
        sha256: sha256Hex(text),
        bytes: new TextEncoder().encode(text).length,
      },
    );
  },
});
