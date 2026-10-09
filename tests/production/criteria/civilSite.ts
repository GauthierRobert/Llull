import type {
  AlignmentObject,
  CivilCategory,
  CivilObject,
  ManholeObject,
  PipeObject,
  PlatformObject,
  PointGroupObject,
  SurfaceObject,
} from '@core/model/civil';
import type { CadDocument, Vec2 } from '@core/model/types';
import type { CheckOutcome, Criterion, GradeContext } from '../contract';
import { surveyRows, type CivilIntent } from '../civil/intent';
import { insidePolygon, round } from '../oracle/geometry';
import { parseLandXml } from '../oracle/landxml';
import { paperName, parseSheet, printedScales, STANDARD_SCALES } from '../oracle/svg';

/**
 * @layer tests/production/criteria
 *
 * Acceptance criteria of a civil office's site job (survey → terrain → balanced pad → road →
 * storm network → sheets + LandXML). Engineering references are computed here, independently of
 * llull's code paths: convex-hull area, survey statistics, Barnett spiral length, Manning full-bore
 * capacity, pipe slope from inverts; LandXML is read back with an independent XML reader. llull's
 * own checks (balance, design-speed checks, HGL) are run on the final document and graded against
 * the office's thresholds.
 */

function objects<C extends CivilCategory>(
  doc: CadDocument,
  category: C,
): Extract<CivilObject, { category: C }>[] {
  const civil = doc.civil;
  return (civil?.order ?? [])
    .map((id) => civil?.objects[id])
    .filter((o): o is Extract<CivilObject, { category: C }> => o?.category === category);
}

const pass = (detail: string): CheckOutcome => ({ pass: true, detail });
const fail = (detail: string): CheckOutcome => ({ pass: false, detail });
const near = (a: Vec2, b: Vec2, tolerance: number): boolean =>
  Math.hypot(a[0] - b[0], a[1] - b[1]) <= tolerance;

function convexHullArea(points: Vec2[]): number {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: Vec2, a: Vec2, b: Vec2): number =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (input: Vec2[]): Vec2[] => {
    const hull: Vec2[] = [];
    for (const p of input) {
      while (hull.length >= 2 && cross(hull[hull.length - 2]!, hull[hull.length - 1]!, p) <= 0)
        hull.pop();
      hull.push(p);
    }
    return hull.slice(0, -1);
  };
  const hull = [...half(sorted), ...half([...sorted].reverse())];
  let twice = 0;
  hull.forEach((p, i) => {
    const q = hull[(i + 1) % hull.length]!;
    twice += p[0] * q[1] - q[0] * p[1];
  });
  return Math.abs(twice) / 2;
}

function surveyCheck(intent: CivilIntent, { document }: GradeContext): CheckOutcome {
  const rows = surveyRows(intent);
  const groups = objects(document, 'pointGroup') as PointGroupObject[];
  const group = groups.find((g) => g.points.length === rows.length);
  if (!group) {
    return fail(
      `no point group holds the ${rows.length} surveyed points (${groups.map((g) => g.points.length).join(', ') || 'none'})`,
    );
  }
  const key = (e: number, n: number, z: number): string =>
    `${e.toFixed(3)} ${n.toFixed(3)} ${z.toFixed(3)}`;
  const surveyed = new Set(rows.map((r) => key(r.e, r.n, r.z)));
  const missing = group.points.filter((p) => !surveyed.has(key(...p.position))).length;
  const codes = new Map<string, number>();
  for (const r of rows) codes.set(r.code, (codes.get(r.code) ?? 0) + 1);
  const coded = [...codes].every(
    ([code, count]) => group.points.filter((p) => p.code === code).length === count,
  );
  return missing === 0 && coded
    ? pass(
        `${rows.length} points at their surveyed E/N/Z, codes ${[...codes].map(([c, n]) => `${c} ${n}`).join(', ')}`,
      )
    : fail(`${missing} point(s) off their surveyed position; codes kept: ${coded}`);
}

