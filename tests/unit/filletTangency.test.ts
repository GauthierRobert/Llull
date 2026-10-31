/**
 * The guard of a fillet step against an earlier round (BLD_FILLET_NOT_TANGENT, TECHNICAL_SPEC 13.26) on a scripted kernel: only the faces the step created are judged, only a contact against a blend face the source already had
 * counts, any kind of source is read (a fillet, a face blend, a full round, an imported B-rep), the worst angle is reported, allowNonTangent reports instead of refusing. The native proof is server/tests/nativeFilletKink.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { findKink, kinkRefusal, kinkReported } from '@core/commands/brep/filletTangency';
import type { Finding } from '@core/commands/brep/checkBlendFindings';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import type { GeometryKernel } from '@core/geometry/kernel';
import { createEmptyDocument, type CadDocument, type ShapeRecipe } from '@core/model/types';

const doc: CadDocument = createEmptyDocument();
const ROUND = 'blend(e(box:x-|box:y-))';
const OLD_BLEND = 'blend(e(box:x+|box:y+))';
const NEW = 'blend(e(blend(e(box:x-|box:y-))|box:z+))';
const FIRST_STEP = 'blend(e(box:y-|box:z+))';
const PLATE = 'blend(v:e(a)|e(b))';
const fail = (face: number, edge: number, value: number): Finding => ({
  code: 'BLD_CHECK_G1_ANGLE',
  severity: 'fail',
  entityId: 'mesh-2',
  face,
  edge,
  value,
  limit: 0.01,
  unit: 'mm',
  remediation: '',
  message: '',
});

/** A kernel whose source shape (the recipes of op "brep" / "solid" / "faceBlend" / "fullRound") has the faces `before` and whose result has `after`; edge k joins the faces `edges[k]`. */
function scripted(before: string[], after: string[], edges: Array<[number, number]>): ExecutionContext {
  const kernel = {
    evaluate: (recipe: ShapeRecipe) => ({ recipe }),
    topology: (handle: { recipe: ShapeRecipe }) => ({
      faces: (handle.recipe.op === 'fillet' ? after : before).map((name) => ({
        name,
        ...(name.startsWith('blend(') ? {} : { normal: [0, 0, 1] }),
      })),
    }),
    faceQuery: { faceGraph: () => ({ edgeFaces: edges }) },
  } as unknown as GeometryKernel;
  return { kernel } as unknown as ExecutionContext;
}

const committed = (): CommandResult => ({
  document: { ...doc, order: ['mesh-2'], entities: { 'mesh-2': { id: 'mesh-2', kind: 'mesh', brep: { op: 'fillet' } } as never } },
  summary: 'filleted',
  affected: ['mesh-2'],
});
const SOURCES: Array<[string, ShapeRecipe]> = [
  ['a fillet', { op: 'fillet' } as unknown as ShapeRecipe],
  ['a face blend', { op: 'faceBlend' } as unknown as ShapeRecipe],
  ['a full round', { op: 'fullRound' } as unknown as ShapeRecipe],
  ['an imported B-rep', { op: 'brep' } as unknown as ShapeRecipe],
];
const plain: ShapeRecipe = { op: 'brep' } as unknown as ShapeRecipe;

