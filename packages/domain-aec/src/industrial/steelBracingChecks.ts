/**
 * Bracing of a multi-storey steel structure: EN 1993-1-1 §5.3.2 equivalent horizontal forces
 * (φ × the factored vertical load at each floor level, both directions) accumulate down the storeys;
 * each storey's shear is shared equally by the bracing planes of a direction, and inside a plane by
 * its braced bays. X-bracing is tension-only (one diagonal carries the panel shear / cos θ), a
 * single diagonal also buckles; the chords of a braced bay take the panel shear as a strut force.
 * @layer domain-aec
 * @pure
 */

import { memberBuckling, sectionResistance } from './steelDesign';
import { GAMMA_IMPOSED, GAMMA_PERMANENT, type BeamResult } from './steelFraming';
import type { ColumnSegment } from './steelColumnChecks';
import type { FrameCoverage } from './steelFrameDetect';
import { compressionClass, minorRadius, type SteelBar } from './steelMemberBars';
import { analysedRow, skippedRow, type CheckLine, type MemberRow } from './steelMemberRows';

type Direction = 'X' | 'Y';

/** Beams whose top of steel differs by less than this are one floor level, mm. */
const LEVEL_TOLERANCE = 150;
/** A brace this close to the vertical plane's direction lies in that plane, mm. */
const PLANE_TOLERANCE = 50;
const CHORD_END_TOLERANCE = 150;
const COORDINATE_STEP = 100;
const SLENDERNESS_LIMIT = 300;

export interface StoreyReport {
  /** 1-based storey number from the base. */
  readonly storey: number;
  /** Top of steel of the floor above the storey, mm. */
  readonly topOfSteel: number;
  /** Factored vertical load at that floor level, kN. */
  readonly verticalLoad: number;
  /** φ × Σ vertical load at and above the storey, kN (per direction). */
  readonly shear: number;
  readonly X: { readonly planes: number; readonly bays: number; readonly perBay: number };
  readonly Y: { readonly planes: number; readonly bays: number; readonly perBay: number };
  /** Moment frames stabilising the storey in each direction. */
  readonly frames: { readonly X: number; readonly Y: number };
}

export interface BracingOutcome {
  readonly rows: MemberRow[];
  /** Compression a beam takes as chord of a braced bay, kN. */
  readonly strutForces: Map<string, { force: number; note: string }>;
  readonly storeys: StoreyReport[];
  readonly warnings: string[];
}

interface BraceGeometry {
  readonly bar: SteelBar;
  readonly storey: number;
  readonly direction: Direction;
  /** Plane coordinate (y for X-planes, x for Y-planes), mm. */
  readonly plane: number;
  readonly planeKey: number;
  readonly low: number;
  readonly high: number;
  readonly horizontal: number;
}

/** Label of the notional factor in combination names, e.g. "φ = 1/200". */
export const notionalLabel = (factor: number): string =>
  `φ = ${factor > 0 && Math.round(1 / factor) === 1 / factor ? `1/${1 / factor}` : factor}`;

const snap = (value: number): number => Math.round(value / COORDINATE_STEP) * COORDINATE_STEP;
const metres = (value: number): string => (value / 1000).toFixed(2);

/** Floor levels (top of steel, ascending) of the beams, and the nearest-level lookup. */
function floorLevels(beams: ReadonlyArray<BeamResult>): {
  levels: number[];
  levelOf: (top: number) => number;
} {
  const tops = beams.map((beam) => beam.loads.top).sort((a, b) => a - b);
  const groups: number[][] = [];
  for (const top of tops) {
    const last = groups[groups.length - 1];
    if (last && top - (last[last.length - 1] as number) <= LEVEL_TOLERANCE) last.push(top);
    else groups.push([top]);
  }
  const levels = groups.map((group) => group.reduce((sum, top) => sum + top, 0) / group.length);
  const levelOf = (top: number): number =>
    levels.reduce(
      (best, level, index) =>
        Math.abs(level - top) < Math.abs((levels[best] as number) - top) ? index : best,
      0,
    );
  return { levels, levelOf };
}

