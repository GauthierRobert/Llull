import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { recipeKey } from '@core/geometry/shapeRecipe';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import type { FtrCheckData } from '@core/model/manufacturing';
import type { HoleTableData } from '@core/commands/features/holeTable';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { ctxWith, idOf, manifoldSuite, meshOf, plate, volumeOf } from '../../helpers/featureSupport';

const kernelOf = manifoldSuite();

const TOP = { near: [50, 30, 10] };
const CSK = { kind: 'countersink', diameter: 4.8, cskDiameter: 9, cskAngle: 100 };

/** A plate with 2 countersunk through holes, a blind drilled hole and a pocket. */
function machined(size: [number, number, number] = [100, 60, 10]): { doc: ReturnType<typeof plate>['doc']; id: string } {
  const stock = plate(size);
  const top = { near: [50, 30, size[2]] };
  const run = (doc: typeof stock.doc, id: string, name: string, params: Record<string, unknown>): ReturnType<typeof execute> =>
    execute(doc, name, { target: id, face: top, pointsFrame: 'world_xy', ...params });
  const csk = run(stock.doc, stock.id, 'add_hole', {
    points: [
      [10, 10],
      [90, 10],
    ],
    hole: CSK,
    extent: { kind: 'through_all' },
  });
  const blind = run(csk.document, idOf(csk), 'add_hole', {
    points: [[50, 15]],
    hole: { kind: 'simple', diameter: 6, thread: { designation: 'MJ6x1-4H5H' } },
    extent: { kind: 'blind', depth: Math.min(6, size[2] - 1) },
  });
  const pocket = run(blind.document, idOf(blind), 'add_pocket', {
    outline: { kind: 'rectangle', center: [50, 45], size: [40, 12] },
    depth: Math.min(4, size[2] - 1),
    cornerRadius: 3,
    floorFillet: 0,
  });
  return { doc: pocket.document, id: idOf(pocket) };
}

const dataOf = <T>(result: ReturnType<typeof execute>): T => result.data as T;

