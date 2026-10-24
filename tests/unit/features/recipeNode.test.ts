/** The `feature` recipe node: key, validation, traversal, outline geometry, persistence (07 FTR §3.1, §6). */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { recipeKey, recipeOf, validateShapeRecipe } from '@core/geometry/shapeRecipe';
import { authoredFeatures, editFeatureNode, featureNodes } from '@core/geometry/featureInstances';
import { floorEdgeIndices } from '@core/geometry/featureFillet';
import { lowerFeature, needsReach, throughReach, type FeatureRecipe } from '@core/geometry/featureLowering';
import { distanceToOutline, roundedOutline } from '@core/geometry/pocketOutline';
import { frameEuler, frameToWorld, planeFrame, worldToFrame } from '@core/geometry/featureFrame';
import type { ShapeTopology } from '@core/geometry/kernel';
import { meshDiagonal } from '@core/geometry/meshExtent';
import type { FeatureFrame, HoleSpec } from '@core/model/features';
import type { ShapeRecipe, Vec2 } from '@core/model/types';
import { idOf, manifoldSuite, meshOf, plate } from '../../helpers/featureSupport';

manifoldSuite();

const FRAME: FeatureFrame = { origin: [0, 0, 10], normal: [0, 0, 1], xDir: [1, 0, 0] };
const SOURCE: ShapeRecipe = recipeOf(plate().doc.entities[plate().id]!);
const hole = (spec: Partial<HoleSpec> = {}, extra: Partial<Extract<FeatureRecipe, { feature: 'hole' }>> = {}): FeatureRecipe => ({
  op: 'feature',
  source: SOURCE,
  feature: 'hole',
  frame: FRAME,
  points: [[10, 10]],
  hole: { kind: 'simple', diameter: 4, ...spec },
  extent: { kind: 'through_all' },
  ...extra,
});
const pocket = (overrides: Record<string, unknown> = {}): FeatureRecipe => ({
  op: 'feature',
  source: SOURCE,
  feature: 'pocket',
  frame: FRAME,
  pocket: {
    outline: [
      [0, 0],
      [20, 0],
      [20, 10],
      [0, 10],
    ],
    depth: 3,
    cornerRadius: 1,
    floorFillet: 0,
    ...overrides,
  },
});

const rib = (overrides: Record<string, unknown> = {}): FeatureRecipe => ({
  op: 'feature',
  source: SOURCE,
  feature: 'rib',
  frame: FRAME,
  rib: {
    path: [
      [10, 10],
      [40, 10],
    ],
    thickness: 3,
    height: 20,
    symmetric: true,
    ...overrides,
  },
});