function terrainCheck(intent: CivilIntent, { document, run }: GradeContext): CheckOutcome {
  const surface = (objects(document, 'surface') as SurfaceObject[])[0];
  if (!surface) return fail('no terrain surface');
  const rows = surveyRows(intent);
  const data = run('surface_report', { surfaceId: surface.id }).data as
    | { planAreaM2: number; minElevationM: number; maxElevationM: number; points: number }
    | undefined;
  if (!data) return fail('surface_report returned no data');
  // Points sharing a plan position (a tree shot on a grid point) are one TIN vertex.
  const distinct = new Set(rows.map((r) => `${r.e.toFixed(3)} ${r.n.toFixed(3)}`)).size;
  const hull = convexHullArea(rows.map((r) => [r.e, r.n]));
  const zs = rows.map((r) => r.z);
  const [zMin, zMax] = [Math.min(...zs), Math.max(...zs)];
  const areaError = Math.abs(data.planAreaM2 - hull) / hull;
  const ok =
    data.points === distinct &&
    areaError < 0.01 &&
    Math.abs(data.minElevationM - zMin) < 0.01 &&
    Math.abs(data.maxElevationM - zMax) < 0.01;
  return {
    pass: ok,
    detail: `TIN of ${data.points}/${distinct} distinct surveyed positions, ${data.planAreaM2} m² vs survey hull ${round(hull, 0)} m² (${round(areaError * 100, 2)} %), z ${data.minElevationM}–${data.maxElevationM} vs ${zMin}–${zMax}`,
  };
}

function padCheck(intent: CivilIntent, { document, run }: GradeContext): CheckOutcome {
  const pad = (objects(document, 'platform') as PlatformObject[]).find((p) =>
    intent.pad.boundary.every((v) => p.boundary.some((b) => near(v, b, 0.01))),
  );
  if (!pad) return fail('no platform on the brief outline');
  const data = run('platform_earthworks', { platformId: pad.id }).data as
    | { cutM3: number; fillM3: number }
    | undefined;
  if (!data) return fail('platform_earthworks returned no data');
  const residual = data.cutM3 * intent.pad.swellFactor - data.fillM3;
  const ratio = Math.abs(residual) / Math.max(data.fillM3, 1);
  const inside = surveyRows(intent).filter((r) => insidePolygon([r.e, r.n], intent.pad.boundary));
  const meanGround = inside.reduce((sum, r) => sum + r.z, 0) / Math.max(inside.length, 1);
  const plausible = Math.abs(pad.elevation - meanGround) < 0.5;
  return {
    pass: ratio < 0.01 && plausible && pad.cutSlope === intent.pad.cutSlope,
    detail: `pad at ${round(pad.elevation, 3)} m: cut ${data.cutM3} m³ × ${intent.pad.swellFactor} vs fill ${data.fillM3} m³, residual ${round(ratio * 100, 2)} % (< 1 %); mean surveyed ground inside the pad ${round(meanGround, 2)} m`,
  };
}

function roadOf(intent: CivilIntent, doc: CadDocument): AlignmentObject | undefined {
  return (objects(doc, 'alignment') as AlignmentObject[]).find(
    (a) =>
      a.points.length === intent.road.points.length &&
      intent.road.points.every((p, i) => near(p, a.points[i] ?? [NaN, NaN], 0.01)),
  );
}

function roadGeometryCheck(intent: CivilIntent, { document }: GradeContext): CheckOutcome {
  const road = roadOf(intent, document);
  if (!road) return fail('no alignment through the brief PIs');
  const v = intent.road.designSpeedKmh;
  const problems: string[] = [];
  road.radii.forEach((radius, i) => {
    const spiral = road.spirals?.[i] ?? 0;
    const minimum = v ** 3 / (46.656 * 0.6 * radius);
    if (radius < (intent.road.radii[i] ?? 0) - 1e-6) problems.push(`R${i + 1} ${radius} m`);
    if (spiral < minimum) problems.push(`Ls${i + 1} ${spiral} m < ${round(minimum, 1)} m`);
  });
  const section = road.section;
  if (!section) problems.push('no road template');
  else if (
    section.laneWidth !== intent.road.laneWidth ||
    section.shoulderWidth !== intent.road.shoulderWidth
  )
    problems.push(`template ${section.laneWidth} + ${section.shoulderWidth} m`);
  if (road.superelevation?.maxRate !== intent.road.maxSuperelevation)
    problems.push(`superelevation ${road.superelevation?.maxRate ?? 'none'}`);
  return problems.length === 0
    ? pass(
        `R ${road.radii.join(', ')} m with clothoids ${road.spirals?.join(', ')} m (Barnett Ls_min at ${v} km/h), template ${section?.laneWidth} + ${section?.shoulderWidth} m, e max ${intent.road.maxSuperelevation * 100} %`,
      )
    : fail(problems.join('; '));
}