describe('set_thread', () => {
  it('sets the thread on a hole feature: recipe key and mesh unchanged (VC-FTR-28)', () => {
    const { doc, id } = machined();
    const before = meshOf(doc, id);
    const result = execute(doc, 'set_thread', { id, featureIndex: 0, thread: { designation: '.1900-32 UNJF-3B' } });
    expect(result.affected).toEqual([id]);
    const after = meshOf(result.document, id);
    expect(recipeKey(after.brep!)).toBe(recipeKey(before.brep!));
    expect(after.mesh).toBe(before.mesh);
    expect(JSON.stringify(after.brep)).toContain('UNJF-3B');
    expect(JSON.stringify(after.brep)).toContain('MJ6x1-4H5H');
    expectPure(doc, () => execute(doc, 'set_thread', { id, featureIndex: 0, thread: { designation: 'M6x1-6H' } }));
  });

  it('VC-FTR-28: MJ6x1-4H5H leaves volume and recipeKey unchanged and persists through save / load and the code export comment', () => {
    const stock = plate();
    const drilled = execute(stock.doc, 'add_hole', {
      target: stock.id,
      face: TOP,
      points: [[50, 30]],
      pointsFrame: 'world_xy',
      hole: { kind: 'simple', diameter: 6 },
      extent: { kind: 'blind', depth: 6, drillPointAngle: 118 },
    });
    const id = idOf(drilled);
    const threaded = execute(drilled.document, 'set_thread', { id, featureIndex: 0, thread: { designation: 'MJ6x1-4H5H' } });
    expect(threaded.affected).toEqual([id]);
    expect(volumeOf(threaded.document, id)).toBe(volumeOf(drilled.document, id));
    expect(recipeKey(meshOf(threaded.document, id).brep!)).toBe(recipeKey(meshOf(drilled.document, id).brep!));
    const reloaded = deserializeDocument(serializeDocument(threaded.document));
    expect(meshOf(reloaded, id).brep).toMatchObject({ hole: { thread: { designation: 'MJ6x1-4H5H', family: 'MJ' } } });
    expect(recipeKey(meshOf(reloaded, id).brep!)).toBe(recipeKey(meshOf(drilled.document, id).brep!));
    const code = execute(threaded.document, 'export_code', { language: 'cadquery' }).data as { text: string };
    expect(code.text).toContain('thread MJ6x1-4H5H');
  });

  it('removes a thread with null, and accepts free text for family other', () => {
    const { doc, id } = machined();
    const removed = execute(doc, 'set_thread', { id, featureIndex: 1, thread: null });
    expect(JSON.stringify(meshOf(removed.document, id).brep)).not.toContain('MJ6x1-4H5H');
    const other = execute(doc, 'set_thread', { id, featureIndex: 0, thread: { designation: 'Rc 1/4 taper' } });
    expect(JSON.stringify(meshOf(other.document, id).brep)).toContain('"family":"other"');
  });

  it.each([
    ['MJ6', 'MJ designation without pitch'],
    ['.1900-32 UNJX-3B', 'unknown UNJ series'],
    ['M6x1-9', 'bad tolerance class'],
  ])('refuses %s (%s) with FTR_THREAD_DESIGNATION_INVALID', (designation) => {
    const { doc, id } = machined();
    const result = execute(doc, 'set_thread', { id, featureIndex: 0, thread: { designation } });
    expectNoOp(result, doc);
    expect(result.error).toMatchObject({ code: 'FTR_THREAD_DESIGNATION_INVALID', paths: ['thread.designation'] });
  });

  it('refuses a family that does not match its grammar, a pocket index, a missing entity', () => {
    const { doc, id } = machined();
    expect(execute(doc, 'set_thread', { id, featureIndex: 0, thread: { designation: 'M6x1', family: 'MJ' } }).error?.code).toBe(
      'FTR_THREAD_DESIGNATION_INVALID',
    );
    const pocket = execute(doc, 'set_thread', { id, featureIndex: 2, thread: { designation: 'M6x1' } });
    expect(pocket.error).toMatchObject({ code: 'FTR_PART_NOT_FOUND', paths: ['featureIndex'] });
    const missing = execute(doc, 'set_thread', { id: 'nope', featureIndex: 0, thread: null });
    expect(missing.error).toMatchObject({ code: 'FTR_PART_NOT_FOUND', paths: ['id'] });
    expectNoOp(missing, doc);
  });
});

