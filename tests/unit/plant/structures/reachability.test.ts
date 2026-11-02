/**
 * Plant 06 STA M8 (VC-STA-11): the access graph (`access_graph`), `check_reachability`, the egress / width / headroom part of `check_access`, the
 * `access` schedule. Hand numbers from SC-STA-07: vessel D 3000, gap 150, width 1000 -> platform radii 1650..2650 at +6000; a point at plan radius 2200
 * and z 6900 is 900 mm above it; the ladder at [2150, -250, 0] climbs 6000.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { BuildingModel, SlabElement } from '@aec/building/types';
import { GRAPH_LIMITS } from '@aec/plant/structures/access/graph/types';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { gratedFrame, rect } from './accessFixtures';
import { structuresPlans } from '../../../golden/structuresPlans';

const BAND = { min: 0, max: 1800, source: 'project rule (owner supplied)' };
const PACK = {
  equipmentId: 'equipment-1',
  elevation: 6000,
  startAngleDeg: 0,
  sweepDeg: 180,
  gap: 150,
  width: 1000,
  railing: { edges: ['outer', 'ends'], height: 1100 },
};
const LADDER = { base: [2150, -250, 0], facing: [0, 1], attachTo: 'assembly-1', exit: 'through', fallProtection: 'cage' };

interface Target {
  tag: string;
  ok: boolean;
  surfaceId: string | null;
  heightAboveSurfaceMm: number | null;
  reachMm: number | null;
  connected: boolean | null;
  route: string[] | null;
  legs: Array<{ kind: string; id: string; clearWidthMm: number | null }> | null;
  candidates: number;
  findings: Array<{ code: string; severity: string; measured: { value: number; unit: string }; ids: string[]; location?: string }>;
}
interface Reach {
  verdict: string;
  targets: Target[];
  findings: Array<{ code: string }>;
  unreachableSurfaces: string[];
  graph: { surfaces: number; edges: number; connectors: number; dangling: Array<{ elementId: string; reason: string }> };
  operatingHeight: { source: string };
  notEvaluated: string[];
  reviewRequired: boolean;
  sourceSkippedRuns: unknown[];
}

/** SC-STA-07 without the check: grade level, vessel, half-round platform at +6000, caged ladder from grade. */
function plantDoc(withLadder = true): CadDocument {
  let doc = apply(createEmptyDocument(), 'set_units', { units: 'mm' });
  doc = apply(doc, 'add_level', { name: 'Grade', elevation: 0, height: 6000 });
  doc = apply(doc, 'add_equipment', {
    name: 'Column',
    mark: 'C-101',
    location: [0, 0],
    size: [3000, 3000, 18000],
    shape: 'vertical_vessel',
  });
  doc = apply(doc, 'add_circular_access_platform', PACK);
  return withLadder ? apply(doc, 'add_ladder', LADDER) : doc;
}

const reach = (doc: CadDocument, extra: Record<string, unknown> = {}): Reach =>
  data<Reach>(doc, 'check_reachability', {
    targets: [{ tag: 'HV-101', kind: 'valve_handwheel', point: [0, 2200, 6900] }],
    operatingHeightMm: BAND,
    maxHorizontalReachMm: 600,
    ...extra,
  });
const target = (answer: Reach, tag: string): Target => {
  const found = answer.targets.find((item) => item.tag === tag);
  if (found === undefined) throw new Error(`no target ${tag}`);
  return found;
};