describe('findKink', () => {
  // result faces: 0 old round, 1 new blend, 2 plane; edge 0 joins the new blend (1) to the old round (0), edge 1 the new blend to the plane
  const after = [ROUND, NEW, 'box:z+'];
  const edges: Array<[number, number]> = [
    [1, 0],
    [1, 2],
  ];

  it.each(SOURCES.slice(1))(
    'a contact of a new face against a blend face the source had, over the G1 limit, is the kink, whatever the source (%s); the worst angle wins',
    (_name, source) => {
      const ctx = scripted([ROUND, 'box:z+'], after, edges);
      const kink = findKink(doc, committed(), source, ctx, () => [fail(1, 0, 0.03), fail(1, 0, 0.044), fail(1, 1, 0.5)]);
      expect(kink).toMatchObject({ angleRad: 0.044, limitRad: 0.01, edge: 0, face: NEW, against: ROUND });
    },
  );

  it('a fail on a face the step did not create, a contact against a face that is not a blend, a warning or another code are not judged', () => {
    const ctx = scripted(
      [ROUND, OLD_BLEND, 'box:z+'],
      [ROUND, OLD_BLEND, NEW, 'box:z+'],
      [
        [1, 0],
        [2, 3],
      ],
    );
    // face 1 existed before (an old kink between two old blends): never judged
    expect(findKink(doc, committed(), plain, ctx, () => [fail(1, 0, 0.044)])).toBeNull();
    // the new face (2) against a plain face
    expect(findKink(doc, committed(), plain, ctx, () => [fail(2, 1, 0.044)])).toBeNull();
    expect(
      findKink(doc, committed(), plain, ctx, () => [
        { ...fail(2, 1, 0.044), severity: 'warn' },
        { ...fail(2, 1, 1), code: 'BLD_CHECK_G2_JUMP' },
      ]),
    ).toBeNull();
  });

  it('a first step between planes and a corner plate are not read back; only a new edge blend that rests on a curved face the source had is handed to the measurement', () => {
    const measure = (): Finding[] => {
      throw new Error('must not be measured');
    };
    // first step: the source has no curved face
    expect(
      findKink(doc, committed(), plain, scripted(['box:x-', 'box:z+'], ['box:x-', FIRST_STEP, 'box:z+'], [[1, 0]]), measure),
    ).toBeNull();
    // a corner plate is a new face but not an edge blend
    expect(findKink(doc, committed(), plain, scripted([ROUND, 'box:z+'], [ROUND, PLATE, 'box:z+'], [[1, 0]]), measure)).toBeNull();
    let asked: string[] = [];
    const ctx = scripted([ROUND, 'box:z+'], [ROUND, NEW, FIRST_STEP, 'box:z+'], [[1, 0]]);
    const kink = findKink(doc, committed(), plain, ctx, (_kernel, _entity, only) => {
      asked = [...only];
      return [fail(1, 0, 0.044)];
    });
    expect(asked).toEqual([NEW]);
    expect(kink).toMatchObject({ face: NEW, against: ROUND });
  });

  it('nothing new, a failed step (same document), a kernel without face queries: no kink and no measurement', () => {
    const measure = (): Finding[] => {
      throw new Error('must not be measured');
    };
    const same = scripted([ROUND, 'box:z+'], [ROUND, 'box:z+'], [[0, 1]]);
    expect(findKink(doc, committed(), plain, same, measure)).toBeNull();
    expect(findKink(doc, { ...committed(), document: doc }, plain, same, measure)).toBeNull();
    const blind = { kernel: { evaluate: () => ({}), topology: () => null } } as unknown as ExecutionContext;
    expect(findKink(doc, committed(), plain, blind, measure)).toBeNull();
  });
});

describe('kinkRefusal / kinkReported', () => {
  const kink = { angleRad: 0.044, limitRad: 0.01, edge: 4, face: NEW, against: ROUND };

  it('the refusal is BLD_FILLET_NOT_TANGENT at the caller path with the measured values and the allowNonTangent remedy, the document unchanged', () => {
    const refused = kinkRefusal(doc, 'fillet_edge', 'mesh-1', kink, 'edges');
    expect(refused.error?.code).toBe('BLD_FILLET_NOT_TANGENT');
    expect(refused.error?.paths).toEqual(['edges']);
    expect(refused.summary).toContain('0.044');
    expect(refused.summary).toContain('allowNonTangent');
    expect(refused.error?.remediation).toContain('allowNonTangent');
    expect(refused.document).toBe(doc);
  });

  it('allowNonTangent returns the result with the warning in the summary and the kink in data', () => {
    const reported = kinkReported({ ...committed(), data: { id: 'x' } }, kink);
    expect(reported.summary).toContain('Warning (allowNonTangent)');
    expect(reported.data).toMatchObject({ id: 'x', nonTangent: kink });
  });
});