describe('hole_table', () => {
  it('lists holes from the top-left datum, sorted, with the drill point named (VC-FTR-34, VC-FTR-39)', () => {
    const { doc, id } = machined();
    const result = execute(doc, 'hole_table', { id });
    const table = dataOf<HoleTableData>(result);
    expect(result.document).toBe(doc);
    expect(table.rows.map((row) => row.label)).toEqual(['H1', 'H2', 'H3']);
    expect(table.rows.map((row) => [row.x, row.y])).toEqual([
      [50, 45],
      [10, 50],
      [90, 50],
    ]);
    const [blind, left] = table.rows;
    expect(blind).toMatchObject({ subtype: 'simple', diameter: 6, depth: 6, through: false, thread: 'MJ6x1-4H5H' });
    expect(blind?.drillPointAngle).toEqual({ value: 118, source: 'R8', defaulted: true, verification: 'unverified' });
    expect(blind?.tipHeight).toBeCloseTo(1.802581857, 6);
    expect(left).toMatchObject({ subtype: 'countersink', cskDiameter: 9, cskAngleDeg: 100, through: true });
    expect(left?.cskDepth).toBeCloseTo(1.762109225, 6);
    expect(table).toMatchObject({ lengthUnit: 'mm', angleUnit: 'deg', reviewRequired: true, unverified: true, origin: [0, 60] });
    expect(table.unverifiedInputs).toEqual([{ kind: 'preset', id: 'drill_point_118', source: 'R8' }]);
    expect(result.summary).toContain('not approved');
  });

  it('measures from a given datum; an explicit drill point is not defaulted', () => {
    const stock = plate();
    const drilled = execute(stock.doc, 'add_hole', {
      target: stock.id,
      face: TOP,
      points: [[10, 10]],
      hole: { kind: 'simple', diameter: 4 },
      extent: { kind: 'blind', depth: 5, drillPointAngle: 135 },
    });
    const table = dataOf<HoleTableData>(execute(drilled.document, 'hole_table', { id: idOf(drilled), origin: [0, 0] }));
    expect(table.rows[0]).toMatchObject({ x: 10, y: -10 });
    expect(table.rows[0]?.drillPointAngle).toMatchObject({ value: 135, defaulted: false, verification: 'verified' });
    expect(table.unverified).toBe(false);
  });

  it('an entity without holes has no rows; a missing id is refused', () => {
    const { doc, id } = plate();
    const empty = execute(doc, 'hole_table', { id });
    expect(dataOf<HoleTableData>(empty).rows).toEqual([]);
    const missing = execute(doc, 'hole_table', { id: 'nope' });
    expectNoOp(missing, doc);
    expect(missing.error?.code).toBe('FTR_PART_NOT_FOUND');
  });

  it('without a kernel: authored holes are still listed, a part that needs recognition is refused (FTR_NEEDS_EXACT_KERNEL)', () => {
    const { doc, id } = plate();
    const refused = execute(doc, 'hole_table', { id }, ctxWith(null));
    expectNoOp(refused, doc);
    expect(refused.error?.code).toBe('FTR_NEEDS_EXACT_KERNEL');
    expect(refused.error?.ids).toEqual([id]);
    const authored = machined();
    const listed = execute(authored.doc, 'hole_table', { id: authored.id }, ctxWith(null));
    expect(listed.error).toBeUndefined();
    expect(dataOf<HoleTableData>(listed).rows).toHaveLength(3);
  });
});