function roadReportCheck(intent: CivilIntent, { document, run }: GradeContext): CheckOutcome {
  const road = roadOf(intent, document);
  if (!road) return fail('no alignment through the brief PIs');
  const report = run('alignment_report', {
    alignmentId: road.id,
    designSpeedKmh: intent.road.designSpeedKmh,
  });
  const data = report.data as
    | {
        rows: { station: number; designM: number | null; superelevationPercent: number | null }[];
        checks?: { failures: string[] };
        totals: { lengthM: number };
      }
    | undefined;
  if (!data?.checks) return fail(`no design-speed check: ${report.summary}`);
  const designed = data.rows.filter((r) => r.designM !== null);
  let maxGrade = 0;
  for (let i = 1; i < designed.length; i++) {
    const a = designed[i - 1]!;
    const b = designed[i]!;
    if (b.station > a.station)
      maxGrade = Math.max(maxGrade, Math.abs((b.designM! - a.designM!) / (b.station - a.station)));
  }
  const banked = Math.max(...data.rows.map((r) => Math.abs(r.superelevationPercent ?? 0)));
  // The profile must run the whole road; the end station is printed to 1 cm, so a profile ending
  // within 5 cm of it is complete for the office.
  const undesigned = data.rows.filter(
    (r) => r.designM === null && r.station < data.totals.lengthM - 0.05,
  );
  const fullLength = undesigned.length === 0;
  const ok =
    data.checks.failures.length === 0 &&
    maxGrade <= intent.road.maxGrade &&
    fullLength &&
    Math.abs(banked - intent.road.maxSuperelevation * 100) < 0.01;
  return {
    pass: ok,
    detail: `${data.rows.length} stations over ${data.totals.lengthM} m, design-check failures at ${intent.road.designSpeedKmh} km/h: ${data.checks.failures.length === 0 ? 'none' : data.checks.failures.join(' ')}; max grade ${round(maxGrade * 100, 2)} % (≤ ${intent.road.maxGrade * 100} %); full banking ${banked} %${fullLength ? '' : `; no design at ${undesigned.map((r) => r.station).join(', ')}`}`,
  };
}

function networkOf(intent: CivilIntent, doc: CadDocument): (ManholeObject | undefined)[] {
  const manholes = objects(doc, 'manhole') as ManholeObject[];
  return intent.drainage.manholes.map((m) =>
    manholes.find((h) => near(h.position, m.location, 0.5)),
  );
}

function networkCheck(intent: CivilIntent, { document }: GradeContext): CheckOutcome {
  const placed = networkOf(intent, document);
  const pipes = objects(document, 'pipe') as PipeObject[];
  const problems: string[] = [];
  placed.forEach((m, i) => {
    if (!m) problems.push(`${intent.drainage.manholes[i]?.name} missing`);
  });
  for (const [from, to] of intent.drainage.pipes) {
    const a = placed[from];
    const b = placed[to];
    const pipe = pipes.find((p) => p.fromId === a?.id && p.toId === b?.id);
    if (!pipe)
      problems.push(
        `no pipe ${intent.drainage.manholes[from]?.name} → ${intent.drainage.manholes[to]?.name}`,
      );
    else if (!(pipe.invertFrom > pipe.invertTo)) problems.push(`${pipe.name} not falling`);
    else if (!intent.drainage.diametersMm.some((d) => Math.abs(d / 1000 - pipe.diameter) < 1e-6))
      problems.push(`${pipe.name} Ø${pipe.diameter * 1000} mm not a commercial size`);
  }
  return problems.length === 0
    ? pass(
        `${placed.length} manholes, ${intent.drainage.pipes.length} falling pipes to the outfall, commercial sizes ${pipes.map((p) => `Ø${round(p.diameter * 1000, 0)}`).join(', ')}`,
      )
    : fail(problems.join('; '));
}

