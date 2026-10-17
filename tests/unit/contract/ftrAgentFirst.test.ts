/** Agent-first contract of the 07 FTR commands (TR-FTR-01..03, VC-FTR-31, 37, 38, 44): units in every schema, stable codes, refusal shape, result meta. */
import { describe, expect, it } from 'vitest';
import { execute, getCommand, listCommands, toToolSchemas } from '@core/commands/registry';
import type { ParamSpec, ParamItemSpec } from '@core/commands/types';
import { FTR_CODES, FTR_REVIEW_REASON, type FtrCheckData, type FtrResultMeta } from '@core/model/manufacturing';
import type { HoleTableData } from '@core/commands/features/holeTable';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { TOOLSETS } from '@mcp/toolsets';
import { expectNoOp } from '../../helpers/expectNoOp';
import { idOf, manifoldSuite, plate } from '../../helpers/featureSupport';

manifoldSuite();

const CORE_FTR_TOOLS = ['add_hole', 'add_pocket', 'set_thread', 'recognize_features', 'check_machining', 'hole_table'] as const;

/** Codes frozen by the contract (TR-FTR-03): new codes are only appended, existing ones never renamed or reordered. */
const FROZEN_CODES = [
  'FTR_K_FACTOR_MISSING',
  'FTR_K_FACTOR_OUT_OF_RANGE',
  'FTR_BEND_ANGLE_OUT_OF_RANGE',
  'FTR_SHARP_BEND_FORBIDDEN',
  'FTR_BEND_RADIUS_BELOW_MIN',
  'FTR_BEND_RADIUS_NO_TABLE_ROW',
  'FTR_TABLE_ROW_NO_SOURCE',
  'FTR_RULE_NOT_FOUND',
  'FTR_PART_NOT_FOUND',
  'FTR_PROFILE_NOT_CLOSED',
  'FTR_EDGE_NOT_STRAIGHT',
  'FTR_JOGGLE_OFFSET_TOO_SMALL',
  'FTR_HOLE_TO_BEND_TOO_CLOSE',
  'FTR_HOLE_TO_EDGE_TOO_CLOSE',
  'FTR_FLANGE_TOO_SHORT',
  'FTR_RELIEF_MISSING',
  'FTR_NOT_SHEET_METAL',
  'FTR_NON_DEVELOPABLE',
  'FTR_FACE_NOT_FOUND',
  'FTR_FACE_NOT_PLANAR',
  'FTR_HOLE_POINT_OUTSIDE_FACE',
  'FTR_HOLE_DIAMETERS_INCONSISTENT',
  'FTR_CSK_ANGLE_OUT_OF_RANGE',
  'FTR_BLIND_DEPTH_INVALID',
  'FTR_FASTENER_CATALOG_UNAVAILABLE',
  'FTR_THREAD_DESIGNATION_INVALID',
  'FTR_POCKET_FILLET_GT_CORNER',
  'FTR_POCKET_DEPTH_EXCEEDS_STOCK',
  'FTR_CSK_KNIFE_EDGE',
  'FTR_CSK_LAND_BELOW_MIN',
  'FTR_POCKET_CORNER_BELOW_TOOL_RADIUS',
  'FTR_HOLE_DEPTH_RATIO_HIGH',
  'FTR_RULE_THRESHOLD_MISSING',
  'FTR_UNVERIFIED_DATA',
  'FTR_WAIVER_NOT_APPROVED',
  'FTR_NEEDS_EXACT_KERNEL',
  'FTR_RECOGNITION_AMBIGUOUS',
  'FTR_DRILL_POINT_ANGLE_OUT_OF_RANGE',
  'FTR_FEATURE_BUILD_FAILED',
  'FTR_POCKET_CORNER_TOO_LARGE',
];

const UNIT_WORDS = /document length unit|degrees|dimensionless|\bmm\b|\binches\b|\bin\b/i;

/** Numeric (non-integer) params, depth first, with the description that must carry their unit. */
function numericParams(spec: ParamSpec | ParamItemSpec, path: string, inherited: string): string[] {
  const text = `${spec.description ?? ''} ${inherited}`;
  const own = spec.type === 'number' && !UNIT_WORDS.test(text) ? [path] : [];
  const children = Object.entries(spec.properties ?? {}).flatMap(([name, child]) => numericParams(child, `${path}.${name}`, ''));
  const items = spec.items === undefined ? [] : numericParams(spec.items, `${path}[]`, spec.description ?? inherited);
  return [...own, ...children, ...items];
}

describe('FTR_CODES (TR-FTR-03)', () => {
  it('keeps every frozen code, in order, and only appends', () => {
    expect(FTR_CODES.slice(0, FROZEN_CODES.length)).toEqual(FROZEN_CODES);
    expect(new Set(FTR_CODES).size).toBe(FTR_CODES.length);
    expect(FTR_CODES.every((code) => /^FTR_[A-Z0-9_]+$/.test(code))).toBe(true);
  });
});

