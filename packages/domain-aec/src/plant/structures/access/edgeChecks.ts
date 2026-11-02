/**
 * Open edges of slabs and grating panels (06 STA §5.8): the drop to the next surface below against a threshold the caller supplies; an edge is
 * protected by guard walls and by railings (M3) that cover it.
 */

import type { CadDocument, Vec2 } from '@core/model/types';
import { toMm } from '@core/model/units';
import { pointInPolygon } from '@lib/polygon';
import type { BuildingModel } from '@aec/building/types';
import { elementsOf } from '@aec/building/model';
import { remediationOf } from '../codes';
import { ruleById, type RulesetName } from '../rules/ruleTable';
import { guardedSegments } from '../railing/railingLayout';
import type { Finding } from './finding';

/** Drop samples along an edge: every <= 250 mm, the first and last inset by 5 mm so that a curved neighbour (a sector panel) still contains the end samples; at most 200. */
const SAMPLE_STEP_MM = 250;
const END_INSET_MM = 5;
const MAX_SAMPLES = 200;

/** Parameters t in (0, 1) of the drop samples of an edge of `lengthMm`. */
function sampleParameters(lengthMm: number): number[] {
  const inset = Math.min(END_INSET_MM, lengthMm / 4) / lengthMm;
  const intervals = Math.min(MAX_SAMPLES - 1, Math.max(1, Math.ceil(lengthMm / SAMPLE_STEP_MM)));
  return Array.from({ length: intervals + 1 }, (_, index) => inset + ((1 - 2 * inset) * index) / intervals);
}
/** Sample offset outward from the edge, mm (§5.8). */
const SAMPLE_OFFSET_MM = 100;
/** A surface within this height of the slab top is a continuation of it, mm. */
const SAME_SURFACE_MM = 1;
/** Share of the edge length a wall must cover to protect it. */
const COVERAGE = 0.99;
/** An edge point may sit this far inside the shell circle (chord of a discretised arc), mm. */
const SHELL_TOLERANCE_MM = 10;
/** Railing runs are cut into pieces of at most this length before the offset test, so a curved railing (chords) is judged along its length, mm. */
const RAILING_PIECE_MM = 250;

/** A railing stands on the surface when its path is this close to the surface top, mm. */
const RAILING_Z_MM = 50;
/** A railing covers an edge when its path runs within this distance of the edge line, mm. */
const RAILING_OFFSET_MM = 150;

/**
 * Height a wall top or a railing must reach above the surface to guard an edge: the strictest top-rail minimum of the requested rulesets
 * (grade A rows ISO-GRD-TOP 1100 mm, OSHA-GRD-TOP 990.6 mm), mm.
 */
const guardHeightMm = (rulesets: readonly RulesetName[]): number =>
  Math.max(0, ...rulesets.map((ruleset) => ruleById(ruleset === 'iso_14122' ? 'ISO-GRD-TOP' : 'OSHA-GRD-TOP').min ?? 0));

/**
 * Largest clear opening a guard-rail may leave between rails (grade A rows ISO-GRD-GAP 500 mm, OSHA-GRD-MID 19 in): the strictest of the requested
 * rulesets. A gap between a walking surface and a vessel shell no wider than this is treated like the space between two rails.
 */
const guardOpeningMm = (rulesets: readonly RulesetName[]): number =>
  Math.min(
    ...rulesets.map((ruleset) => (ruleset === 'iso_14122' ? ruleById('ISO-GRD-GAP').max : ruleById('OSHA-GRD-MID').maxOpening) ?? Infinity),
  );

type Ring = readonly Vec2[];

interface Surface {
  readonly levelId: string;
  readonly ring: Ring;
  readonly holes: readonly Ring[];
  readonly topMm: number;
}

interface GuardWall {
  readonly levelId: string;
  readonly start: Vec2;
  readonly end: Vec2;
  readonly halfThicknessMm: number;
  readonly topMm: number;
}