interface PipeRow {
  id: string;
  name: string;
  designLps: number;
  surcharged: boolean;
  flooding: boolean;
  status: string;
}

function hydraulicsCheck(intent: CivilIntent, { document, run }: GradeContext): CheckOutcome {
  const { idf, outfallLevel, minCoverM, minVelocity } = intent.drainage;
  const result = run('check_drainage_network', { idf, outfallLevel, minCoverM, minVelocity });
  const data = result.data as
    | { pipes: PipeRow[]; manholes: { flooding: boolean; name: string }[]; failures: string[] }
    | undefined;
  if (!data) return fail(`no network check: ${result.summary}`);
  const pipes = objects(document, 'pipe') as PipeObject[];
  const capacityShort: string[] = [];
  for (const row of data.pipes) {
    const pipe = pipes.find((p) => p.id === row.id);
    if (!pipe) continue;
    const from = (objects(document, 'manhole') as ManholeObject[]).find(
      (m) => m.id === pipe.fromId,
    );
    const to = (objects(document, 'manhole') as ManholeObject[]).find((m) => m.id === pipe.toId);
    if (!from || !to) continue;
    const length = Math.hypot(to.position[0] - from.position[0], to.position[1] - from.position[1]);
    const slope = (pipe.invertFrom - pipe.invertTo) / length;
    const area = (Math.PI * pipe.diameter ** 2) / 4;
    const capacityLps =
      (1000 / pipe.manningN) * area * (pipe.diameter / 4) ** (2 / 3) * Math.sqrt(slope);
    if (capacityLps < row.designLps)
      capacityShort.push(`${row.name} ${round(capacityLps, 1)} < ${row.designLps} L/s`);
  }
  const surcharged = data.pipes.filter((p) => p.surcharged).map((p) => p.name);
  const flooding = [
    ...data.pipes.filter((p) => p.flooding).map((p) => p.name),
    ...data.manholes.filter((m) => m.flooding).map((m) => m.name),
  ];
  const ok =
    surcharged.length === 0 &&
    flooding.length === 0 &&
    data.failures.length === 0 &&
    capacityShort.length === 0;
  return {
    pass: ok,
    detail: `IDF i = ${idf.a}/(t+${idf.b})^${idf.c}, tailwater ${outfallLevel} m: design ${data.pipes.map((p) => `${p.name} ${p.designLps} L/s`).join(', ')}; surcharged ${surcharged.length}, flooding ${flooding.length}, check failures ${data.failures.length === 0 ? 'none' : data.failures.join(' ')}${capacityShort.length > 0 ? `; Manning full-bore short: ${capacityShort.join(', ')}` : '; Manning full-bore capacity ≥ design flow'}`,
  };
}

function sheetCheck(intent: CivilIntent, { document, deliverable }: GradeContext): CheckOutcome {
  const road = roadOf(intent, document);
  if (!road) return fail('no alignment through the brief PIs');
  const svg = deliverable(`plan-profile:${road.id}:${intent.sheetPaper}`);
  if (svg === '') return fail('no plan-profile sheet');
  const sheet = parseSheet(svg);
  const paper = paperName(sheet);
  const scales = printedScales(sheet).filter((s) => STANDARD_SCALES.includes(s));
  const ok =
    sheet.errors.length === 0 &&
    paper === intent.sheetPaper &&
    scales.length > 0 &&
    sheet.titleBlock.some((t) => t.includes(intent.project.drawingNumber)) &&
    sheet.texts.some((t) => /0\+000/.test(t));
  return {
    pass: ok,
    detail: `${paper ?? 'non-ISO'} sheet, scale 1:${scales[0] ?? '?'}, title block ${sheet.titleBlock.length > 0 ? 'present' : 'missing'}${sheet.errors.length > 0 ? `; ${sheet.errors.join(', ')}` : ''}`,
  };
}