describe('check_machining', () => {
  it('reports the missing thresholds instead of assuming them (VC-FTR-38)', () => {
    const { doc, id } = machined();
    const result = execute(doc, 'check_machining', { id });
    const check = dataOf<FtrCheckData>(result);
    expect(result.document).toBe(doc);
    expect(check.status).toBe('warn');
    expect(check.rulesSkipped.map((entry) => entry.rule)).toEqual(['maxDepthRatio', 'minLand', 'toolDiameter']);
    expect(check.rulesSkipped.every((entry) => entry.code === 'FTR_RULE_THRESHOLD_MISSING')).toBe(true);
    expect(check.findings.filter((f) => f.code === 'FTR_RULE_THRESHOLD_MISSING')).toHaveLength(3);
    expect(check).toMatchObject({ reviewRequired: true, lengthUnit: 'mm', angleUnit: 'deg' });
    expect(result.summary).toContain('minLand');
  });

  it('thick plate with thresholds: no findings, rules applied, sources echoed', () => {
    const { doc, id } = machined();
    const result = execute(doc, 'check_machining', {
      id,
      rules: [
        { rule: 'minLand', value: 1, source: 'company rule 12' },
        { rule: 'maxDepthRatio', value: 10, source: 'shop handbook' },
        { rule: 'toolDiameter', value: 6, source: 'cutter T3' },
      ],
    });
    const check = dataOf<FtrCheckData>(result);
    expect(check.status).toBe('pass');
    expect(check.findings).toEqual([]);
    expect(check.rulesApplied).toEqual(['csk_knife_edge', 'maxDepthRatio', 'minLand', 'pocket_corner_vs_tool']);
    expect(check.provenance.inputs['minLand']).toMatchObject({ value: 1, source: 'company rule 12' });
  });

  it('thin sheet: the knife edge fails (VC-FTR-23), measured by ray cast; thickness overrides it', () => {
    const { doc, id } = machined([100, 60, 1.6]);
    const check = dataOf<FtrCheckData>(execute(doc, 'check_machining', { id }));
    const knife = check.findings.find((f) => f.code === 'FTR_CSK_KNIFE_EDGE');
    expect(check.status).toBe('fail');
    expect(knife).toMatchObject({ severity: 'fail', ids: ['hole-0.0'], unit: 'mm' });
    expect(knife?.value).toBeCloseTo(-0.162109225, 6);
    const forced = dataOf<FtrCheckData>(execute(doc, 'check_machining', { id, thickness: 3 }));
    expect(forced.findings.some((f) => f.code === 'FTR_CSK_KNIFE_EDGE')).toBe(false);
  });

  it('thin land, deep hole and a small pocket corner are findings with limit and source', () => {
    const { doc, id } = machined([100, 60, 2.4]);
    const check = dataOf<FtrCheckData>(
      execute(doc, 'check_machining', {
        id,
        rules: [
          { rule: 'minLand', value: 1, source: 'rule A' },
          { rule: 'maxDepthRatio', value: 0.5, source: 'rule B' },
          { rule: 'toolDiameter', value: 8, source: 'rule C' },
        ],
      }),
    );
    const byCode = (code: string): ReturnType<typeof Array.prototype.find> => check.findings.find((f) => f.code === code);
    expect(byCode('FTR_CSK_LAND_BELOW_MIN')).toMatchObject({ severity: 'warn', limit: 1, source: 'rule A' });
    expect(byCode('FTR_HOLE_DEPTH_RATIO_HIGH')).toMatchObject({ severity: 'warn', limit: 0.5, source: 'rule B' });
    expect(byCode('FTR_POCKET_CORNER_BELOW_TOOL_RADIUS')).toMatchObject({ severity: 'fail', value: 3, limit: 4, source: 'rule C' });
    const severities = check.findings.map((f) => f.severity);
    expect([...severities].sort((a, b) => ['fail', 'warn', 'info'].indexOf(a) - ['fail', 'warn', 'info'].indexOf(b))).toEqual(severities);
  });

  it('a waiver without a human approval keeps the finding failing (VC-FTR-42 pattern)', () => {
    const { doc, id } = machined([100, 60, 1.6]);
    const check = dataOf<FtrCheckData>(
      execute(doc, 'check_machining', { id, waivers: [{ code: 'FTR_CSK_KNIFE_EDGE', ids: ['hole-0.0'], approvalRef: 'agent-says-ok' }] }),
    );
    expect(check.status).toBe('fail');
    expect(check.findings.map((f) => f.code)).toContain('FTR_CSK_KNIFE_EDGE');
    expect(check.findings.find((f) => f.code === 'FTR_WAIVER_NOT_APPROVED')).toMatchObject({ severity: 'fail' });
  });

  it('a pocket tool diameter recorded by add_pocket is used; a bare plate passes with nothing to check', () => {
    const stock = plate();
    const bare = dataOf<FtrCheckData>(execute(stock.doc, 'check_machining', { id: stock.id }));
    expect(bare).toMatchObject({ status: 'pass', findings: [], rulesApplied: [], rulesSkipped: [] });
    const cut = execute(stock.doc, 'add_pocket', {
      target: stock.id,
      face: TOP,
      outline: { kind: 'rectangle', center: [50, 30], size: [20, 20] },
      depth: 2,
      cornerRadius: 1,
      floorFillet: 0,
      toolDiameter: 10,
    });
    const check = dataOf<FtrCheckData>(execute(cut.document, 'check_machining', { id: idOf(cut) }));
    expect(check.findings).toMatchObject([{ code: 'FTR_POCKET_CORNER_BELOW_TOOL_RADIUS', value: 1, limit: 5 }]);
  });

  it('refuses a missing id and an absent kernel, is a read-only query', () => {
    const { doc, id } = machined();
    expect(execute(doc, 'check_machining', { id: 'nope' }).error?.code).toBe('FTR_PART_NOT_FOUND');
    const result = execute(doc, 'check_machining', { id }, ctxWith(kernelOf()));
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    expect(execute(doc, 'check_machining', { id }, ctxWith(null)).error?.code).toBe('CMD_KERNEL_UNAVAILABLE');
  });
});