/** A guarded stretch of a railing: plan end points and absolute height of the walking surface it stands on, mm. */
interface GuardRun {
  readonly a: Vec2;
  readonly b: Vec2;
  readonly zMm: number;
  readonly heightMm: number;
}

/** A vertical vessel: its shell closes the gap to a walking surface that stands within `guardMm` of it. */
interface Shell {
  readonly centre: Vec2;
  readonly radiusMm: number;
  readonly baseMm: number;
  readonly topMm: number;
}

interface Scene {
  readonly surfaces: ReadonlyMap<string, Surface>;
  readonly shells: readonly Shell[];
  /** Largest clear opening a guard-rail may leave (strictest of the requested rulesets), mm. */
  readonly openingMm: number;
  readonly groundMm: number;
  readonly walls: readonly GuardWall[];
  readonly railings: readonly GuardRun[];
  readonly guardMm: number;
}

export interface EdgeReport {
  readonly surfaceId: string;
  readonly location: string;
  readonly lengthMm: number;
  readonly dropMm: number;
  readonly protected: boolean;
}

export interface EdgeResult {
  readonly findings: Finding[];
  readonly edges: EdgeReport[];
}

export interface EdgeThreshold {
  readonly mm: number;
  readonly source: string | undefined;
}

function buildScene(doc: CadDocument, building: BuildingModel, rulesets: readonly RulesetName[]): Scene {
  const mm = (ring: Ring): Ring => ring.map(([x, y]): Vec2 => [toMm(doc, x), toMm(doc, y)]);
  const surfaces = new Map<string, Surface>();
  for (const slab of elementsOf(building, 'slab')) {
    const level = building.levels[slab.levelId];
    if (level === undefined) continue;
    const holes = (slab.openings ?? []).map(mm);
    surfaces.set(slab.id, { levelId: slab.levelId, ring: mm(slab.boundary), holes, topMm: toMm(doc, level.elevation + slab.offset) });
  }
  for (const grating of elementsOf(building, 'grating')) {
    const level = building.levels[grating.levelId];
    if (level === undefined) continue;
    surfaces.set(grating.id, {
      levelId: grating.levelId,
      ring: mm(grating.boundary),
      holes: [],
      topMm: toMm(doc, level.elevation + grating.topOffset),
    });
  }
  const railings = elementsOf(building, 'railing').flatMap((railing): GuardRun[] => {
    const level = building.levels[railing.levelId];
    if (level === undefined || railing.role !== 'guardrail') return [];
    return guardedSegments(railing.path, railing.openings).flatMap(([p, q]) => {
      const pieces = Math.max(1, Math.ceil(toMm(doc, Math.hypot(q[0] - p[0], q[1] - p[1])) / RAILING_PIECE_MM));
      return Array.from({ length: pieces }, (_, index): GuardRun => {
        const at = (t: number): Vec2 => [toMm(doc, p[0] + (q[0] - p[0]) * t), toMm(doc, p[1] + (q[1] - p[1]) * t)];
        return {
          a: at(index / pieces),
          b: at((index + 1) / pieces),
          zMm: toMm(doc, level.elevation + (p[2] + q[2]) / 2),
          heightMm: toMm(doc, railing.height),
        };
      });
    });
  });
  const walls = elementsOf(building, 'wall').flatMap((wall): GuardWall[] => {
    const level = building.levels[wall.levelId];
    if (level === undefined) return [];
    const [start, end] = mm([wall.start, wall.end]) as [Vec2, Vec2];
    return [
      {
        levelId: wall.levelId,
        start,
        end,
        halfThicknessMm: toMm(doc, wall.thickness) / 2,
        topMm: toMm(doc, level.elevation + wall.baseOffset + wall.height),
      },
    ];
  });
  const shells = elementsOf(building, 'equipment').flatMap((equipment): Shell[] => {
    const level = building.levels[equipment.levelId];
    if (level === undefined || equipment.shape !== 'vertical_vessel') return [];
    return [
      {
        centre: [toMm(doc, equipment.location[0]), toMm(doc, equipment.location[1])],
        radiusMm: toMm(doc, equipment.size[0]) / 2,
        baseMm: toMm(doc, level.elevation),
        topMm: toMm(doc, level.elevation + equipment.size[2]),
      },
    ];
  });
  const elevations = Object.values(building.levels).map((level) => toMm(doc, level.elevation));
  return {
    surfaces,
    shells,
    openingMm: guardOpeningMm(rulesets),
    groundMm: elevations.length === 0 ? 0 : Math.min(...elevations),
    walls,
    railings,
    guardMm: guardHeightMm(rulesets),
  };
}