function geometryOf(bar: SteelBar, storey: number): BraceGeometry | undefined {
  const dx = bar.end[0] - bar.start[0];
  const dy = bar.end[1] - bar.start[1];
  if (Math.abs(dy) <= PLANE_TOLERANCE) {
    const plane = (bar.start[1] + bar.end[1]) / 2;
    const [low, high] = [Math.min(bar.start[0], bar.end[0]), Math.max(bar.start[0], bar.end[0])];
    return {
      bar,
      storey,
      direction: 'X',
      plane,
      planeKey: snap(plane),
      low,
      high,
      horizontal: Math.abs(dx),
    };
  }
  if (Math.abs(dx) <= PLANE_TOLERANCE) {
    const plane = (bar.start[0] + bar.end[0]) / 2;
    const [low, high] = [Math.min(bar.start[1], bar.end[1]), Math.max(bar.start[1], bar.end[1])];
    return {
      bar,
      storey,
      direction: 'Y',
      plane,
      planeKey: snap(plane),
      low,
      high,
      horizontal: Math.abs(dy),
    };
  }
  return undefined;
}

function braceRow(
  geometry: BraceGeometry,
  panelShear: number,
  crossing: boolean,
  phiText: string,
): MemberRow {
  const { bar } = geometry;
  const profile = bar.profile;
  if (!profile) return skippedRow(bar, bar.skipReason ?? 'profile not in the catalogue');
  const combination = `ULS 1.35 G + 1.5 Q + notional horizontal force ${phiText} (${geometry.direction})`;
  const force = (panelShear * bar.length) / geometry.horizontal;
  const resistance = sectionResistance(profile, bar.fy);
  const lines: CheckLine[] = [
    {
      name: 'tension (§6.2.3)',
      utilisation: (force * 1000) / resistance.axial,
      combination,
      detail: `${profile.name}: N ${force.toFixed(1)} kN ≤ Npl,Rd ${(resistance.axial / 1000).toFixed(0)} kN (panel shear ${panelShear.toFixed(1)} kN, L ${metres(bar.length)} m, ${crossing ? 'tension-only X' : 'single diagonal'})`,
    },
    {
      name: `slenderness (λ ≤ ${SLENDERNESS_LIMIT})`,
      utilisation: bar.length / minorRadius(profile) / SLENDERNESS_LIMIT,
      combination: 'geometry',
      detail: `${profile.name}: λ = ${(bar.length / minorRadius(profile)).toFixed(0)} (L ${metres(bar.length)} m)`,
    },
  ];
  if (!crossing) {
    const sectionClass = compressionClass(profile, bar.fy);
    if (sectionClass === null || sectionClass === 4) {
      return skippedRow(
        bar,
        `${profile.name}: single diagonal also acts in compression and its class ${sectionClass ?? 'is not covered'} cannot be verified`,
      );
    }
    const buckling = memberBuckling(profile, bar.fy, force * 1000, 0, {
      major: bar.length,
      minor: bar.length,
    });
    lines.push({
      name: 'flexural buckling (§6.3.1)',
      utilisation: buckling.utilisation,
      combination,
      detail: `${profile.name}: N ${force.toFixed(1)} kN in compression, χ ${Math.min(buckling.chiMajor, buckling.chiMinor).toFixed(2)}, Lcr ${metres(bar.length)} m`,
    });
  }
  return analysedRow(bar, lines, { NEd: force, panelShear });
}

/**
 * Brace rows, strut forces and the storey shear table.
 * @invariant storey shear = φ × Σ factored vertical loads of the floor levels at / above the storey
 */
