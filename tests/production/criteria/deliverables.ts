import type { CheckOutcome, Criterion, GradeContext } from '../contract';
import { parseCsv, column } from '../oracle/csv';
import { entityExtents, parseDxf } from '../oracle/dxf';
import {
  absolute,
  buildingOf,
  elementsOf,
  levelsByElevation,
  polylineLength,
  round,
} from '../oracle/geometry';
import {
  containment,
  countByType,
  globalIdProblems,
  numbersIn,
  ofType,
  parseIfc,
  references,
  stepString,
} from '../oracle/ifc';
import {
  STANDARD_SCALES,
  drawingIdentity,
  paperName,
  parseSheet,
  printedScales,
  titleBlockField,
  type Sheet,
} from '../oracle/svg';
import type { PlantIntent } from '../plant/intent';

interface ProjectFields {
  name: string;
  client: string;
  drawingNumber: string;
  revision: string;
  date: string;
}

/**
 * @layer tests/production/criteria
 *
 * Issued-deliverable acceptance, read back with independent parsers: IFC (coordination model),
 * DXF plans, plan and elevation sheets, schedules. Expected counts come from the final document,
 * so these criteria check the export, not the modelling.
 */

const result = (problems: string[], ok: string): CheckOutcome => ({
  pass: problems.length === 0,
  detail: problems.length === 0 ? ok : problems.slice(0, 8).join('; '),
});

/** Cut height of a plan view above FFL (drafting convention, as used by export_dxf). */
const PLAN_CUT = 1200;

function ifcModelCheck({ document, deliverable }: GradeContext): CheckOutcome {
  const file = parseIfc(deliverable('ifc'));
  const problems = [...file.errors.slice(0, 3)];
  if (file.schema !== 'IFC4') problems.push(`schema ${file.schema}, expected IFC4`);
  const guids = globalIdProblems(file);
  if (guids.malformed.length > 0) problems.push(`${guids.malformed.length} malformed GlobalIds`);
  if (guids.duplicated.length > 0) problems.push(`${guids.duplicated.length} duplicated GlobalIds`);
  const counts = countByType(file);
  const members = elementsOf(document, 'member');
  const expected: Record<string, number> = {
    IFCCOLUMN: members.filter((m) => m.role === 'column').length,
    IFCBEAM: members.filter((m) => m.role === 'beam').length,
    IFCMEMBER: members.filter((m) => m.role === 'brace').length,
    IFCSLAB: elementsOf(document, 'slab').length,
    IFCOPENINGELEMENT: elementsOf(document, 'slab').reduce(
      (n, s) => n + (s.openings?.length ?? 0),
      0,
    ),
    IFCPIPESEGMENT: elementsOf(document, 'pipe').length,
    IFCSTAIR: elementsOf(document, 'stair').length,
  };
  for (const [type, count] of Object.entries(expected)) {
    if ((counts[type] ?? 0) !== count)
      problems.push(`${type} ×${counts[type] ?? 0}, model has ${count}`);
  }
  const names = new Set([...file.entities.values()].map((e) => stepString(e.args[2])));
  const missingTags = elementsOf(document, 'equipment').filter((e) => !names.has(e.mark));
  if (missingTags.length > 0)
    problems.push(`equipment not in IFC: ${missingTags.map((e) => e.mark).join(', ')}`);
  const profiles = new Set(ofType(file, 'IFCISHAPEPROFILEDEF').map((e) => stepString(e.args[1])));
  const missingProfiles = [...new Set(members.map((m) => m.profile))].filter(
    (p) => !p.startsWith('CHS') && !profiles.has(p),
  );
  if (missingProfiles.length > 0)
    problems.push(`profile names lost: ${missingProfiles.join(', ')}`);
  return result(
    problems,
    `IFC4 well-formed, ${file.entities.size} entities, GlobalIds unique, element counts match the model`,
  );
}

