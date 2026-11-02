/**
 * The data-sheet record `llull-equipment-datasheet/1` of one parametric equipment (plant 03 EQP §6, FR-EQP-13): identification, design data, geometry,
 * nozzle schedule, volumes, weights, code results, provenance and review status. Every number comes from the registered queries
 * (`vessel_volume`, `equipment_weights`, `vessel_thickness`, `tank_shell_thickness`, `check_equipment`, `equipment_ports`) composed through `execute`,
 * so the sheet shows the numbers of the 3D model and of the checks. A query that refuses or does not apply becomes a section
 * `{ available: false, reason: 'refused' | 'not_applicable', code?, message, paths? }`: nothing is silently left out. Lengths are millimetres
 * whatever the document unit.
 * @invariant pure; same document, same record (key order fixed, no clock)
 */

import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { MM_PER_UNIT } from '@core/model/units';
import type { EquipmentElement } from '@aec/building/types';
import { getBuilding } from '../../../building/model';
import { planRotationDegrees, type AngleConvention } from '../commands/angles';
import type { PlantEquipmentData } from '../plantData';
import { designOf, geometryOf } from './designGeometry';
import { millimetres, toMillimetres, type Obj } from './millimetres';
import { nozzleSchedule, type DatasheetWarning } from './nozzleSchedule';

const DATASHEET_SCHEMA = 'llull-equipment-datasheet/1';

export interface Datasheet {
  readonly schema: typeof DATASHEET_SCHEMA;
  readonly identification: Obj;
  readonly design: Obj;
  readonly geometry: Obj;
  readonly nozzles: Obj[];
  /** A section that has no numbers is `{ available: false, reason, code?, message, paths? }`. */
  readonly volumes: Obj;
  readonly weights: Obj;
  readonly codeResults: Obj;
  readonly provenance: Obj;
  readonly review: Obj;
  readonly warnings: DatasheetWarning[];
}

type Answer = { readonly ok: true; readonly data: Obj } | { readonly ok: false; readonly section: Obj };

function ask(doc: CadDocument, name: string, params: Obj): Answer {
  const result = execute(doc, name, params);
  if (result.rejected === true || result.data === undefined)
    return {
      ok: false,
      section: {
        available: false,
        reason: 'refused',
        message: result.summary,
        ...(result.error === undefined ? {} : { code: result.error.code, paths: result.error.paths }),
      },
    };
  return { ok: true, data: result.data as Obj };
}

const notApplicable = (message: string): Obj => ({ available: false, reason: 'not_applicable', message });
const sectionOf = (answer: Answer, convert: (data: Obj) => Obj): Obj => (answer.ok ? convert(answer.data) : answer.section);
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
const unique = (values: readonly string[]): string[] => values.filter((entry, index, all) => all.indexOf(entry) === index);

function checkSection(answer: Answer, id: string): Obj {
  if (!answer.ok) return answer.section;
  const checked = (answer.data['checked'] as Obj[] | undefined)?.find((entry) => entry['id'] === id);
  const reason = answer.data['reviewReason'];
  return {
    status: answer.data['status'],
    issues: answer.data['issues'],
    reviewRequired: answer.data['reviewRequired'],
    ...(reason === undefined ? {} : { reviewReason: reason }),
    notChecked: checked?.['notChecked'] ?? [],
  };
}

function thicknessSection(doc: CadDocument, plant: PlantEquipmentData, reference: string): Obj {
  const kind = plant.template.kind;
  if (kind !== 'vessel' && kind !== 'tank') return notApplicable(`the ${kind} is judged inside check_equipment (see codeResults.check)`);
  const answer = ask(doc, kind === 'vessel' ? 'vessel_thickness' : 'tank_shell_thickness', { equipment: reference });
  return answer.ok ? answer.data : answer.section;
}

/** The record of `element`, or null for legacy equipment and blocks (no template to describe). */
export function buildDatasheet(doc: CadDocument, element: EquipmentElement, convention: AngleConvention): Datasheet | null {
  const plant = element.plant;
  if (plant === undefined || plant.template.kind === 'block') return null;
  const mm = MM_PER_UNIT[doc.units];
  const { template } = plant;
  const building = getBuilding(doc);
  const level = Object.hasOwn(building.levels, element.levelId) ? building.levels[element.levelId] : undefined;
  const reference = element.id;
  const volumes = sectionOf(
    template.kind === 'pump'
      ? { ok: false, section: notApplicable('a pump has no inside volume') }
      : ask(doc, 'vessel_volume', { equipment: reference }),
    (data) => toMillimetres(data, mm) as Obj,
  );
  const weights = sectionOf(
    ask(doc, 'equipment_weights', { equipment: reference, include: ['body', 'nozzles'] }),
    (data) => toMillimetres(data, mm) as Obj,
  );
  const ports = ask(doc, 'equipment_ports', { equipment: reference, angleConvention: convention });
  const check = checkSection(ask(doc, 'check_equipment', { equipment: [reference] }), element.id);
  const schedule = nozzleSchedule(element, plant, ports, mm);
  const thickness = thicknessSection(doc, plant, reference);
  const defaulted = unique([...strings((template as { defaulted?: unknown }).defaulted), ...strings(weights['defaulted'])]);
  const unverified =
    weights['unverified'] === true ||
    thickness['unverified'] === true ||
    schedule.rows.some((row) => (row['flange'] as Obj)['unverified'] === true) ||
    (template.kind === 'pump' && template.envelope.grade !== 'A');
  const reasons = unique(strings([check['reviewReason'], thickness['reviewReason']]));
  return {
    schema: DATASHEET_SCHEMA,
    identification: {
      tag: element.mark,
      elementId: element.id,
      name: element.name,
      template: template.kind,
      ...('orientation' in template ? { orientation: template.orientation } : {}),
      level: level?.name ?? null,
      levelElevationMm: level === undefined ? null : millimetres(level.elevation, mm),
      locationMm: element.location.map((value) => millimetres(value, mm)),
      planRotationDeg: Math.round(planRotationDegrees(element.angle, convention) * 1e9) / 1e9 + 0,
      angleConvention: convention,
    },
    design: designOf(plant, mm),
    geometry: geometryOf(element, plant, mm),
    nozzles: schedule.rows,
    volumes,
    weights,
    codeResults: { check, thickness },
    provenance: {
      source: `element ${element.id} (${plant.schema})`,
      units: {
        length: 'mm',
        area: 'm2',
        volume: 'm3',
        mass: 'kg',
        stress: 'MPa',
        pressure: 'MPa (gauge)',
        temperature: 'degC',
        angle: 'deg',
      },
      documentUnits: doc.units,
      methods: { volumes: volumes['method'] ?? null, thickness: thickness['provenance'] ?? null },
    },
    review: {
      status: 'not_reviewed',
      reviewRequired: true,
      reasons: reasons.length > 0 ? reasons : ['computed by llull: not a stamped design; a person reviews and signs the data sheet'],
      unverified,
      defaulted,
    },
    warnings: schedule.warnings,
  };
}