function landXmlCheck(intent: CivilIntent, { document, deliverable }: GradeContext): CheckOutcome {
  const xml = parseLandXml(deliverable('landxml'));
  const rows = surveyRows(intent);
  const pipes = objects(document, 'pipe') as PipeObject[];
  const problems: string[] = [...xml.errors];
  if (xml.cgPoints !== rows.length) problems.push(`${xml.cgPoints} CgPoints vs ${rows.length}`);
  if (xml.surfaces.length === 0 || xml.surfaces.some((s) => s.faces === 0))
    problems.push('no TIN Surface');
  const road = xml.alignments.find((a) => a.name === intent.road.name);
  if (!road) problems.push('no Alignment');
  else if (road.spirals < 2 * intent.road.spirals.filter((s) => s > 0).length || !road.profile)
    problems.push(`Alignment spirals ${road.spirals}, profile ${road.profile}`);
  if (
    xml.structs !== intent.drainage.manholes.length ||
    xml.pipes.length !== intent.drainage.pipes.length
  )
    problems.push(`PipeNetwork ${xml.structs} structs / ${xml.pipes.length} pipes`);
  // Slope convention: llull writes a ratio (0.01 = 1 %) — check it against the inverts.
  for (const pipe of xml.pipes) {
    const model = pipes.find((p) => p.name === pipe.name);
    if (!model) continue;
    const from = (objects(document, 'manhole') as ManholeObject[]).find(
      (m) => m.id === model.fromId,
    );
    const to = (objects(document, 'manhole') as ManholeObject[]).find((m) => m.id === model.toId);
    if (!from || !to) continue;
    const length = Math.hypot(to.position[0] - from.position[0], to.position[1] - from.position[1]);
    const slope = ((model.invertFrom - model.invertTo) / length) * 100;
    if (Math.abs(pipe.slope - slope) > 1e-2)
      problems.push(`${pipe.name} slope ${pipe.slope} vs ${round(slope, 5)}`);
  }
  return problems.length === 0
    ? pass(
        `well-formed LandXML: ${xml.cgPoints} CgPoints, ${xml.surfaces.length} Surface (${xml.surfaces[0]?.faces} faces), Alignment with ${road?.spirals} Spiral + Profile, PipeNetwork ${xml.structs} structs / ${xml.pipes.length} pipes, slopes in percent`,
      )
    : fail(problems.join('; '));
}

export function civilSiteCriteria(intent: CivilIntent): Criterion[] {
  const criterion = (
    id: string,
    area: Criterion['area'],
    requirement: string,
    check: (intent: CivilIntent, ctx: GradeContext) => CheckOutcome,
  ): Criterion => ({ id, area, requirement, check: (ctx) => check(intent, ctx) });
  return [
    criterion(
      'survey-import',
      'survey',
      'Every surveyed point is imported at its E/N/Z with its field code.',
      surveyCheck,
    ),
    criterion(
      'terrain',
      'survey',
      'The existing-ground TIN uses every point and covers the surveyed area (hull ±1 %, z range exact).',
      terrainCheck,
    ),
    criterion(
      'pad-balanced',
      'earthworks',
      'The building pad on the brief outline balances: |cut × swell − fill| < 1 % of fill, level plausible against the survey.',
      padCheck,
    ),
    criterion(
      'road-geometry',
      'roads',
      'The access road follows the brief PIs with clothoids ≥ the comfort minimum, the brief template and superelevation.',
      roadGeometryCheck,
    ),
    criterion(
      'road-design-checks',
      'roads',
      'The road report has no design-check failure at the design speed, grades ≤ the maximum, full banking on the curve.',
      roadReportCheck,
    ),
    criterion(
      'storm-network',
      'drainage',
      'The storm network connects the brief manholes to the outfall with falling pipes of commercial sizes.',
      networkCheck,
    ),
    criterion(
      'storm-hydraulics',
      'drainage',
      'Under the design storm (IDF) and tailwater: no surcharged pipe, no flooding, no check failure, full-bore capacity ≥ design flow.',
      hydraulicsCheck,
    ),
    criterion(
      'plan-profile-sheet',
      'deliverables',
      'The plan-profile sheet is on the brief paper at a standard scale with a title block.',
      sheetCheck,
    ),
    criterion(
      'landxml',
      'deliverables',
      'LandXML is well-formed with the CgPoints, TIN Surface, Alignment (spirals + profile) and PipeNetwork; pipe slopes match the inverts.',
      landXmlCheck,
    ),
  ];
}