function ifcStoreysCheck({ document, deliverable }: GradeContext): CheckOutcome {
  const file = parseIfc(deliverable('ifc'));
  const building = buildingOf(document);
  const problems: string[] = [];
  const storeyNames = ofType(file, 'IFCBUILDINGSTOREY').map((s) => ({
    name: stepString(s.args[2]),
    elevation: Number(s.args[9]),
  }));
  for (const level of levelsByElevation(document)) {
    const storey = storeyNames.find((s) => s.name === level.name);
    if (!storey) problems.push(`no storey "${level.name}"`);
    else if (Math.abs(storey.elevation - level.elevation) > 1) {
      problems.push(`storey "${level.name}" at ${storey.elevation}, level at ${level.elevation}`);
    }
  }
  const contained = containment(file);
  let checked = 0;
  for (const entity of file.entities.values()) {
    const element = building.elements[stepString(entity.args[7])];
    if (!element || !('levelId' in element)) continue;
    checked++;
    const expected = building.levels[element.levelId]?.name;
    const actual = contained.get(entity.id) ?? resolveViaHost(file, entity.id, contained);
    if (actual !== expected)
      problems.push(`${element.mark} in storey "${actual ?? 'none'}", expected "${expected}"`);
  }
  return result(
    problems,
    `${storeyNames.length} storeys; ${checked} elements contained in their level's storey`,
  );
}

/** Openings/aggregated parts are contained through their host. */
function resolveViaHost(
  file: ReturnType<typeof parseIfc>,
  id: number,
  contained: Map<number, string>,
): string | undefined {
  for (const rel of [...ofType(file, 'IFCRELVOIDSELEMENT'), ...ofType(file, 'IFCRELAGGREGATES')]) {
    const [host, ...parts] = references(rel.args.slice(4));
    if (host !== undefined && parts.includes(id)) return contained.get(host);
  }
  return undefined;
}

function ifcEquipmentDataCheck({ document, deliverable }: GradeContext): CheckOutcome {
  const file = parseIfc(deliverable('ifc'));
  const properties = ofType(file, 'IFCRELDEFINESBYPROPERTIES');
  const problems: string[] = [];
  for (const equipment of elementsOf(document, 'equipment')) {
    const entity = [...file.entities.values()].find((e) => stepString(e.args[7]) === equipment.id);
    if (!entity) {
      problems.push(`${equipment.mark} not exported`);
      continue;
    }
    const sets = properties
      .filter((rel) => references([rel.args[4] ?? []]).includes(entity.id))
      .flatMap((rel) => references([rel.args[5] ?? '$']));
    // IFCPROPERTYSET lists its properties at [4]; IFCELEMENTQUANTITY (Qto) its quantities at [5].
    const values = sets.flatMap((set) => {
      const definition = file.entities.get(set);
      const index = definition?.type === 'IFCELEMENTQUANTITY' ? 5 : 4;
      return references([definition?.args[index] ?? []]);
    });
    const hasWeight = values.some((v) => {
      const property = file.entities.get(v);
      return (
        property !== undefined &&
        /weight|mass/i.test(stepString(property.args[0])) &&
        numbersIn(property.args.slice(1)).includes(equipment.weight)
      );
    });
    if (!hasWeight) problems.push(`${equipment.mark} carries no operating weight property`);
  }
  return result(problems, 'every equipment carries its operating weight in a property set');
}