describe('access_graph: nodes, edges, routes', () => {
  const doc = plantDoc();
  const graph = data<{
    gradeElevationMm: number;
    surfaces: Array<{
      id: string;
      kind: string;
      connected: boolean;
      hops: number | null;
      route: string[] | null;
      topMm: number;
      areaM2: number;
      members: string[];
    }>;
    connectors: Array<{ id: string; kind: string; from: string; to: string; clearWidthMm: number; riseMm: number }>;
    dangling: unknown[];
    unreachable: string[];
  }>(doc, 'access_graph', {});

  it('the platform is one node (6 panels), the ladder one edge grade -> platform with its width and rise', () => {
    expect(graph.gradeElevationMm).toBe(0);
    expect(graph.surfaces).toHaveLength(1);
    const platform = graph.surfaces[0];
    expect(platform).toMatchObject({
      id: 'assembly-1',
      kind: 'circular_platform',
      connected: true,
      hops: 1,
      route: ['grade', 'ladder-1', 'assembly-1'],
      topMm: 6000,
    });
    // 180 degrees in 8 degree bays (no bracketSpacingMax): ceil(22.5) = 23 grating panels, one node.
    expect(platform?.members).toHaveLength(23);
    expect(Math.abs((platform?.areaM2 ?? 0) - 6.754424) / 6.754424).toBeLessThan(0.002);
    expect(graph.connectors).toEqual([
      { id: 'ladder-1', kind: 'ladder', mark: 'LD1', from: 'grade', to: 'assembly-1', clearWidthMm: 406.4, riseMm: 6000 },
    ]);
    expect(graph.dangling).toEqual([]);
    expect(graph.unreachable).toEqual([]);
  });

  it('without the ladder the platform has no route', () => {
    const lonely = data<typeof graph>(plantDoc(false), 'access_graph', {});
    expect(lonely.surfaces[0]).toMatchObject({ connected: false, hops: null, route: null });
    expect(lonely.unreachable).toEqual(['assembly-1']);
    expect(lonely.connectors).toEqual([]);
  });

  it('surfaceIds lists only the named surface; an unknown id (or grade) is STA_UNKNOWN_ELEMENT', () => {
    expect(data<typeof graph>(doc, 'access_graph', { surfaceIds: ['assembly-1'] }).surfaces).toHaveLength(1);
    expectRefusal(doc, 'access_graph', { surfaceIds: ['nope'] }, 'STA_UNKNOWN_ELEMENT', 'surfaceIds');
    expectRefusal(doc, 'access_graph', { surfaceIds: ['grade'] }, 'STA_UNKNOWN_ELEMENT', 'surfaceIds');
  });

  it('a ladder whose arrival surface was removed is listed as dangling with the reason, never silent', () => {
    let deck = apply(apply(createEmptyDocument(), 'set_units', { units: 'mm' }), 'add_level', {
      name: 'Grade',
      elevation: 0,
      height: 4000,
    });
    deck = apply(deck, 'add_level', { name: '+4000', elevation: 4000, height: 3000 });
    const upper = Object.keys(deck.building?.levels ?? {})[1] as string;
    const slab = ok(deck, 'add_slab', { boundary: rect(0, 0, 3000, 2000), thickness: 30, levelId: upper });
    const withLadder = apply(slab.document, 'add_ladder', {
      base: [1500, -250, 0],
      facing: [0, 1],
      attachTo: slab.affected[0],
      levelId: Object.keys(deck.building?.levels ?? {})[0],
    });
    const connected = data<typeof graph>(withLadder, 'access_graph', {});
    expect(connected.surfaces[0]).toMatchObject({ connected: true, route: ['grade', 'ladder-1', 'slab-1'] });
    const removed = apply(withLadder, 'delete_building_element', { elementIds: ['slab-1'] });
    const broken = data<typeof graph>(removed, 'access_graph', {});
    expect(broken.dangling).toEqual([{ elementId: 'ladder-1', mark: 'LD1', kind: 'ladder', reason: expect.stringContaining('its top') }]);
    expect(broken.connectors).toEqual([]);
  });

  it('is read-only and pure', () => {
    expectPure(doc, () => execute(doc, 'access_graph', {}));
    expect(execute(doc, 'access_graph', {}).document).toBe(doc);
  });
});