describe('FTR commands are registered (VC-FTR-31)', () => {
  it('are listed, exposed with a schema 1:1 and in the manufacturing toolset exactly once', () => {
    const names = new Set(listCommands().map((command) => command.name));
    const schemas = new Set(toToolSchemas().map((tool) => tool.name));
    for (const tool of CORE_FTR_TOOLS) {
      expect(names.has(tool)).toBe(true);
      expect(schemas.has(tool)).toBe(true);
      expect(TOOLSETS.manufacturing.filter((name) => name === tool)).toHaveLength(1);
      const others = Object.entries(TOOLSETS).filter(([toolset, list]) => toolset !== 'manufacturing' && list.includes(tool));
      expect(others).toEqual([]);
    }
    expect(toToolSchemas()).toHaveLength(listCommands().length);
  });

  it('marks queries read-only and the cutting commands as kernel users', () => {
    const annotation = (name: string): Record<string, unknown> => (getCommand(name)?.annotations ?? {}) as Record<string, unknown>;
    for (const name of ['recognize_features', 'check_machining', 'hole_table']) expect(annotation(name).readOnly).toBe(true);
    for (const name of ['add_hole', 'add_pocket', 'recognize_features', 'check_machining'])
      expect(annotation(name).requiresKernel).toBe(true);
    expect(annotation('set_thread').readOnly).toBeUndefined();
  });
});

describe('every numeric param of the manufacturing tools states its unit (TR-FTR-01, VC-FTR-44)', () => {
  const tools = toToolSchemas().filter((tool) => TOOLSETS.manufacturing.includes(tool.name));
  it('has the tools to scan', () => {
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([...CORE_FTR_TOOLS]));
  });
  it.each(CORE_FTR_TOOLS)('%s: no numeric param without a unit word', (name) => {
    const tool = tools.find((candidate) => candidate.name === name);
    const missing = Object.entries(tool?.input_schema.properties ?? {}).flatMap(([param, spec]) => numericParams(spec, param, ''));
    expect(missing).toEqual([]);
  });
  it.each(CORE_FTR_TOOLS)('%s: the description names its refusal codes or its result shape (AF-02)', (name) => {
    const description = getCommand(name)?.description ?? '';
    expect(description).toMatch(/FTR_[A-Z_]+|data/);
    expect(description.length).toBeGreaterThan(200);
  });
});

describe('refusals carry { code, ids, paths, remediation } (AF-11, VC-FTR-37)', () => {
  const stock = plate();
  const top = { near: [50, 30, 10] };
  const through = { kind: 'through_all' };
  const cases: Array<[string, Record<string, unknown>, string]> = [
    [
      'add_hole',
      {
        target: stock.id,
        face: top,
        points: [[10, 10]],
        hole: { kind: 'countersink', diameter: 8, cskDiameter: 6, cskAngle: 100 },
        extent: through,
      },
      'FTR_HOLE_DIAMETERS_INCONSISTENT',
    ],
    [
      'add_hole',
      {
        target: stock.id,
        face: top,
        points: [[10, 10]],
        hole: { kind: 'countersink', diameter: 4, cskDiameter: 8, cskAngle: 0 },
        extent: through,
      },
      'FTR_CSK_ANGLE_OUT_OF_RANGE',
    ],
    [
      'add_hole',
      { target: stock.id, face: top, points: [[10, 10]], hole: { kind: 'simple', diameter: 4 }, extent: { kind: 'blind', depth: -1 } },
      'FTR_BLIND_DEPTH_INVALID',
    ],
    [
      'add_hole',
      { target: stock.id, face: top, points: [[1000, 10]], hole: { kind: 'simple', diameter: 4 }, extent: through },
      'FTR_HOLE_POINT_OUTSIDE_FACE',
    ],
    [
      'add_hole',
      { target: stock.id, face: { near: [0, 0, 100] }, points: [[10, 10]], hole: { kind: 'simple', diameter: 4 }, extent: through },
      'FTR_FACE_NOT_FOUND',
    ],
    [
      'add_hole',
      {
        target: stock.id,
        face: top,
        points: [[10, 10]],
        hole: { kind: 'simple', diameter: 4, fastener: { catalogId: 'X', partNumber: 'X-3' } },
        extent: through,
      },
      'FTR_FASTENER_CATALOG_UNAVAILABLE',
    ],
    [
      'add_hole',
      {
        target: stock.id,
        face: top,
        points: [[10, 10]],
        hole: { kind: 'simple', diameter: 4, thread: { designation: 'MJ' } },
        extent: through,
      },
      'FTR_THREAD_DESIGNATION_INVALID',
    ],
    [
      'add_pocket',
      {
        target: stock.id,
        face: top,
        outline: { kind: 'rectangle', center: [50, 30], size: [20, 20] },
        depth: 5,
        cornerRadius: 1,
        floorFillet: 1.5,
      },
      'FTR_POCKET_FILLET_GT_CORNER',
    ],
    [
      'add_pocket',
      {
        target: stock.id,
        face: top,
        outline: { kind: 'rectangle', center: [50, 30], size: [20, 20] },
        depth: 50,
        cornerRadius: 1,
        floorFillet: 0,
      },
      'FTR_POCKET_DEPTH_EXCEEDS_STOCK',
    ],
    [
      'add_pocket',
      {
        target: stock.id,
        face: top,
        outline: {
          kind: 'polygon',
          points: [
            [1, 1],
            [2, 2],
          ],
        },
        depth: 1,
        cornerRadius: 0,
        floorFillet: 0,
      },
      'FTR_PROFILE_NOT_CLOSED',
    ],
    ['set_thread', { id: stock.id, featureIndex: 0, thread: null }, 'FTR_PART_NOT_FOUND'],
    ['recognize_features', { id: stock.id }, 'FTR_NEEDS_EXACT_KERNEL'],
    ['check_machining', { id: 'nope' }, 'FTR_PART_NOT_FOUND'],
    ['hole_table', { id: 'nope' }, 'FTR_PART_NOT_FOUND'],
  ];
  it.each(cases)('%s -> %s', (command, params, code) => {
    const result = execute(stock.doc, command, params);
    expectNoOp(result, stock.doc);
    expect(result.rejected).toBe(true);
    expect(result.error?.code).toBe(code);
    expect(FTR_CODES).toContain(code);
    expect(Array.isArray(result.error?.ids)).toBe(true);
    expect(Array.isArray(result.error?.paths)).toBe(true);
    expect(result.error?.remediation.length ?? 0).toBeGreaterThan(8);
    expect(result.summary).toContain(code);
  });
});

