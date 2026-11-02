import { exportRefusal, report } from '@core/commands/noop';
import { confirmExportControlled, defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { jcsJson } from '@lib/jcs';
import { sha256Hex } from '@lib/sha256';
import { resolvedOrNull } from '../classes';
import { PROFILE_NAMES, PROFILES, REGISTER_FIELDS, REGISTER_KEYS, registerFileName, type RegisterKey } from '../handover/profiles';
import {
  documentRegisterRows,
  equipmentRegisterRows,
  externalClassId,
  tagPropertyRows,
  tagRegisterRows,
  type RegisterRow,
} from '../handover/registers';
import { getPlantData } from '../model';
import { csvFile, type DataFile } from '../plantReports/files';
import { objectsInScope } from '../plantReports/scope';
import { columnOf } from '../plantReports/types';
import { refuse } from './params';

/**
 * @affects none; data = { profile, unverified, mappingSource, notice, files, registers, mapping, warnings }
 * @invariant identical document -> identical file bytes (rows in natural tag order, no clock); every file of the cfihos-subset profile is marked unverified in its name, in handover-manifest.json and in data.unverified; class ids come only from classes[].externalIds supplied by the project
 * @failure controlled content without confirmation -> MAT_EXPORT_CONTROLLED / MAT_HUMAN_GATE; unknown hierarchy -> DAT_HIERARCHY_UNKNOWN; requireMapping with a class lacking an external id -> DAT_HANDOVER_MAPPING_MISSING; document unchanged
 */
export const exportHandover = defineCommand({
  name: 'export_handover',
  description:
    'Export the handover registers of the plant as CSV files (read-only, document unchanged; save with --save): tag_register (tag, class, class id, parent tag, hierarchy path, description, status modelled / reserved / orphan), ' +
    'equipment_register (tag, manufacturer, model, serial number: the Manufacturer, Model and SerialNumber properties when the class defines them, else empty), tag_properties (one row per stored property value with unit and the unverified flag) and ' +
    'document_register (one row per deliverable revision from set_deliverable_status: current status, content SHA-256, scope, signer, signature id, and contentCurrent = whether the content still hashes to the stored value). ' +
    'profile cfihos-subset: CFIHOS-like names (TAG_NUMBER, TAG_CLASS_ID, ...) and class ids from classes[].externalIds with scheme cfihos (define_plant_class externalIds); llull ships NO CFIHOS code or release, so this profile is UNVERIFIED: ' +
    'data.unverified is true, the file names carry ".unverified" and handover-manifest.json repeats the notice. Do not deliver it as CFIHOS-compliant. profile generic: llull column names, class ids from the company scheme, not marked. ' +
    'registers: a subset (default all four). hierarchy: restrict the tag registers to a node (code, path or id); the document register is never scoped. A class without an id in the profile scheme gets an empty class id and is listed in data.mapping.missing ' +
    'with a warning; classIds: ids given with the export for the classes (library classes cannot carry externalIds). requireMapping: true refuses instead (DAT_HANDOVER_MAPPING_MISSING). Returns data = { profile, unverified, mappingSource, notice, files [{ fileName, content }] (the registers and handover-manifest.json with the SHA-256 and row count of each), ' +
    'registers { <register>: { columns, rows } }, mapping { scheme, mapped, missing[] }, warnings[] }. Refusals: DAT_HIERARCHY_UNKNOWN, DAT_HANDOVER_MAPPING_MISSING, MAT_EXPORT_CONTROLLED.',
  annotations: { readOnly: true, idempotent: true },
  params: z.object({
    confirmExportControlled,
    profile: z.enum(PROFILE_NAMES).describe('cfihos-subset (UNVERIFIED CFIHOS-like names and class ids) or generic (llull names).'),
    registers: z.array(z.enum(REGISTER_KEYS)).min(1).optional().describe('Registers to write; default all four.'),
    hierarchy: z
      .string()
      .optional()
      .describe('Restrict the tag registers to this hierarchy node (code, path S1/P1/U10 or id); omit for the whole plant.'),
    classIds: z
      .record(z.string(), z.string().min(1))
      .optional()
      .describe(
        'Class name -> id in the profile scheme (cfihos for cfihos-subset, company for generic), e.g. { "CentrifugalPump": "<your id>" }; wins over classes[].externalIds. Exact class names only (ids are not inherited). Needed for library classes, which are read-only.',
      ),
    requireMapping: z
      .boolean()
      .optional()
      .describe(
        'true: refuse with DAT_HANDOVER_MAPPING_MISSING when a class of the exported objects has no external id in the profile scheme. Default false.',
      ),
  }),
  run: (doc, params, ctx): CommandResult => {
    const gated = exportRefusal(doc, 'export_handover', 'data', params.confirmExportControlled, ctx);
    if (gated !== null) return gated;
    const profile = PROFILES[params.profile];
    const scope = objectsInScope(doc, params.hierarchy);
    if (!scope.ok) return refuse(doc, 'export_handover', { code: scope.code, message: scope.message, paths: [scope.path] });
    const data = getPlantData(doc);
    const classes = [...new Set(scope.objects.map((object) => object.className))];
    const missing = classes
      .filter((name) => resolvedOrNull(data, name) !== null && externalClassId(doc, profile, name, params.classIds ?? {}) === null)
      .sort();
    if (params.requireMapping === true && missing.length > 0)
      return refuse(doc, 'export_handover', {
        code: 'DAT_HANDOVER_MAPPING_MISSING',
        message: `no ${profile.scheme} id for class(es) ${missing.join(', ')}`,
        paths: ['requireMapping'],
        detail: { missing },
      });
    const rowsOf: Record<RegisterKey, () => RegisterRow[]> = {
      tag_register: () => tagRegisterRows(doc, profile, scope.objects, params.classIds ?? {}),
      equipment_register: () => equipmentRegisterRows(doc, scope.objects),
      tag_properties: () => tagPropertyRows(doc, scope.objects),
      document_register: () => documentRegisterRows(doc, ctx, params.confirmExportControlled),
    };
    const registers: Record<string, { columns: string[]; rows: RegisterRow[] }> = {};
    const files: DataFile[] = [];
    const manifest: Array<{ fileName: string; sha256: string; rows: number }> = [];
    for (const key of REGISTER_KEYS.filter((candidate) => params.registers === undefined || params.registers.includes(candidate))) {
      const fields = REGISTER_FIELDS[key];
      const headers = fields.map((field) => profile.headers[key][field] ?? field);
      const rows = rowsOf[key]().map((row) =>
        Object.fromEntries(fields.map((field, index) => [headers[index] as string, row[field] ?? null])),
      );
      const file = csvFile(registerFileName(profile, key), {
        columns: headers.map((header) => columnOf(header, header, 'text', null, 'derived')),
        rows,
      });
      files.push(file);
      manifest.push({ fileName: file.fileName, sha256: sha256Hex('content' in file ? file.content : ''), rows: rows.length });
      registers[key] = { columns: headers, rows };
    }
    files.push({
      fileName: 'handover-manifest.json',
      content: `${JSON.stringify(
        JSON.parse(
          jcsJson({
            profile: profile.name,
            unverified: profile.unverified,
            notice: profile.notice,
            mappingSource: profile.mappingSource,
            files: manifest,
          }),
        ),
        null,
        2,
      )}\n`,
    });
    const warnings =
      missing.length === 0 ? [] : [`DAT_HANDOVER_MAPPING_MISSING: no ${profile.scheme} id for ${missing.join(', ')} (empty class id)`];
    return report(
      doc,
      `export_handover ${profile.name}: ${manifest.length} register(s), ${manifest.reduce((sum, entry) => sum + entry.rows, 0)} row(s)` +
        (profile.unverified ? '; UNVERIFIED (not checked against an IOGP CFIHOS release)' : '') +
        (missing.length === 0 ? '.' : `; ${missing.length} class(es) without a ${profile.scheme} id.`),
      {
        profile: profile.name,
        unverified: profile.unverified,
        mappingSource: profile.mappingSource,
        notice: profile.notice,
        files,
        registers,
        mapping: { scheme: profile.scheme, mapped: classes.length - missing.length, missing },
        warnings,
      },
    );
  },
});