describe('access_graph: touching surfaces, slabs, stairs', () => {
  it('grating panels laid on grade stand on grade and touch each other: all connected, no connector', () => {
    const { doc, ids } = gratedFrame();
    const graph = data<{ surfaces: Array<{ id: string; connected: boolean; route: string[] }>; connectors: unknown[] }>(
      doc,
      'access_graph',
      {},
    );
    expect(graph.surfaces.map((surface) => surface.id)).toEqual(ids);
    expect(graph.surfaces.every((surface) => surface.connected)).toBe(true);
    expect(graph.surfaces[0]?.route).toEqual(['grade', ids[0]]);
    expect(graph.connectors).toEqual([]);
  });

  it('a steel stair joins grade to a deck: route grade > stair > slab, with the stair width', () => {
    let doc = apply(apply(createEmptyDocument(), 'set_units', { units: 'mm' }), 'add_level', { name: 'Grade', elevation: 0, height: 3000 });
    doc = apply(doc, 'add_level', { name: '+3000', elevation: 3000, height: 3000 });
    const [grade, upper] = Object.keys(doc.building?.levels ?? {}) as [string, string];
    const slab = ok(doc, 'add_slab', { boundary: rect(0, 0, 3000, 2000), thickness: 30, levelId: upper });
    const stair = apply(slab.document, 'add_steel_stair', {
      start: [-4480, 1000, 0],
      angle: 0,
      toSurfaceId: slab.affected[0],
      riserMax: 180,
      going: 280,
      levelId: grade,
    });
    const graph = data<{
      surfaces: Array<{ route: string[] | null }>;
      connectors: Array<{ kind: string; clearWidthMm: number; riseMm: number }>;
    }>(stair, 'access_graph', {});
    expect(graph.surfaces[0]?.route).toEqual(['grade', 'steelStair-1', 'slab-1']);
    expect(graph.connectors[0]).toMatchObject({ kind: 'stair', clearWidthMm: 800, riseMm: 3000 });
  });

  it('a concrete stair joins the floor of its level to the next: the upper slab is reached from grade (the lower slab stands on grade)', () => {
    let doc = apply(apply(createEmptyDocument(), 'set_units', { units: 'mm' }), 'add_level', { name: 'Grade', elevation: 0, height: 3000 });
    doc = apply(doc, 'add_level', { name: '+3000', elevation: 3000, height: 3000 });
    const [grade, upper] = Object.keys(doc.building?.levels ?? {}) as [string, string];
    doc = apply(doc, 'add_slab', { boundary: rect(0, 0, 8000, 4000), thickness: 200, levelId: grade });
    doc = apply(doc, 'add_slab', { boundary: rect(0, 0, 8000, 4000), thickness: 200, levelId: upper });
    doc = apply(doc, 'add_stair', { start: [1000, 1000], angle: 0, width: 1200, riserCount: 17, treadDepth: 280, levelId: grade });
    const graph = data<{ surfaces: Array<{ id: string; route: string[] | null }> }>(doc, 'access_graph', {});
    expect(graph.surfaces.map((surface) => surface.route)).toEqual([
      ['grade', 'slab-1'],
      ['grade', 'stair-1', 'slab-2'],
    ]);
  });

  it('a slab that is not a floor (roof, foundation) is not a walking surface', () => {
    let doc = apply(apply(createEmptyDocument(), 'set_units', { units: 'mm' }), 'add_level', { name: 'Grade', elevation: 0, height: 3000 });
    doc = apply(doc, 'add_slab', { boundary: rect(0, 0, 3000, 2000), thickness: 200, role: 'roof' });
    expect(data<{ surfaces: unknown[] }>(doc, 'access_graph', {}).surfaces).toEqual([]);
  });

  it('a model without a level has no grade: STA_NO_GRADE', () => {
    expectRefusal(createEmptyDocument(), 'access_graph', {}, 'STA_NO_GRADE');
  });
});