describe('FTR queries carry FtrResultMeta (AF-10, AF-33, AF-35, VC-FTR-38, 41)', () => {
  const metaOf = (data: unknown): FtrResultMeta => data as FtrResultMeta;
  /** Built lazily: the Manifold kernel is only installed once the suite starts. */
  const partOf = (): { doc: CadDocument; id: string } => {
    const stock = plate();
    const cut = execute(stock.doc, 'add_hole', {
      target: stock.id,
      face: { near: [50, 30, 10] },
      points: [[10, 10]],
      hole: { kind: 'simple', diameter: 4 },
      extent: { kind: 'blind', depth: 4 },
    });
    return { doc: cut.document, id: idOf(cut) };
  };

  it('hole_table and check_machining state the unit, review flag and provenance', () => {
    const part = partOf();
    for (const result of [execute(part.doc, 'hole_table', { id: part.id }), execute(part.doc, 'check_machining', { id: part.id })]) {
      const meta = metaOf(result.data);
      expect(meta).toMatchObject({ lengthUnit: 'mm', angleUnit: 'deg', reviewRequired: true, reviewReason: FTR_REVIEW_REASON });
      expect(meta.provenance.formulas).toBeDefined();
      expect(meta.provenance.sources.length).toBeGreaterThan(0);
      expect(result.summary).toContain('not approved');
      expect(result.document).toBe(part.doc);
      expect(result.affected).toEqual([]);
    }
  });

  it('echoes the document unit and ORs the unverified default into the flag (AF-32)', () => {
    const part = partOf();
    const inches = execute(part.doc, 'set_units', { units: 'in' }).document;
    const table = execute(inches, 'hole_table', { id: part.id }).data as HoleTableData;
    expect(table.lengthUnit).toBe('in');
    expect(table.unverified).toBe(true);
    expect(table.unverifiedInputs).toEqual([{ kind: 'preset', id: 'drill_point_118', source: 'R8' }]);
    const check = execute(inches, 'check_machining', { id: part.id }).data as FtrCheckData;
    expect(check.lengthUnit).toBe('in');
  });

  it('check_machining never lets a waiver without an approval pass a failing check', () => {
    const thin = plate([100, 60, 1.6]);
    const drilled = execute(thin.doc, 'add_hole', {
      target: thin.id,
      face: { near: [50, 30, 1.6] },
      points: [[10, 10]],
      hole: { kind: 'countersink', diameter: 4.8, cskDiameter: 9, cskAngle: 100 },
      extent: { kind: 'through_all' },
    });
    const check = execute(drilled.document, 'check_machining', {
      id: idOf(drilled),
      waivers: [{ code: 'FTR_CSK_KNIFE_EDGE', ids: ['hole-0.0'], approvalRef: 'APPROVAL-1' }],
    }).data as FtrCheckData;
    expect(check.status).toBe('fail');
    expect(check.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining(['FTR_CSK_KNIFE_EDGE', 'FTR_WAIVER_NOT_APPROVED']),
    );
  });

  it('an empty document has nothing to check', () => {
    expect(execute(createEmptyDocument(), 'check_machining', { id: 'x' }).error?.code).toBe('FTR_PART_NOT_FOUND');
  });
});
