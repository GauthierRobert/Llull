import type { CadDocument, Vec3 } from '@core/model/types';
import type { SteelMemberElement } from '@core/model/building';
import type { CheckOutcome, Criterion, GradeContext } from '../contract';
import { absolute, distance, elementsOf, levelsByElevation, round } from '../oracle/geometry';
import { section } from '../oracle/steel';
import {
  gridCoordinates,
  letterLabels,
  type IntentMember,
  type PlantIntent,
} from '../plant/intent';

/**
 * @layer tests/production/criteria
 *
 * Steel structure acceptance: levels, grid, every intended member present with the right section
 * at the right place (absolute axis ends, either direction), floors, and the steel tonnage checked
 * against an independent section table.
 */

const POSITION_TOLERANCE = 5;
const TONNAGE_TOLERANCE = 0.005;

interface AbsoluteMember {
  element: SteelMemberElement;
  start: Vec3;
  end: Vec3;
}

export function absoluteMembers(doc: CadDocument): AbsoluteMember[] {
  return elementsOf(doc, 'member').map((element) => ({
    element,
    start: absolute(doc, element.levelId, element.start),
    end: absolute(doc, element.levelId, element.end),
  }));
}

const sameAxis = (a: { start: Vec3; end: Vec3 }, b: { start: Vec3; end: Vec3 }): boolean =>
  (distance(a.start, b.start) <= POSITION_TOLERANCE &&
    distance(a.end, b.end) <= POSITION_TOLERANCE) ||
  (distance(a.start, b.end) <= POSITION_TOLERANCE &&
    distance(a.end, b.start) <= POSITION_TOLERANCE);

const normalized = (profile: string): string => profile.replace(/\s+/g, '').toUpperCase();

const describeAxis = (m: { start: Vec3; end: Vec3 }): string =>
  `(${m.start.map((v) => round(v, 0)).join(',')})→(${m.end.map((v) => round(v, 0)).join(',')})`;

/** Match intended members of one role against the model's members of that role. */
function memberCheck(doc: CadDocument, intended: IntentMember[], role: string): CheckOutcome {
  const model = absoluteMembers(doc).filter((m) => m.element.role === role);
  const unmatched = new Set(model);
  const missing: string[] = [];
  const wrongProfile: string[] = [];
  for (const member of intended) {
    const found = [...unmatched].find((m) => sameAxis(m, member));
    if (!found) {
      missing.push(`${member.profile} ${describeAxis(member)}`);
      continue;
    }
    unmatched.delete(found);
    if (normalized(found.element.profile) !== normalized(member.profile)) {
      wrongProfile.push(
        `${found.element.mark} is ${found.element.profile}, expected ${member.profile}`,
      );
    }
  }
  const extra = [...unmatched].map((m) => `${m.element.mark} ${describeAxis(m)}`);
  const pass = missing.length === 0 && wrongProfile.length === 0 && extra.length === 0;
  const parts = [`${intended.length - missing.length}/${intended.length} ${role}s placed`];
  if (missing.length > 0)
    parts.push(`missing ${missing.length}: ${missing.slice(0, 4).join('; ')}`);
  if (wrongProfile.length > 0) parts.push(`wrong section: ${wrongProfile.slice(0, 4).join('; ')}`);
  if (extra.length > 0)
    parts.push(`not in the design ${extra.length}: ${extra.slice(0, 4).join('; ')}`);
  return { pass, detail: parts.join(' — ') };
}

function levelsCheck(intent: PlantIntent, { document }: GradeContext): CheckOutcome {
  const model = levelsByElevation(document);
  const problems: string[] = [];
  for (const level of intent.levels) {
    const found = model.find((m) => Math.abs(m.elevation - level.elevation) <= 1);
    if (!found) problems.push(`no level at FFL ${level.elevation}`);
    else if (Math.abs(found.height - level.height) > 1) {
      problems.push(`"${found.name}" storey height ${found.height}, expected ${level.height}`);
    }
  }
  if (model.length !== intent.levels.length) {
    problems.push(`${model.length} levels, expected ${intent.levels.length}`);
  }
  return {
    pass: problems.length === 0,
    detail:
      problems.length === 0 ? `${model.length} levels at the design FFLs` : problems.join('; '),
  };
}

function gridCheck(intent: PlantIntent, { document }: GradeContext): CheckOutcome {
  const axes = elementsOf(document, 'grid');
  const xs = gridCoordinates(intent.grid.xSpacings);
  const ys = gridCoordinates(intent.grid.ySpacings);
  const problems: string[] = [];
  xs.forEach((x, i) => {
    const label = String(i + 1);
    const axis = axes.find((a) => Math.abs(a.start[0] - x) <= 1 && Math.abs(a.end[0] - x) <= 1);
    if (!axis) problems.push(`no axis at x=${x}`);
    else if (axis.mark !== label)
      problems.push(`axis at x=${x} labelled ${axis.mark}, expected ${label}`);
  });
  letterLabels(ys.length).forEach((label, i) => {
    const y = ys[i] ?? 0;
    const axis = axes.find((a) => Math.abs(a.start[1] - y) <= 1 && Math.abs(a.end[1] - y) <= 1);
    if (!axis) problems.push(`no axis at y=${y}`);
    else if (axis.mark !== label)
      problems.push(`axis at y=${y} labelled ${axis.mark}, expected ${label}`);
  });
  return {
    pass: problems.length === 0,
    detail:
      problems.length === 0
        ? `${xs.length} × ${ys.length} grid axes, correctly labelled`
        : problems.join('; '),
  };
}