describe('check_reachability: SC-STA-07 (VC-STA-11)', () => {
  const doc = plantDoc();
  const answer = reach(doc, {
    targets: [
      { tag: 'HV-101', kind: 'valve_handwheel', point: [0, 2200, 6900] },
      { tag: 'HV-102', kind: 'valve_handwheel', point: [0, 2200, 9500] },
      { tag: 'PI-103', kind: 'instrument', point: [3500, 0, 1200] },
    ],
    gradeIsWalkable: true,
  });

  it('HV-101 is operated from the platform 900 mm above it, route grade > ladder > platform', () => {
    const valve = target(answer, 'HV-101');
    expect(valve).toMatchObject({
      ok: true,
      surfaceId: 'assembly-1',
      connected: true,
      route: ['grade', 'ladder-1', 'assembly-1'],
      findings: [],
    });
    expect(valve.heightAboveSurfaceMm).toBeCloseTo(900, 6);
    expect(valve.reachMm).toBe(0);
    expect(valve.legs).toEqual([{ kind: 'ladder', id: 'ladder-1', from: 'grade', to: 'assembly-1', clearWidthMm: 406.4 }]);
  });

  it('HV-102 (9500) is 3500 mm above the platform: STA_OPERATING_HEIGHT with the band as the limit', () => {
    const valve = target(answer, 'HV-102');
    expect(valve.ok).toBe(false);
    expect(valve.findings[0]).toMatchObject({
      code: 'STA_OPERATING_HEIGHT',
      severity: 'fail',
      measured: { value: 3500 },
      limit: { min: 0, max: 1800 },
      ids: ['assembly-1'],
      location: 'target HV-102',
    });
  });

  it('PI-103 is 1200 mm above grade (the platform is above it and out of reach)', () => {
    expect(target(answer, 'PI-103')).toMatchObject({
      ok: true,
      surfaceId: 'grade',
      heightAboveSurfaceMm: 1200,
      route: ['grade'],
      legs: [],
    });
  });

  it('echoes the band source, names what it does not model and always asks for review', () => {
    expect(answer.operatingHeight.source).toBe('project rule (owner supplied)');
    expect(answer.verdict).toBe('fail');
    expect(answer.reviewRequired).toBe(true);
    expect(answer.notEvaluated.length).toBeGreaterThanOrEqual(3);
    expect(answer.graph).toMatchObject({ surfaces: 1, connectors: 1, dangling: [] });
    expect(answer.findings.map((finding) => finding.code)).toEqual(['STA_OPERATING_HEIGHT']);
  });

  it('without the ladder HV-101 stands on a platform with no route: STA_ACCESS_NO_EGRESS', () => {
    const lonely = target(reach(plantDoc(false)), 'HV-101');
    expect(lonely.connected).toBe(false);
    expect(lonely.route).toBeNull();
    expect(lonely.findings.map((finding) => finding.code)).toEqual(['STA_ACCESS_NO_EGRESS']);
    expect(lonely.findings[0]).toMatchObject({ severity: 'fail', measured: { value: 0, unit: 'routes to grade' }, ids: ['assembly-1'] });
  });

  it('prefers the connected surface inside the band to a higher unconnected one', () => {
    const second = apply(doc, 'add_circular_access_platform', { ...PACK, elevation: 6500, gap: 150 });
    const valve = target(reach(second), 'HV-101');
    expect(valve.surfaceId).toBe('assembly-1');
    expect(valve.candidates).toBe(3);
    expect(valve.ok).toBe(true);
  });

  it('is read-only and pure; running twice gives the same answer', () => {
    expectPure(doc, () =>
      execute(doc, 'check_reachability', {
        targets: [{ tag: 'A', kind: 'x', point: [0, 0, 0] }],
        operatingHeightMm: BAND,
        maxHorizontalReachMm: 0,
      }),
    );
    expect(JSON.stringify(reach(doc))).toBe(JSON.stringify(reach(doc)));
  });
});