export function checkBracing(
  braces: ReadonlyArray<SteelBar>,
  beams: ReadonlyArray<BeamResult>,
  columnSegments: ReadonlyArray<ColumnSegment>,
  notionalFactor: number,
  frames: ReadonlyArray<FrameCoverage> = [],
): BracingOutcome {
  const { levels, levelOf } = floorLevels(beams);
  const warnings: string[] = [];
  const strutForces = new Map<string, { force: number; note: string }>();
  const phiText = notionalLabel(notionalFactor);
  if (levels.length === 0) {
    return {
      rows: braces.map((brace) =>
        skippedRow(
          brace,
          'no floor beams: the storey load that drives the bracing cannot be derived',
        ),
      ),
      strutForces,
      storeys: [],
      warnings,
    };
  }
  const levelLoad = levels.map(() => 0);
  for (const { loads } of beams) {
    const index = levelOf(loads.top);
    levelLoad[index] =
      (levelLoad[index] ?? 0) +
      GAMMA_PERMANENT * loads.directPermanent +
      GAMMA_IMPOSED * loads.directImposed;
  }
  for (const segment of columnSegments) {
    const index = levelOf(segment.to);
    levelLoad[index] = (levelLoad[index] ?? 0) + GAMMA_PERMANENT * segment.weight;
  }
  const shearOf = (storey: number): number =>
    notionalFactor * levelLoad.slice(storey).reduce((sum, load) => sum + load, 0);
  const geometries: BraceGeometry[] = [];
  const rows: MemberRow[] = [];
  for (const brace of braces) {
    const middle = (brace.start[2] + brace.end[2]) / 2;
    const storey = Math.min(levels.length - 1, levels.filter((level) => level <= middle).length);
    const geometry = geometryOf(brace, storey);
    if (geometry) geometries.push(geometry);
    else rows.push(skippedRow(brace, 'brace is not in a vertical plane parallel to X or Y'));
  }
  const key = (g: BraceGeometry): string => `${g.storey}|${g.direction}|${g.planeKey}`;
  const bayKey = (g: BraceGeometry): string => `${key(g)}|${snap(g.low)}|${snap(g.high)}`;
  const count = (keys: ReadonlyArray<string>): Map<string, number> =>
    keys.reduce((map, k) => map.set(k, (map.get(k) ?? 0) + 1), new Map<string, number>());
  const diagonals = count(geometries.map(bayKey));
  const bays = new Map<string, Set<string>>();
  const planes = new Map<string, Set<number>>();
  for (const g of geometries) {
    bays.set(key(g), (bays.get(key(g)) ?? new Set<string>()).add(bayKey(g)));
    const slot = `${g.storey}|${g.direction}`;
    planes.set(slot, (planes.get(slot) ?? new Set<number>()).add(g.planeKey));
  }
  const panelShearOf = (g: BraceGeometry): number => {
    const planeCount = planes.get(`${g.storey}|${g.direction}`)?.size ?? 1;
    const bayCount = bays.get(key(g))?.size ?? 1;
    return shearOf(g.storey) / planeCount / bayCount;
  };
  for (const g of geometries) {
    const shear = panelShearOf(g);
    rows.push(braceRow(g, shear, (diagonals.get(bayKey(g)) ?? 1) >= 2, phiText));
    const note = `chord of the braced bay ${g.direction}-plane ${metres(g.plane)} m, storey ${g.storey + 1}`;
    for (const { loads } of beams) {
      const level = levelOf(loads.top);
      if (level !== g.storey && level !== g.storey - 1) continue;
      const along: 0 | 1 = g.direction === 'X' ? 0 : 1;
      const across: 0 | 1 = along === 0 ? 1 : 0;
      const onPlane =
        Math.abs(loads.a[across] - g.plane) <= COORDINATE_STEP &&
        Math.abs(loads.b[across] - g.plane) <= COORDINATE_STEP;
      const [low, high] = [
        Math.min(loads.a[along], loads.b[along]),
        Math.max(loads.a[along], loads.b[along]),
      ];
      if (!onPlane || low > g.low + CHORD_END_TOLERANCE || high < g.high - CHORD_END_TOLERANCE)
        continue;
      const previous = strutForces.get(loads.bar.id);
      if (!previous || previous.force < shear)
        strutForces.set(loads.bar.id, { force: shear, note });
    }
  }
  const storeys: StoreyReport[] = levels.map((level, storey) => {
    const share = (direction: Direction): StoreyReport['X'] => {
      const slot = planes.get(`${storey}|${direction}`)?.size ?? 0;
      const total = [...bays.entries()]
        .filter(([k]) => k.startsWith(`${storey}|${direction}|`))
        .reduce((sum, [, set]) => sum + set.size, 0);
      return {
        planes: slot,
        bays: total,
        perBay: slot === 0 || total === 0 ? 0 : shearOf(storey) / total,
      };
    };
    const framed = (direction: Direction): number =>
      frames.filter(
        (frame) =>
          frame.direction === direction && frame.beamTops.some((top) => levelOf(top) >= storey),
      ).length;
    return {
      storey: storey + 1,
      topOfSteel: level,
      verticalLoad: levelLoad[storey] ?? 0,
      shear: shearOf(storey),
      X: share('X'),
      Y: share('Y'),
      frames: { X: framed('X'), Y: framed('Y') },
    };
  });
  for (const report of storeys) {
    for (const direction of ['X', 'Y'] as const) {
      if (report[direction].planes > 0 || report.frames[direction] > 0) continue;
      warnings.push(
        `storey ${report.storey} (below +${metres(report.topOfSteel)} m): no bracing in direction ${direction}, ` +
          `its notional force ${report.shear.toFixed(1)} kN must be carried by frame action (not verified)`,
      );
    }
  }
  return { rows, strutForces, storeys, warnings };
}
