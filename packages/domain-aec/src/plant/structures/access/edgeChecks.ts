/** Open slab edges (06 STA §5.8, M1): the drop to the next surface below against a threshold the caller supplies. */

import type { CadDocument, Vec2 } from '@core/model/types';
import { toMm } from '@core/model/units';
import { pointInPolygon } from '@lib/polygon';
import type { BuildingModel } from '@aec/building/types';
import { elementsOf } from '@aec/building/model';
import { remediationOf } from '../codes';
import { ruleById } from '../rules/ruleTable';
import type { Finding } from './finding';

/** Sample offset outward from the edge, mm (§5.8). */
const SAMPLE_OFFSET_MM = 100;
/** A surface within this height of the slab top is a continuation of it, mm. */
const SAME_SURFACE_MM = 1;
/** Share of the edge length a wall must cover to protect it. */
const COVERAGE = 0.99;

/** A wall protects an edge when its top is this far above the slab top: the ISO guard-rail minimum (grade A row ISO-GRD-TOP), mm. */
const guardHeightMm = (): number => ruleById('ISO-GRD-TOP').min ?? 0;

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

interface Scene {
  readonly surfaces: ReadonlyMap<string, Surface>;
  readonly groundMm: number;
  readonly walls: readonly GuardWall[];
}

export interface EdgeReport {
  readonly slabId: string;
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

function buildScene(doc: CadDocument, building: BuildingModel): Scene {
  const mm = (ring: Ring): Ring => ring.map(([x, y]): Vec2 => [toMm(doc, x), toMm(doc, y)]);
  const surfaces = new Map<string, Surface>();
  for (const slab of elementsOf(building, 'slab')) {
    const level = building.levels[slab.levelId];
    if (level === undefined) continue;
    const holes = (slab.openings ?? []).map(mm);
    surfaces.set(slab.id, { levelId: slab.levelId, ring: mm(slab.boundary), holes, topMm: toMm(doc, level.elevation + slab.offset) });
  }
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
  const elevations = Object.values(building.levels).map((level) => toMm(doc, level.elevation));
  return { surfaces, groundMm: elevations.length === 0 ? 0 : Math.min(...elevations), walls };
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

/** Share of the edge `a`-`b` covered by guard walls of the slab's level. */
function wallCoverage(scene: Scene, surface: Surface, a: Vec2, b: Vec2): number {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const ux = (b[0] - a[0]) / length;
  const uy = (b[1] - a[1]) / length;
  const across = (p: Vec2): number => Math.abs((p[0] - a[0]) * uy - (p[1] - a[1]) * ux);
  const along = (p: Vec2): number => (p[0] - a[0]) * ux + (p[1] - a[1]) * uy;
  const spans = scene.walls
    .filter((wall) => wall.levelId === surface.levelId && wall.topMm - surface.topMm >= guardHeightMm())
    .filter((wall) => Math.max(across(wall.start), across(wall.end)) <= wall.halfThicknessMm + SAME_SURFACE_MM)
    .map((wall): [number, number] => {
      const [p, q] = [along(wall.start), along(wall.end)];
      return [Math.max(0, Math.min(p, q)), Math.min(length, Math.max(p, q))];
    })
    .sort((p, q) => p[0] - q[0]);
  let covered = 0;
  let reached = 0;
  for (const [from, to] of spans) {
    if (to <= reached) continue;
    covered += to - Math.max(from, reached);
    reached = to;
  }
  return covered / length;
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

/** Edges of one slab (boundary and openings) against the threshold. */
function slabEdges(scene: Scene, id: string, threshold: EdgeThreshold): EdgeResult {
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
      const drop = Math.max(...[0, 0.5, 1].map((t) => dropAt(scene, id, surface.topMm, sample(t))));
      const guarded = drop > threshold.mm && wallCoverage(scene, surface, a, b) >= COVERAGE;
      const isProtected = drop <= threshold.mm || guarded;
      const location = `${label} edge ${index}`;
      edges.push({ slabId: id, location, lengthMm: length, dropMm: drop, protected: isProtected });
      if (!isProtected) findings.push(edgeFinding(id, location, drop, threshold));
    });
  }
  return { findings, edges };
}

/** Open-edge check of the slabs `ids`; the scene is the whole building so adjacent and lower surfaces count. */
export function checkEdges(doc: CadDocument, building: BuildingModel, ids: readonly string[], threshold: EdgeThreshold): EdgeResult {
  const scene = buildScene(doc, building);
  const parts = ids.map((id) => slabEdges(scene, id, threshold));
  return { findings: parts.flatMap((part) => part.findings), edges: parts.flatMap((part) => part.edges) };
}