describe('check_reachability: reach, grade, units', () => {
  const doc = plantDoc();

  it('a point beyond maxHorizontalReachMm of every surface below it is STA_REACH with the plan distance', () => {
    const far = target(reach(doc, { targets: [{ tag: 'T', kind: 'x', point: [0, 4000, 6900] }], gradeIsWalkable: false }), 'T');
    expect(far.findings.map((finding) => finding.code)).toEqual(['STA_REACH']);
    expect(far.findings[0]?.measured.value).toBeGreaterThan(1300);
    expect(far.findings[0]?.measured.value).toBeLessThan(1360);
    expect(far.surfaceId).toBeNull();
    expect(far.ok).toBe(false);
  });

  it('a point just inside the reach is operated from the platform edge (reachMm = plan distance)', () => {
    const edge = target(reach(doc, { targets: [{ tag: 'T', kind: 'x', point: [0, 3100, 6900] }] }), 'T');
    expect(edge.surfaceId).toBe('assembly-1');
    expect(edge.reachMm).toBeGreaterThan(440);
    expect(edge.reachMm).toBeLessThan(460);
  });

  it('a point below every surface is STA_REACH naming that no surface lies below', () => {
    const pit = target(reach(doc, { targets: [{ tag: 'PIT', kind: 'x', point: [0, 0, -500] }] }), 'PIT');
    expect(pit.findings[0]).toMatchObject({ code: 'STA_REACH', measured: { unit: 'walking surfaces at or below the point', value: 0 } });
  });

  it('gradeIsWalkable false: a point only grade could serve is STA_REACH', () => {
    const answer = reach(doc, { targets: [{ tag: 'PI', kind: 'instrument', point: [3500, 0, 1200] }], gradeIsWalkable: false });
    expect(target(answer, 'PI').findings.map((finding) => finding.code)).toEqual(['STA_REACH']);
  });

  it('document units: points are in document units, the band and the reach in millimetres', () => {
    let metres = apply(createEmptyDocument(), 'set_units', { units: 'm' });
    metres = apply(metres, 'add_level', { name: 'Grade', elevation: 0, height: 6 });
    metres = apply(metres, 'add_equipment', {
      name: 'Column',
      mark: 'C-101',
      location: [0, 0],
      size: [3, 3, 18],
      shape: 'vertical_vessel',
    });
    metres = apply(metres, 'add_circular_access_platform', { ...PACK, elevation: 6, gap: 0.15, width: 1, railing: undefined });
    const answer = reach(metres, { targets: [{ tag: 'HV', kind: 'x', point: [0, 2.2, 6.9] }] });
    expect(target(answer, 'HV').heightAboveSurfaceMm).toBeCloseTo(900, 6);
    expect(target(answer, 'HV').surfaceId).toBe('assembly-1');
  });
});

describe('check_reachability: refusals leave the document unchanged', () => {
  const doc = plantDoc();
  const base = { operatingHeightMm: BAND, maxHorizontalReachMm: 600 };

  it('needs a target source, a sane band and unique tags', () => {
    expectRefusal(doc, 'check_reachability', base, 'STA_TARGETS_INVALID', 'targets');
    expectRefusal(doc, 'check_reachability', { ...base, targets: [], targetsFrom: [] }, 'STA_TARGETS_INVALID');
    expectRefusal(
      doc,
      'check_reachability',
      { ...base, operatingHeightMm: { min: 2000, max: 1000, source: 's' }, targets: [{ tag: 'A', kind: 'x', point: [0, 0, 0] }] },
      'STA_TARGETS_INVALID',
      'operatingHeightMm',
    );
    expectRefusal(
      doc,
      'check_reachability',
      {
        ...base,
        targets: [
          { tag: 'A', kind: 'x', point: [0, 0, 0] },
          { tag: 'A', kind: 'y', point: [1, 1, 1] },
        ],
      },
      'STA_TARGET_DUPLICATE',
      'targets',
    );
  });

  it('rejects non-finite points and a missing band source as invalid params', () => {
    for (const bad of [
      { ...base, targets: [{ tag: 'A', kind: 'x', point: [0, 0, Number.NaN] }] },
      { ...base, targets: [{ tag: 'A', kind: 'x', point: [0, 0] }] },
      { ...base, operatingHeightMm: { min: 0, max: 1 }, targets: [{ tag: 'A', kind: 'x', point: [0, 0, 0] }] },
      { ...base, maxHorizontalReachMm: -1, targets: [{ tag: 'A', kind: 'x', point: [0, 0, 0] }] },
    ])
      expect(execute(doc, 'check_reachability', bad).summary).toContain('invalid params');
  });

  it('a model with no level is STA_NO_GRADE; more than 5000 targets is STA_ACCESS_GRAPH_LIMIT before anything is built', () => {
    expectRefusal(
      createEmptyDocument(),
      'check_reachability',
      { ...base, targets: [{ tag: 'A', kind: 'x', point: [0, 0, 0] }] },
      'STA_NO_GRADE',
    );
    const many = Array.from({ length: GRAPH_LIMITS.targets + 1 }, (_, index) => ({ tag: `T${index}`, kind: 'x', point: [0, 0, 0] }));
    expectRefusal(doc, 'check_reachability', { ...base, targets: many }, 'STA_ACCESS_GRAPH_LIMIT', 'targets');
    const exactly = many.slice(0, GRAPH_LIMITS.targets);
    expect(reach(doc, { targets: exactly }).targets).toHaveLength(GRAPH_LIMITS.targets);
  });

  it('tags are plain data: __proto__ and constructor are targets like any other, answered in order', () => {
    const tags = ['__proto__', 'constructor', 'toString'];
    const answer = reach(doc, { targets: tags.map((tag) => ({ tag, kind: 'x', point: [0, 2200, 6900] })) });
    expect(answer.targets.map((item) => item.tag)).toEqual(tags);
    expect(answer.targets.every((item) => item.ok)).toBe(true);
    expectRefusal(
      doc,
      'check_reachability',
      {
        operatingHeightMm: BAND,
        maxHorizontalReachMm: 0,
        targets: [
          { tag: '__proto__', kind: 'x', point: [0, 0, 0] },
          { tag: '__proto__', kind: 'x', point: [0, 0, 0] },
        ],
      },
      'STA_TARGET_DUPLICATE',
    );
  });

  it('targetsFrom valves needs a millimetre document', () => {
    const inches = apply(createEmptyDocument(), 'set_units', { units: 'in' });
    expectRefusal(
      apply(inches, 'add_level', { name: 'Grade', elevation: 0, height: 100 }),
      'check_reachability',
      { ...base, targetsFrom: ['valves'] },
      'STA_TARGETS_INVALID',
      'targetsFrom',
    );
  });
});