function dxfPlansCheck({ document, deliverable }: GradeContext): CheckOutcome {
  const problems: string[] = [];
  const columns = elementsOf(document, 'member')
    .filter((m) => m.role === 'column')
    .map((m) => ({
      mark: m.mark,
      start: absolute(document, m.levelId, m.start),
      end: absolute(document, m.levelId, m.end),
    }));
  for (const level of levelsByElevation(document)) {
    const file = parseDxf(deliverable(`dxf:${level.id}`));
    problems.push(...file.errors.slice(0, 2).map((e) => `${level.name}: ${e}`));
    const cut = level.elevation + PLAN_CUT;
    const cutColumns = columns.filter(
      (c) => Math.min(c.start[2], c.end[2]) < cut && Math.max(c.start[2], c.end[2]) > cut,
    );
    const columnPoints = file.entities
      .filter((e) => e.layer.startsWith('S-COL'))
      .flatMap((e) => e.points);
    const missing = cutColumns.filter(
      (c) => !columnPoints.some(([x, y]) => Math.hypot(x - c.start[0], y - c.start[1]) <= 300),
    );
    if (missing.length > 0)
      problems.push(`${level.name}: ${missing.length}/${cutColumns.length} cut columns not drawn`);
    const texts = file.entities.map((e) => e.text).join(' ');
    const tags = elementsOf(document, 'equipment').filter((e) => e.levelId === level.id);
    const untagged = tags.filter((e) => !texts.includes(e.mark));
    if (untagged.length > 0)
      problems.push(`${level.name}: equipment ${untagged.map((e) => e.mark).join(', ')} not drawn`);
    const { min, max } = entityExtents(file);
    const grid = elementsOf(document, 'grid').flatMap((g) => [g.start, g.end]);
    const gridMin = [Math.min(...grid.map((p) => p[0])), Math.min(...grid.map((p) => p[1]))];
    const gridMax = [Math.max(...grid.map((p) => p[0])), Math.max(...grid.map((p) => p[1]))];
    if (
      (gridMin[0] ?? 0) < min[0] - 1 ||
      (gridMax[0] ?? 0) > max[0] + 1 ||
      (gridMin[1] ?? 0) < min[1] - 1 ||
      (gridMax[1] ?? 0) > max[1] + 1
    ) {
      problems.push(`${level.name}: drawing extents do not cover the grid`);
    }
  }
  return result(problems, 'one DXF plan per level: cut columns, equipment and grid drawn');
}

/** Title-block fields as printed, compared whole with the expected project. */
function titleBlockProblems(sheet: Sheet, project: ProjectFields, where: string): string[] {
  const printed: ProjectFields = {
    name: titleBlockField(sheet, 'PROJECT'),
    client: titleBlockField(sheet, 'CLIENT'),
    ...drawingIdentity(sheet),
  };
  return (Object.keys(printed) as (keyof ProjectFields)[])
    .filter((key) => project[key] !== '' && printed[key] !== project[key])
    .map((key) => `${where}: title block ${key} "${printed[key]}", expected "${project[key]}"`);
}

function expectedProject(intent: PlantIntent | undefined, ctx: GradeContext): ProjectFields {
  const { name, client, drawingNumber, revision, date } =
    intent?.project ?? buildingOf(ctx.document).project;
  return { name, client, drawingNumber, revision, date };
}

function planSheetsCheck(intent: PlantIntent | undefined, ctx: GradeContext): CheckOutcome {
  const { document, deliverable } = ctx;
  const project = expectedProject(intent, ctx);
  const problems: string[] = [];
  for (const level of levelsByElevation(document)) {
    const sheet = parseSheet(deliverable(`plan:${level.id}`));
    problems.push(...sheet.errors.map((e) => `${level.name}: ${e}`));
    if (paperName(sheet) === null)
      problems.push(`${level.name}: ${sheet.widthMm}×${sheet.heightMm} mm is not an ISO sheet`);
    const scales = printedScales(sheet);
    if (scales.length === 0 || !scales.every((s) => STANDARD_SCALES.includes(s))) {
      problems.push(`${level.name}: printed scale(s) ${scales.join(', ') || 'none'}`);
    }
    problems.push(...titleBlockProblems(sheet, project, level.name));
    const texts = sheet.texts.join(' ');
    const tags = elementsOf(document, 'equipment').filter((e) => e.levelId === level.id);
    const missing = tags.filter((e) => !texts.includes(e.mark));
    if (missing.length > 0)
      problems.push(
        `${level.name}: tags ${missing.map((e) => e.mark).join(', ')} not on the sheet`,
      );
  }
  return result(
    problems,
    'one plan sheet per level: ISO paper, standard scale, complete title block, tags',
  );
}

function elevationSheetCheck(intent: PlantIntent | undefined, ctx: GradeContext): CheckOutcome {
  const { document, deliverable } = ctx;
  const sheet = parseSheet(deliverable('elevation:south'));
  const problems = [...sheet.errors];
  const texts = sheet.texts.join(' ');
  for (const level of levelsByElevation(document)) {
    const datum = (level.elevation / 1000).toFixed(3);
    if (!new RegExp(`(?<![\\d.])${datum.replace('.', '\\.')}(?!\\d)`).test(texts)) {
      problems.push(`no level datum ${datum} for "${level.name}"`);
    }
  }
  problems.push(...titleBlockProblems(sheet, expectedProject(intent, ctx), 'south elevation'));
  return result(problems, 'south elevation with every level datum and the current revision');
}