function floorsCheck(intent: PlantIntent, { document }: GradeContext): CheckOutcome {
  const slabs = elementsOf(document, 'slab');
  const levels = levelsByElevation(document);
  const problems: string[] = [];
  for (const floor of intent.floors) {
    const ffl = intent.levels[floor.level]?.elevation ?? 0;
    const slab = slabs.find((s) => {
      const level = levels.find((l) => l.id === s.levelId);
      return level !== undefined && Math.abs(level.elevation + s.offset - ffl) <= 1;
    });
    if (!slab) {
      problems.push(`no floor with its top at FFL ${ffl}`);
      continue;
    }
    if (Math.abs(slab.thickness - floor.thickness) > 0.5) {
      problems.push(
        `${slab.mark} at ${ffl} is ${slab.thickness} thick, expected ${floor.thickness}`,
      );
    }
    if (!slab.material.toLowerCase().includes(floor.material.toLowerCase())) {
      problems.push(`${slab.mark} at ${ffl} is ${slab.material}, expected ${floor.material}`);
    }
    if (
      Math.abs(polygonArea(slab.boundary) - polygonArea(floor.boundary)) >
      1e-3 * polygonArea(floor.boundary)
    ) {
      problems.push(`${slab.mark} at ${ffl} does not cover the grid footprint`);
    }
  }
  return {
    pass: problems.length === 0,
    detail:
      problems.length === 0 ? `${intent.floors.length} floors as designed` : problems.join('; '),
  };
}

function polygonArea(points: readonly (readonly number[])[]): number {
  let twice = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i] ?? [0, 0];
    const b = points[(i + 1) % points.length] ?? [0, 0];
    twice += (a[0] ?? 0) * (b[1] ?? 0) - (b[0] ?? 0) * (a[1] ?? 0);
  }
  return Math.abs(twice) / 2;
}

/** Oracle tonnage (kg) of a member list; null when a section is not in the oracle table. */
function oracleMass(members: { profile: string; start: Vec3; end: Vec3 }[]): number | null {
  let kg = 0;
  for (const member of members) {
    const facts = section(member.profile);
    if (!facts) return null;
    kg += (distance(member.start, member.end) / 1000) * facts.kgPerM;
  }
  return kg;
}

function tonnageCheck(intent: PlantIntent, ctx: GradeContext): CheckOutcome {
  const model = absoluteMembers(ctx.document);
  const oracleModel = oracleMass(model.map((m) => ({ ...m, profile: m.element.profile })));
  const oracleDesign = oracleMass(intent.members) ?? 0;
  const takeoff = ctx.run('quantity_takeoff').data as {
    lines?: { key: string; unit: string; quantity: number }[];
  };
  const takeoffKg = (takeoff.lines ?? [])
    .filter((line) => line.key.startsWith('member.') && line.unit === 'kg')
    .reduce((sum, line) => sum + line.quantity, 0);
  if (oracleModel === null)
    return { pass: false, detail: 'a member section is not in the oracle table' };
  const off = (a: number, b: number): number => Math.abs(a - b) / Math.max(b, 1);
  const detail =
    `takeoff ${round(takeoffKg / 1000, 2)} t, oracle on the model ${round(oracleModel / 1000, 2)} t, ` +
    `design ${round(oracleDesign / 1000, 2)} t`;
  return {
    pass:
      off(takeoffKg, oracleModel) <= TONNAGE_TOLERANCE &&
      off(oracleModel, oracleDesign) <= TONNAGE_TOLERANCE,
    detail,
  };
}

export function structureCriteria(intent: PlantIntent): Criterion[] {
  const byRole = (role: string): IntentMember[] => intent.members.filter((m) => m.role === role);
  return [
    {
      id: 'levels',
      area: 'structure',
      requirement: 'Levels at the design finished-floor levels and storey heights.',
      check: (ctx) => levelsCheck(intent, ctx),
    },
    {
      id: 'grid',
      area: 'structure',
      requirement: 'Structural grid axes at the design positions with the drawing labels.',
      check: (ctx) => gridCheck(intent, ctx),
    },
    {
      id: 'columns',
      area: 'structure',
      requirement: 'Every column at its grid intersection, right section, base to top.',
      check: (ctx) => memberCheck(ctx.document, byRole('column'), 'column'),
    },
    {
      id: 'floor-beams',
      area: 'structure',
      requirement: 'Every floor beam on its axis with top of steel = FFL − grating.',
      check: (ctx) => memberCheck(ctx.document, byRole('beam'), 'beam'),
    },
    {
      id: 'bracing',
      area: 'structure',
      requirement: 'Every bracing diagonal between its work points.',
      check: (ctx) => memberCheck(ctx.document, byRole('brace'), 'brace'),
    },
    {
      id: 'floors',
      area: 'structure',
      requirement: 'Gratings of the design thickness over the full footprint at every floor.',
      check: (ctx) => floorsCheck(intent, ctx),
    },
    {
      id: 'steel-tonnage',
      area: 'structure',
      requirement:
        'Takeoff steel tonnage within 0.5 % of an independent section table, and of the design.',
      check: (ctx) => tonnageCheck(intent, ctx),
    },
  ];
}