/** A building of `count` overlapping coplanar floor slabs written straight into the model (the caps are about size, not about commands). */
function crowd(count: number, role: SlabElement['role'] = 'floor'): CadDocument {
  const base = apply(apply(createEmptyDocument(), 'set_units', { units: 'mm' }), 'add_level', {
    name: 'Grade',
    elevation: 0,
    height: 3000,
  });
  const building = base.building as BuildingModel;
  const levelId = Object.keys(building.levels)[0] as string;
  const elements: BuildingModel['elements'] = {};
  for (let index = 0; index < count; index++)
    elements[`slab-${index}`] = {
      id: `slab-${index}`,
      category: 'slab',
      mark: `S${index}`,
      entityIds: [],
      levelId,
      boundary: [
        [0, 0],
        [1000, 0],
        [1000, 1000],
        [0, 1000],
      ],
      thickness: 100,
      offset: index % 2,
      role,
      material: 'concrete',
    };
  return { ...base, building: { ...building, elements, elementOrder: Object.keys(elements) } };
}

describe('the graph is bounded and total', () => {
  it('over 5000 slabs and grating panels is refused before anything is built, at exactly 5000 it is answered', () => {
    expectRefusal(crowd(GRAPH_LIMITS.rawSurfaces + 1), 'access_graph', {}, 'STA_ACCESS_GRAPH_LIMIT');
    expect(data<{ surfaces: unknown[] }>(crowd(GRAPH_LIMITS.rawSurfaces, 'roof'), 'access_graph', {}).surfaces).toEqual([]);
  });

  it('more outline contact tests than the cap are refused, not computed (1000 coplanar overlapping slabs = 499500 pairs)', () => {
    const result = expectRefusal(crowd(1000), 'access_graph', {}, 'STA_ACCESS_GRAPH_LIMIT');
    expect(result.summary).toContain('contact tests');
  });

  it('a few hundred overlapping surfaces are answered deterministically (all touch grade and each other)', () => {
    const answer = data<{ surfaces: Array<{ route: string[] | null }>; contacts: number }>(crowd(200), 'access_graph', {});
    expect(answer.surfaces).toHaveLength(200);
    expect(answer.surfaces.every((surface) => surface.route?.[0] === 'grade')).toBe(true);
    expect(JSON.stringify(data(crowd(200), 'access_graph', {}))).toBe(JSON.stringify(answer));
  });

  it('check_access reports a platform it could not judge as a warning, never a pass', () => {
    const base = plantDoc();
    const building = base.building as BuildingModel;
    const crowded = crowd(GRAPH_LIMITS.rawSurfaces + 1);
    const merged = {
      ...base,
      building: {
        ...building,
        elements: { ...building.elements, ...(crowded.building as BuildingModel).elements },
        elementOrder: [...building.elementOrder, ...(crowded.building as BuildingModel).elementOrder],
      },
    };
    const checked = data<{ verdict: string; findings: Array<{ code: string; severity: string; ids: string[] }> }>(merged, 'check_access', {
      rulesets: ['iso_14122'],
      ids: ['assembly-1'],
      include: ['platforms'],
    });
    expect(checked.findings).toEqual([expect.objectContaining({ code: 'STA_ACCESS_GRAPH_LIMIT', severity: 'warn', ids: ['assembly-1'] })]);
    expect(checked.verdict).toBe('warn');
  });
});