function schedulesCheck(ctx: GradeContext): CheckOutcome {
  const { document } = ctx;
  const problems: string[] = [];
  const members = parseCsv(ctx.deliverable('schedule:member'));
  const memberCount = elementsOf(document, 'member').length;
  if (members.length - 1 !== memberCount)
    problems.push(`member schedule ${members.length - 1} rows, model ${memberCount}`);
  const scheduleKg = column(members, 'Mass (kg)').reduce((a, b) => a + b, 0);
  const takeoff = JSON.parse(ctx.deliverable('takeoff')) as {
    lines?: { key: string; unit: string; quantity: number }[];
  };
  const takeoffKg = (takeoff.lines ?? [])
    .filter((l) => l.key.startsWith('member.') && l.unit === 'kg')
    .reduce((s, l) => s + l.quantity, 0);
  if (Math.abs(scheduleKg - takeoffKg) > 0.005 * Math.max(takeoffKg, 1)) {
    problems.push(`member schedule ${round(scheduleKg)} kg ≠ takeoff ${round(takeoffKg)} kg`);
  }
  const equipment = parseCsv(ctx.deliverable('schedule:equipment'));
  for (const e of elementsOf(document, 'equipment')) {
    const row = equipment.find((cells) => cells[0] === e.mark);
    if (!row || !row.includes(String(e.weight)))
      problems.push(`equipment schedule: ${e.mark} missing or wrong weight`);
  }
  const pipes = parseCsv(ctx.deliverable('schedule:pipe'));
  const lengths = column(pipes, 'Length (m)');
  const marks = pipes.slice(1).map((row) => row[(pipes[0] ?? []).indexOf('Mark')] ?? '');
  elementsOf(document, 'pipe').forEach((pipe) => {
    const metres = polylineLength(pipe.points) / 1000;
    const listed = lengths[marks.indexOf(pipe.mark)] ?? NaN;
    if (!(Math.abs(listed - metres) <= 0.01 * metres + 0.05)) {
      problems.push(`pipe schedule ${pipe.mark}: ${listed} m, geometry ${round(metres, 2)} m`);
    }
  });
  return result(
    problems,
    `schedules agree with the model (${memberCount} members, ${round(takeoffKg / 1000, 2)} t)`,
  );
}

/** Title-block expectations come from the brief (`intent`) when given, else from the document. */
export function deliverableCriteria(intent?: PlantIntent): Criterion[] {
  return [
    {
      id: 'ifc-model',
      area: 'deliverables',
      requirement:
        'IFC4 coordination model: well-formed, unique GlobalIds, every element exported with its class and profile.',
      check: ifcModelCheck,
    },
    {
      id: 'ifc-storeys',
      area: 'deliverables',
      requirement:
        "IFC storeys at the level elevations, each element contained in its level's storey.",
      check: ifcStoreysCheck,
    },
    {
      id: 'ifc-equipment-data',
      area: 'deliverables',
      requirement:
        'IFC equipment carries its operating weight (property set) for the structural engineer.',
      check: ifcEquipmentDataCheck,
    },
    {
      id: 'dxf-plans',
      area: 'deliverables',
      requirement:
        'A DXF plan per level showing the columns cut at that level, the equipment and the grid.',
      check: dxfPlansCheck,
    },
    {
      id: 'plan-sheets',
      area: 'deliverables',
      requirement:
        'A plan sheet per level: ISO paper, standard scale, full title block, equipment tags.',
      check: (ctx) => planSheetsCheck(intent, ctx),
    },
    {
      id: 'elevation-sheet',
      area: 'deliverables',
      requirement: 'South elevation with level datums and the current revision.',
      check: (ctx) => elevationSheetCheck(intent, ctx),
    },
    {
      id: 'schedules',
      area: 'deliverables',
      requirement: 'Member, equipment and pipe schedules agree with the model and the takeoff.',
      check: schedulesCheck,
    },
  ];
}