const onSurface = (surface: Surface, point: Vec2): boolean =>
  pointInPolygon(point, surface.ring) && !surface.holes.some((hole) => pointInPolygon(point, hole));

/** Drop from `topMm` at `point` to the highest other surface at or below it (the ground when none). */
function dropAt(scene: Scene, self: string, topMm: number, point: Vec2): number {
  let below = scene.groundMm;
  for (const [id, surface] of scene.surfaces) {
    if (id !== self && surface.topMm <= topMm + SAME_SURFACE_MM && surface.topMm > below && onSurface(surface, point))
      below = surface.topMm;
  }
  return Math.max(0, topMm - below);
}

/** Share of the edge `a`-`b` covered by guard walls of the surface's level and by guard-rail runs standing on it. */
function guardCoverage(scene: Scene, surface: Surface, a: Vec2, b: Vec2): number {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const ux = (b[0] - a[0]) / length;
  const uy = (b[1] - a[1]) / length;
  const across = (p: Vec2): number => Math.abs((p[0] - a[0]) * uy - (p[1] - a[1]) * ux);
  const along = (p: Vec2): number => (p[0] - a[0]) * ux + (p[1] - a[1]) * uy;
  const clipped = (p: Vec2, q: Vec2): [number, number] => [
    Math.max(0, Math.min(along(p), along(q))),
    Math.min(length, Math.max(along(p), along(q))),
  ];
  const wallSpans = scene.walls
    .filter((wall) => wall.levelId === surface.levelId && wall.topMm - surface.topMm >= scene.guardMm)
    .filter((wall) => Math.max(across(wall.start), across(wall.end)) <= wall.halfThicknessMm + SAME_SURFACE_MM)
    .map((wall) => clipped(wall.start, wall.end));
  const railingSpans = scene.railings
    .filter((run) => run.heightMm >= scene.guardMm && Math.abs(run.zMm - surface.topMm) <= RAILING_Z_MM)
    .filter((run) => Math.max(across(run.a), across(run.b)) <= RAILING_OFFSET_MM)
    .map((run) => clipped(run.a, run.b));
  const spans = [...wallSpans, ...railingSpans].filter(([from, to]) => to > from).sort((p, q) => p[0] - q[0]);
  let covered = 0;
  let reached = 0;
  for (const [from, to] of spans) {
    if (to <= reached) continue;
    covered += to - Math.max(from, reached);
    reached = to;
  }
  return covered / length;
}

/** True when a vessel shell standing from below the surface up to the guard height above it is within the guard opening of the whole edge `a`-`b`. */
function shellCloses(scene: Scene, surface: Surface, a: Vec2, b: Vec2): boolean {
  return scene.shells.some(
    (shell) =>
      shell.baseMm <= surface.topMm &&
      shell.topMm - surface.topMm >= scene.guardMm &&
      [0, 0.5, 1].every((t) => {
        const gap = Math.hypot(a[0] + (b[0] - a[0]) * t - shell.centre[0], a[1] + (b[1] - a[1]) * t - shell.centre[1]) - shell.radiusMm;
        return gap >= -SHELL_TOLERANCE_MM && gap <= scene.openingMm;
      }),
  );
}