describe('building_schedule kind access', () => {
  it('lists each surface with its route from grade; "NO ROUTE" and 0 independent routes without a ladder', () => {
    const schedule = data<{ columns: string[]; rows: Array<Array<string | number>>; csv: string }>(plantDoc(), 'building_schedule', {
      kind: 'access',
    });
    expect(schedule.columns).toHaveLength(8);
    expect(schedule.rows).toEqual([['AS1', 'circular_platform', 'Grade', 6000, expect.closeTo(6.74, 1), 1, 'grade > LD1 > AS1', 1]]);
    const lonely = data<typeof schedule>(plantDoc(false), 'building_schedule', { kind: 'access' });
    expect(lonely.rows[0]?.slice(5)).toEqual(['', 'NO ROUTE', 0]);
  });

  it('a model over the graph caps gives one row naming the code, not an empty table', () => {
    const schedule = data<{ rows: Array<Array<string | number>> }>(crowd(GRAPH_LIMITS.rawSurfaces + 1), 'building_schedule', {
      kind: 'access',
    });
    expect(schedule.rows).toHaveLength(1);
    expect(schedule.rows[0]?.[0]).toBe('STA_ACCESS_GRAPH_LIMIT');
  });
});

describe('the golden plan plant_access_structures answers (VC-STA-14)', () => {
  const result = execute(createEmptyDocument(), 'build_project', { actions: structuresPlans['plant_access_structures'] });
  const steps = (result.data as { steps: Array<{ ok: boolean; command: string; data?: unknown }> }).steps;
  const step = (command: string): { data?: unknown } => steps.find((candidate) => candidate.command === command) ?? {};

  it('every step ran', () => {
    expect(steps.filter((candidate) => !candidate.ok)).toEqual([]);
  });

  it('both operating points are reached: HV-101 through the ladder to the vessel platform, HV-201 through the stair to the deck', () => {
    const answer = step('check_reachability').data as Reach;
    expect(target(answer, 'HV-101')).toMatchObject({ ok: true, route: ['grade', 'ladder-1', 'assembly-1'] });
    expect(target(answer, 'HV-201')).toMatchObject({ ok: true, route: ['grade', 'steelStair-1', 'assembly-2'] });
    expect(target(answer, 'HV-201').heightAboveSurfaceMm).toBeCloseTo(900, 6);
  });

  it('the schedule lists both platforms with their routes and the plan has 2 platforms, the ladder and the stair', () => {
    const schedule = step('building_schedule').data as { rows: Array<Array<string | number>> };
    expect(schedule.rows.map((row) => [row[0], row[6]])).toEqual([
      ['AS1', 'grade > LD1 > AS1'],
      ['AS2', 'grade > SS1 > AS2'],
    ]);
    expect((step('export_access_plan').data as { counts: unknown }).counts).toMatchObject({ platforms: 2, ladders: 1, stairs: 1 });
  });
});