describe('recipeKey of a feature node', () => {
  it('covers every geometric field', () => {
    const keys = [
      hole(),
      hole({ diameter: 5 }),
      hole({ kind: 'countersink', cskDiameter: 8, cskAngle: 90 }),
      hole({ kind: 'countersink', cskDiameter: 8, cskAngle: 100 }),
      hole({ kind: 'counterbore', cboreDiameter: 8, cboreDepth: 2 }),
      hole({}, { points: [[10, 11]] }),
      hole({}, { frame: { ...FRAME, origin: [0, 0, 9] } }),
      hole({}, { extent: { kind: 'blind', depth: 3 } }),
      hole({}, { extent: { kind: 'up_to_next', depth: 3 } }),
      hole({}, { extent: { kind: 'up_to_face', depth: 3 } }),
      hole({}, { extent: { kind: 'up_to_face', depth: 4 } }),
      hole({ kind: 'counterdrill', cboreDiameter: 8, cboreDepth: 4, cskDiameter: 10, cskAngle: 90 }),
      pocket({
        islands: [
          [
            [2, 2],
            [4, 2],
            [4, 4],
          ],
        ],
      }),
      rib(),
      rib({ thickness: 4 }),
      rib({ height: 21 }),
      rib({ symmetric: false }),
      rib({
        path: [
          [10, 10],
          [41, 10],
        ],
      }),
      hole({}, { extent: { kind: 'blind', depth: 3, drillPointAngle: 118 } }),
      pocket(),
      pocket({ depth: 4 }),
      pocket({ cornerRadius: 2 }),
      pocket({ floorFillet: 0.5 }),
      pocket({ depth: 'through' }),
    ].map(recipeKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('ignores thread and fastener, which are not geometric (VC-FTR-28)', () => {
    const plain = recipeKey(hole());
    const threaded = hole({
      thread: { designation: 'MJ6x1-4H5H', family: 'MJ' },
      fastener: { catalogId: 'NAS', partNumber: 'NAS1351-3-8' },
    });
    expect(recipeKey(threaded)).toBe(plain);
    const defaulted = hole({}, { extent: { kind: 'blind', depth: 3, drillPointAngle: 118, drillPointDefaulted: true } });
    expect(recipeKey(defaulted)).toBe(recipeKey(hole({}, { extent: { kind: 'blind', depth: 3, drillPointAngle: 118 } })));
  });

  it('depends on the source recipe', () => {
    const other = recipeOf(plate([50, 50, 5]).doc.entities[plate().id]!);
    expect(recipeKey({ ...hole(), source: other })).not.toBe(recipeKey(hole()));
  });
});

describe('validateShapeRecipe on feature nodes (persistence, live snapshots)', () => {
  const check = (node: unknown): string | null => validateShapeRecipe(JSON.parse(JSON.stringify(node)));

  it('accepts well-formed holes and pockets', () => {
    expect(check(hole())).toBeNull();
    expect(check(hole({ kind: 'countersink', cskDiameter: 8, cskAngle: 90, thread: { designation: 'M6', family: 'M' } }))).toBeNull();
    expect(check(hole({}, { extent: { kind: 'blind', depth: 3, drillPointAngle: 118 } }))).toBeNull();
    expect(check(pocket())).toBeNull();
    expect(check(pocket({ depth: 'through', toolDiameter: 4 }))).toBeNull();
  });

  const bad = (node: unknown, text: string): void => expect(check(node)).toContain(text);

  it('rejects malformed nodes with the reason', () => {
    bad({ ...hole(), frame: { origin: [0, 0, 0] } }, 'frame needs');
    bad({ ...hole(), feature: 'weld' }, "unknown feature 'weld'");
    bad({ ...hole(), points: [] }, 'points must be');
    bad({ ...hole(), points: [[1, 'x']] }, 'points must be');
    bad({ ...hole(), hole: { kind: 'tapered', diameter: 4 } }, "unknown hole kind 'tapered'");
    bad({ ...hole(), hole: 'nope' }, 'unknown hole kind');
    bad(hole({ diameter: -1 }), 'diameters and depths');
    bad(hole({ cboreDepth: 0 }), 'diameters and depths');
    bad(hole({ cskAngle: 190 }), 'cskAngle');
    bad({ ...hole(), hole: { kind: 'simple', diameter: 4, thread: { designation: 7, family: 'M' } } }, 'thread');
    bad({ ...hole(), hole: { kind: 'simple', diameter: 4, thread: { designation: 'M6', family: 'XX' } } }, 'thread');
    bad({ ...hole(), extent: undefined }, 'extent is required');
    bad({ ...hole(), extent: { kind: 'up_to_face' } }, 'up_to_face depth must be > 0');
    bad({ ...hole(), extent: { kind: 'up_to_next', depth: -1 } }, 'up_to_next depth must be > 0');
    bad({ ...hole(), extent: { kind: 'tunnel' } }, "unknown extent 'tunnel'");
    bad({ ...hole(), extent: { kind: 'blind', depth: 0 } }, 'blind depth');
    bad({ ...hole(), extent: { kind: 'blind', depth: 3, drillPointAngle: 180 } }, 'drillPointAngle');
    bad({ ...pocket(), pocket: undefined }, 'pocket is required');
    bad(pocket({ outline: [[0, 0]] }), 'outline needs');
    bad(pocket({ depth: 0 }), 'depth must be');
    bad(pocket({ depth: 'deep' }), 'depth must be');
    bad(pocket({ cornerRadius: -1 }), 'cornerRadius');
    bad(pocket({ floorFillet: 2 }), 'floorFillet');
    bad(pocket({ toolDiameter: 0 }), 'toolDiameter');
    bad(pocket({ islands: [[[0, 0]]] }), 'every island');
    bad(pocket({ islands: 'x' }), 'every island');
    bad({ ...rib(), rib: undefined }, 'rib is required');
    bad(rib({ path: [[0, 0]] }), 'path needs');
    bad(rib({ thickness: 0 }), 'thickness and height');
    bad(rib({ symmetric: 'yes' }), 'symmetric');
    bad({ ...hole(), source: { op: 'nope' } }, "unknown recipe op 'nope'");
  });
});

describe('feature traversal and editing', () => {
  const first = hole();
  const second: FeatureRecipe = { ...pocket(), source: first };
  const union: ShapeRecipe = { op: 'boolean', boolean: 'union', a: second, b: { ...hole({ diameter: 9 }), source: SOURCE } };
  const subtract: ShapeRecipe = { op: 'boolean', boolean: 'subtract', a: second, b: hole({ diameter: 9 }) };

  it('lists the feature nodes source first; a subtract keeps only its minuend', () => {
    expect(featureNodes(second).map((node) => node.feature)).toEqual(['hole', 'pocket']);
    expect(featureNodes(union).map((node) => node.feature)).toEqual(['hole', 'pocket', 'hole']);
    expect(featureNodes(subtract)).toHaveLength(2);
    expect(featureNodes({ op: 'blend', sources: [first, second], radius: 1 })).toHaveLength(3);
    expect(featureNodes({ op: 'fillet', source: second, edges: [0], size: 1 })).toHaveLength(2);
    expect(featureNodes(SOURCE)).toEqual([]);
  });

  it('edits the node by ordinal through every wrapper and leaves the rest', () => {
    const rename = (node: FeatureRecipe): FeatureRecipe =>
      node.feature === 'hole' ? { ...node, hole: { ...node.hole, diameter: 7 } } : node;
    const edited = editFeatureNode(union, 2, rename);
    expect(featureNodes(edited).map((node) => (node.feature === 'hole' ? node.hole.diameter : 'pocket'))).toEqual([4, 'pocket', 7]);
    const viaBlend = editFeatureNode({ op: 'blend', sources: [first, second], radius: 1 }, 1, rename);
    expect(featureNodes(viaBlend)).toHaveLength(3);
    const viaPlace = editFeatureNode({ op: 'place', source: first, position: [0, 0, 0], rotation: [0, 0, 0] }, 0, rename);
    expect(featureNodes(viaPlace)[0]).toMatchObject({ hole: { diameter: 7 } });
    const untouched = editFeatureNode(subtract, 5, rename);
    expect(featureNodes(untouched).map((node) => node.feature)).toEqual(['hole', 'pocket']);
    expect(editFeatureNode(SOURCE, 0, rename)).toBe(SOURCE);
  });

  it('authoredFeatures numbers holes and pockets in recipe order with their world positions', () => {
    const { holes, pockets } = authoredFeatures(second);
    expect(holes.map((h) => [h.id, h.position])).toEqual([['hole-0.0', [10, 10, 10]]]);
    expect(pockets).toMatchObject([{ id: 'pocket-1', cornerRadius: 1, floorFillet: 0, depth: 3 }]);
    const csk = authoredFeatures(
      hole(
        { kind: 'countersink', cskDiameter: 8, cskAngle: 90 },
        {
          points: [
            [1, 2],
            [3, 4],
          ],
        },
      ),
    ).holes;
    expect(csk.map((h) => h.id)).toEqual(['hole-0.0', 'hole-0.1']);
    expect(csk[0]?.cskDepth).toBeCloseTo(2.0, 9);
  });
});

describe('lowering helpers', () => {
  it('needsReach is true only for through-all holes and through pockets', () => {
    expect(needsReach(hole())).toBe(true);
    expect(needsReach(hole({}, { extent: { kind: 'blind', depth: 2 } }))).toBe(false);
    expect(needsReach(pocket({ depth: 'through' }))).toBe(true);
    expect(needsReach(pocket())).toBe(false);
  });

  it('throughReach measures the stock below the face plane', () => {
    const mesh = { positions: [0, 0, 10, 5, 5, 0, 1, 1, 4], indices: [0, 1, 2] };
    expect(throughReach(mesh, FRAME)).toBe(10);
    expect(throughReach({ positions: [0, 0, 12], indices: [] }, FRAME)).toBe(0);
    expect(meshDiagonal(mesh)).toBeCloseTo(Math.hypot(5, 5, 10), 9);
    expect(meshDiagonal({ positions: [] })).toBe(0);
  });

  it('lowers to one tool per feature, or null for an inconsistent spec', () => {
    expect(lowerFeature(hole(), 10)?.tool).toMatchObject({ op: 'solid' });
    const many = lowerFeature(
      hole(
        {},
        {
          points: [
            [1, 1],
            [2, 2],
            [3, 3],
          ],
        },
      ),
      10,
    )?.tool;
    expect(many).toMatchObject({ op: 'boolean', boolean: 'union' });
    expect(lowerFeature(hole({ kind: 'countersink', diameter: 4 }), 10)).toBeNull();
    expect(lowerFeature(hole({ kind: 'counterbore', diameter: 4 }), 10)).toBeNull();
    expect(lowerFeature(hole({ kind: 'countersink', diameter: 4, cskDiameter: 4, cskAngle: 90 }), 10)).toBeNull();
    expect(
      lowerFeature(hole({ kind: 'counterbore', cboreDiameter: 8, cboreDepth: 5 }, { extent: { kind: 'blind', depth: 3 } }), 10),
    ).toBeNull();
    expect(lowerFeature(hole({}, { points: [] }), 10)).toBeNull();
    expect(
      lowerFeature(
        pocket({
          outline: [
            [0, 0],
            [1, 0],
          ],
        }),
        10,
      ),
    ).toBeNull();
    expect(lowerFeature(pocket(), 0)?.pocket?.floorDepth).toBe(3);
    expect(lowerFeature(pocket({ depth: 'through' }), 8)?.pocket?.floorDepth).toBeGreaterThan(8);
  });
});

describe('face frames', () => {
  it('maps local <-> world and builds a frame from a plane', () => {
    const frame = planeFrame([0, 0, 2], [3, 4, 10]);
    expect(frame).toEqual({ origin: [0, 0, 10], normal: [0, 0, 1], xDir: [1, 0, 0] });
    expect(frameToWorld(frame, [3, 4], 2)).toEqual([3, 4, 8]);
    expect(worldToFrame(frame, [3, 4, 8])).toEqual([3, 4]);
    const side = planeFrame([1, 0, 0], [5, 0, 0]);
    expect(side.xDir).toEqual([0, 1, 0]);
    expect(frameEuler(frame).map((angle) => Math.abs(angle))).toEqual([0, 0, 0]);
    expect(Math.abs(frameEuler(planeFrame([0, 0, -1], [0, 0, 0]))[0])).toBeCloseTo(Math.PI, 9);
  });
});

describe('rounded pocket outlines', () => {
  const rectangle: Vec2[] = [
    [0, 0],
    [20, 0],
    [20, 10],
    [0, 10],
  ];

  it('rounds every vertex with an exact arc; radius 0 stays sharp', () => {
    const sharp = roundedOutline(rectangle, 0);
    expect(typeof sharp).not.toBe('string');
    expect(typeof sharp !== 'string' && sharp.curves.every((segment) => segment.type === 'line')).toBe(true);
    const round = roundedOutline(rectangle, 2);
    if (typeof round === 'string') throw new Error(round);
    expect(round.curves.filter((segment) => segment.type === 'arc')).toHaveLength(4);
    expect(round.profile.length).toBeGreaterThan(16);
  });

  it('reports a radius that does not fit and a degenerate polygon', () => {
    expect(roundedOutline(rectangle, 8)).toMatch(/too large/);
    expect(
      roundedOutline(
        [
          [0, 0],
          [1, 1],
        ],
        0,
      ),
    ).toMatch(/at least 3/);
  });

  it('measures the distance to lines, arcs (including past an arc end) and sampled Bézier pieces', () => {
    const outline = roundedOutline(rectangle, 2);
    if (typeof outline === 'string') throw new Error(outline);
    expect(distanceToOutline(outline.curves, [10, 0])).toBeCloseTo(0, 9);
    expect(distanceToOutline(outline.curves, [10, 5])).toBeCloseTo(5, 9);
    expect(distanceToOutline(outline.curves, [2 - Math.SQRT1_2 * 2, 2 - Math.SQRT1_2 * 2])).toBeCloseTo(0, 6);
    expect(distanceToOutline(outline.curves, [-1, -1])).toBeGreaterThan(1.5);
    expect(
      distanceToOutline(
        [
          {
            type: 'bezier',
            points: [
              [0, 0],
              [1, 0],
              [2, 0],
              [3, 0],
            ],
          },
        ],
        [1, 1],
      ),
    ).toBeCloseTo(1, 3);
  });

  it('floorEdgeIndices picks the edges on the floor plane that follow the outline', () => {
    const tool = lowerFeature(pocket({ cornerRadius: 0 }), 0)?.pocket;
    if (tool === undefined) throw new Error('no tool');
    const edge = (
      index: number,
      start: [number, number, number],
      end: [number, number, number],
      flags = {},
    ): ShapeTopology['edges'][number] => ({
      index,
      curve: 'line',
      length: 1,
      start,
      end,
      mid: [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2, (start[2] + end[2]) / 2],
      seam: false,
      degenerate: false,
      ...flags,
    });
    const topology: ShapeTopology = {
      solids: 1,
      vertices: 0,
      volume: 0,
      faces: [],
      edges: [
        edge(0, [0, 0, 7], [20, 0, 7]),
        edge(1, [20, 0, 7], [20, 10, 7]),
        edge(2, [0, 0, 10], [20, 0, 10]),
        edge(3, [5, 5, 7], [6, 5, 7]),
        edge(4, [0, 0, 7], [20, 0, 7], { seam: true }),
        edge(5, [0, 0, 7], [20, 0, 7], { degenerate: true }),
      ],
    };
    expect(floorEdgeIndices(topology, tool, FRAME)).toEqual([0, 1]);
  });
});

describe('persistence of feature results (llull-document)', () => {
  it('saves and loads the recipe with its nodes, thread and pocket intact', () => {
    const stock = plate();
    const drilled = execute(stock.doc, 'add_hole', {
      target: stock.id,
      face: { near: [50, 30, 10] },
      points: [[10, 10]],
      hole: { kind: 'simple', diameter: 4, thread: { designation: 'M4x0.7-6H' } },
      extent: { kind: 'blind', depth: 5 },
    });
    const cut = execute(drilled.document, 'add_pocket', {
      target: idOf(drilled),
      face: { near: [50, 30, 10] },
      outline: { kind: 'rectangle', center: [60, 30], size: [20, 20] },
      depth: 3,
      cornerRadius: 2,
      floorFillet: 0,
    });
    const text = serializeDocument(cut.document);
    const loaded = deserializeDocument(text);
    const brep = meshOf(loaded, idOf(cut)).brep;
    expect(brep).toEqual(meshOf(cut.document, idOf(cut)).brep);
    expect(featureNodes(brep!).map((node) => node.feature)).toEqual(['hole', 'pocket']);
    expect(serializeDocument(loaded)).toBe(text);
  });
});