const signedArea = (ring: Ring): number =>
  ring.reduce((sum, p, i) => {
    const q = ring[(i + 1) % ring.length] as Vec2;
    return sum + (p[0] * q[1] - q[0] * p[1]);
  }, 0) / 2;

function edgeFinding(id: string, location: string, drop: number, threshold: EdgeThreshold): Finding {
  return {
    code: 'STA_EDGE_UNPROTECTED',
    ruleId: 'PROJECT-EDGE-DROP',
    ruleset: 'project',
    clause: threshold.source ?? 'edgeDropThresholdMm (caller supplied, no source given)',
    severity: 'fail',
    grade: 'A',
    ids: [id],
    measured: { value: drop, unit: 'mm' },
    limit: { max: threshold.mm, unit: 'mm' },
    remediation: remediationOf('STA_EDGE_UNPROTECTED'),
    source: threshold.source ?? 'caller',
    location,
  };
}

/** Warning that the edge check was skipped because no threshold was given (AF-31). */
export const edgeRuleUnsetFinding = (): Finding => ({
  code: 'STA_EDGE_RULE_UNSET',
  ruleId: 'PROJECT-EDGE-DROP',
  ruleset: 'project',
  clause: 'edgeDropThresholdMm',
  severity: 'warn',
  grade: 'B',
  ids: [],
  measured: { value: 0, unit: 'mm' },
  limit: { unit: 'mm' },
  remediation: remediationOf('STA_EDGE_RULE_UNSET'),
  source: 'none: there is no graded drop-height rule (06 STA open question 6)',
});

/** Edges of one slab or grating (boundary and openings) against the threshold. */
function surfaceEdges(scene: Scene, id: string, threshold: EdgeThreshold): EdgeResult {
  const surface = scene.surfaces.get(id);
  const findings: Finding[] = [];
  const edges: EdgeReport[] = [];
  if (surface === undefined) return { findings, edges };
  const rings = [
    { label: 'boundary', ring: surface.ring, hole: false },
    ...surface.holes.map((ring, index) => ({ label: `opening ${index}`, ring, hole: true })),
  ];
  for (const { label, ring, hole } of rings) {
    const outward = signedArea(ring) > 0 !== hole ? 1 : -1;
    ring.forEach((a, index) => {
      const b = ring[(index + 1) % ring.length] as Vec2;
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (length === 0) return;
      const nx = (outward * (b[1] - a[1])) / length;
      const ny = (-outward * (b[0] - a[0])) / length;
      const sample = (t: number): Vec2 => [
        a[0] + (b[0] - a[0]) * t + nx * SAMPLE_OFFSET_MM,
        a[1] + (b[1] - a[1]) * t + ny * SAMPLE_OFFSET_MM,
      ];
      const drop = Math.max(...sampleParameters(length).map((t) => dropAt(scene, id, surface.topMm, sample(t))));
      const guarded = drop > threshold.mm && (shellCloses(scene, surface, a, b) || guardCoverage(scene, surface, a, b) >= COVERAGE);
      const isProtected = drop <= threshold.mm || guarded;
      const location = `${label} edge ${index}`;
      edges.push({ surfaceId: id, location, lengthMm: length, dropMm: drop, protected: isProtected });
      if (!isProtected) findings.push(edgeFinding(id, location, drop, threshold));
    });
  }
  return { findings, edges };
}

/** Open-edge check of the slabs and gratings `ids`; the scene is the whole building so adjacent and lower surfaces count. */
export function checkEdges(
  doc: CadDocument,
  building: BuildingModel,
  ids: readonly string[],
  threshold: EdgeThreshold,
  rulesets: readonly RulesetName[],
): EdgeResult {
  const scene = buildScene(doc, building, rulesets);
  const parts = ids.map((id) => surfaceEdges(scene, id, threshold));
  return { findings: parts.flatMap((part) => part.findings), edges: parts.flatMap((part) => part.edges) };
}
