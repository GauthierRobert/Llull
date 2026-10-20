/** 03 GDT review fixes: two-solid datum scoping, composite rules, review carry across replay, ctx.caller gate, stack-up details. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import { pmiReviewPayload } from '@core/commands/pmi/review';
import { setGeometryKernel } from '@core/geometry/kernel';
import { exactProbabilities, uniformSumCdf, type StackContributor } from '@lib/stackup';
import { parseStackExpression, stackGradient } from '@lib/stackExpression';
import { plateKernel } from '../../helpers/pmiPlateKernel';

beforeEach(() => setGeometryKernel(plateKernel()));
afterEach(() => setGeometryKernel(null));

const BOTTOM = [30, 10, 0];
const FRONT = [60, 0, 6];
const LEFT = [0, 40, 6];
const HOLE = [16.7, 20, 6];

interface Run {
  document: CadDocument;
  affected: string[];
}
function step(doc: CadDocument, name: string, params: Record<string, unknown>, ctx = defaultContext()): Run {
  const result = execute(doc, name, params, ctx);
  expect(result.rejected, result.summary).toBeUndefined();
  return { document: result.document, affected: result.affected };
}

/** Two solids; datum A on each; a hole size and a position FCF on the SECOND solid that references its datum A through targetPmiId. */
function twoSolids(): { doc: CadDocument; one: string; two: string; datumOne: string; datumTwo: string; fcfTwo: string; fcfOne: string } {
  let doc = createEmptyDocument();
  const a = step(doc, 'add_box', { size: [120, 80, 12] });
  const b = step(a.document, 'add_box', { size: [120, 80, 12] });
  const [one, two] = [a.affected[0] as string, b.affected[0] as string];
  doc = b.document;
  const datumOne = step(doc, 'add_datum_feature', { entityId: one, facesNear: [BOTTOM], label: 'A' });
  const datumTwo = step(datumOne.document, 'add_datum_feature', { entityId: two, facesNear: [BOTTOM], label: 'A' });
  const sizeTwo = step(datumTwo.document, 'add_size_dimension', {
    entityId: two,
    facesNear: [HOLE],
    sizeKind: 'diameter',
    tolerance: { type: 'plusMinus', upper: 0.1, lower: -0.1 },
  });
  const fcfTwo = step(sizeTwo.document, 'add_geometric_tolerance', {
    characteristic: 'position',
    targetPmiId: sizeTwo.affected[0],
    zone: { value: 0.3, diametral: true },
    datums: [{ label: 'A' }],
  });
  const sizeOne = step(fcfTwo.document, 'add_size_dimension', {
    entityId: one,
    facesNear: [HOLE],
    sizeKind: 'diameter',
    tolerance: { type: 'plusMinus', upper: 0.1, lower: -0.1 },
  });
  const fcfOne = step(sizeOne.document, 'add_geometric_tolerance', {
    characteristic: 'position',
    targetPmiId: sizeOne.affected[0],
    zone: { value: 0.3, diametral: true },
    datums: [{ label: 'A' }],
  });
  return {
    doc: fcfOne.document,
    one,
    two,
    datumOne: datumOne.affected[0] as string,
    datumTwo: datumTwo.affected[0] as string,
    fcfTwo: fcfTwo.affected[0] as string,
    fcfOne: fcfOne.affected[0] as string,
  };
}

describe('datum scope with pmiId targets across two solids', () => {
  it('rename touches only the frames of the same solid', () => {
    const s = twoSolids();
    const renamed = step(s.doc, 'update_pmi', { pmiId: s.datumOne, label: 'P' });
    expect(renamed.affected).toEqual([s.datumOne, s.fcfOne]);
    const other = renamed.document.pmi?.items[s.fcfTwo];
    expect(other?.kind === 'geometric_tolerance' && other.datums.map((d) => d.label)).toEqual(['A']);
  });

  it('delete refuses with the frames of its own solid only, and cascade leaves the other solid alone', () => {
    const s = twoSolids();
    const refused = execute(s.doc, 'delete_pmi', { pmiId: s.datumOne });
    expect(refused.error?.code).toBe('GDT_DATUM_REFERENCED');
    expect(refused.error?.ids).toEqual([s.fcfOne]);
    const cascade = step(s.doc, 'delete_pmi', { pmiId: s.datumOne, cascade: true });
    expect(cascade.affected).toContain(s.fcfOne);
    expect(cascade.affected).not.toContain(s.fcfTwo);
    expect(cascade.document.pmi?.items[s.fcfTwo]).toBeDefined();
  });
});

describe('composite frames', () => {
  function upper(): { doc: CadDocument; entityId: string; upperId: string } {
    const box = step(createEmptyDocument(), 'add_box', { size: [120, 80, 12] });
    const entityId = box.affected[0] as string;
    let doc = box.document;
    for (const [label, point] of [
      ['A', BOTTOM],
      ['B', FRONT],
    ] as const)
      doc = step(doc, 'add_datum_feature', { entityId, facesNear: [point], label }).document;
    const made = step(doc, 'add_geometric_tolerance', {
      characteristic: 'profile_surface',
      entityId,
      facesNear: [LEFT],
      zone: { value: 0.5 },
      datums: [{ label: 'A' }, { label: 'B' }],
    });
    return { doc: made.document, entityId, upperId: made.affected[0] as string };
  }

  it('lower segments follow a re-attach of the upper frame and stay valid after edits that change derived data', () => {
    const { doc, upperId } = upper();
    const lower = step(doc, 'add_geometric_tolerance', {
      characteristic: 'profile_surface',
      compositeOf: upperId,
      zone: { value: 0.2 },
      datums: [{ label: 'A' }],
    });
    const moved = step(lower.document, 'update_pmi', { pmiId: upperId, facesNear: [[60, 80, 6]] });
    expect(moved.affected).toEqual([upperId, lower.affected[0]]);
    const item = moved.document.pmi?.items[lower.affected[0] as string];
    expect(item?.kind === 'geometric_tolerance' && 'feature' in item.target && item.target.feature.facesNear).toEqual([[60, 80, 6]]);
    const report = execute(moved.document, 'check_pmi', {}).data as { errors: Array<{ code: string }> };
    expect(report.errors.map((e) => e.code)).not.toContain('GDT_COMPOSITE_INVALID');
  });

  it('refuses an equal zone and datums that are not an ordered subset of the upper frame', () => {
    const { doc, upperId } = upper();
    const code = (params: Record<string, unknown>): string | undefined =>
      execute(doc, 'add_geometric_tolerance', { characteristic: 'profile_surface', compositeOf: upperId, ...params }).error?.code;
    expect(code({ zone: { value: 0.5 } })).toBe('GDT_COMPOSITE_INVALID');
    expect(code({ zone: { value: 0.2 }, datums: [{ label: 'B' }, { label: 'A' }] })).toBe('GDT_COMPOSITE_INVALID');
    expect(code({ zone: { value: 0.2 }, datums: [{ label: 'A' }, { label: 'B' }] })).toBeUndefined();
  });

  it('editing the upper zone so a lower segment becomes invalid is refused', () => {
    const { doc, upperId } = upper();
    const lower = step(doc, 'add_geometric_tolerance', { characteristic: 'profile_surface', compositeOf: upperId, zone: { value: 0.2 } });
    const refused = execute(lower.document, 'update_pmi', { pmiId: upperId, zone: { value: 0.1 } });
    expect(refused.error?.code).toBe('GDT_COMPOSITE_INVALID');
    expect(refused.document).toBe(lower.document);
  });
});

describe('accept_pmi_review: a verified signature, never a caller label', () => {
  /** A scripted port: it clears an act whose confirmation signature IS the payload it verifies (an act-bound signature by `as`). */
  const signer = {
    verify: (confirmation: unknown, payload: string) =>
      typeof confirmation === 'object' && confirmation !== null && (confirmation as { signature?: unknown }).signature === payload
        ? { signer: String((confirmation as { as?: unknown }).as), signatureId: 's' }
        : null,
  };
  const signed = (doc: CadDocument, id: string, as: string, comment = ''): Record<string, unknown> => ({
    nonce: 'n-accept',
    as,
    signature: pmiReviewPayload(doc, [id], 'accept', comment, 'n-accept'),
  });
  const accept = (
    doc: CadDocument,
    id: string,
    ctx: ReturnType<typeof defaultContext>,
    confirmation?: Record<string, unknown>,
  ): ReturnType<typeof execute> =>
    execute(
      doc,
      'accept_pmi_review',
      { pmiIds: [id], decision: 'accept', comment: '', at: '2026-10-20', ...(confirmation === undefined ? {} : { confirmation }) },
      ctx,
    );

  function oneDatum(): { doc: CadDocument; id: string } {
    const box = step(createEmptyDocument(), 'add_box', { size: [120, 80, 12] });
    const datum = step(box.document, 'add_datum_feature', { entityId: box.affected[0], facesNear: [BOTTOM], label: 'A' });
    return { doc: datum.document, id: datum.affected[0] as string };
  }

  it('is always refused without a signature over this act: no label, no port, a forged or foreign signature', () => {
    const { doc, id } = oneDatum();
    const withPort = { ...defaultContext(), humanSignature: signer };
    // a caller label is ignored (the field no longer exists): only the signature counts
    const labelled = { ...withPort, caller: { kind: 'human', userId: 'grace' } } as typeof withPort;
    for (const [ctx, confirmation] of [
      [withPort, undefined],
      [labelled, undefined],
      [{ ...defaultContext(), humanSignature: null }, signed(doc, id, 'grace')],
      [withPort, { ...signed(doc, id, 'grace'), signature: 'forged' }],
      [withPort, { ...signed(doc, id, 'grace'), signature: pmiReviewPayload(doc, [id], 'accept', 'other comment', 'n-accept') }],
    ] as const) {
      const result = accept(doc, id, ctx, confirmation);
      expect(result.error?.code).toBe('GDT_REVIEW_HUMAN_ONLY');
      expect(result.document).toBe(doc);
    }
    const ok = accept(doc, id, withPort, signed(doc, id, 'Ada'));
    expect(ok.document.pmi?.items[id]?.review).toMatchObject({ required: false, acceptedBy: 'Ada' });
  });

  it('a signature binds the content of the reviewed items: edit the item after signing and the old signature no longer clears', () => {
    const { doc, id } = oneDatum();
    const confirmation = signed(doc, id, 'grace');
    const edited = execute(doc, 'update_pmi', { pmiId: id, label: 'B' }).document;
    expect(edited.pmi?.items[id]).not.toEqual(doc.pmi?.items[id]);
    const refused = accept(edited, id, { ...defaultContext(), humanSignature: signer }, confirmation);
    expect(refused.error?.code).toBe('GDT_REVIEW_HUMAN_ONLY');
    expect(accept(doc, id, { ...defaultContext(), humanSignature: signer }, confirmation).document.pmi?.items[id]?.review.required).toBe(
      false,
    );
  });

  it('keeps a sign-off across a replay while the item is unchanged, and drops it when its content changed', () => {
    const box = step(createEmptyDocument(), 'add_box', { size: [120, 80, 12] });
    const entityId = box.affected[0] as string;
    const size = step(box.document, 'add_size_dimension', {
      entityId,
      facesNear: [HOLE],
      sizeKind: 'diameter',
      tolerance: { type: 'plusMinus', upper: 0.1, lower: -0.1 },
    });
    const id = size.affected[0] as string;
    const accepted = accept(
      size.document,
      id,
      { ...defaultContext(), humanSignature: signer },
      signed(size.document, id, 'grace'),
    ).document;
    expect(accepted.pmi?.items[id]?.review.required).toBe(false);
    const replayed = execute(accepted, 'replay_history', {}).document;
    expect(replayed.pmi?.items[id]?.review).toMatchObject({ required: false, acceptedBy: 'grace' });
    const original = accepted.featureHistory.find((s) => s.name === 'add_size_dimension');
    const stepId = original?.id as string;
    const edited = execute(accepted, 'edit_step_params', {
      stepId,
      params: { ...(original?.params as object), tolerance: { type: 'plusMinus', upper: 0.2, lower: -0.2 } },
    });
    expect(edited.document.pmi?.items[id]?.review.required).toBe(true);
  });
});

describe('stack-up details', () => {
  it('upper-tail probability of uniform terms is exact (symmetry, no cancellation)', () => {
    const halves = Array.from({ length: 12 }, () => 0.5);
    const tail = 0.1 ** 12 / 479001600;
    expect(Math.abs(uniformSumCdf(halves, -5.9) / tail - 1)).toBeLessThan(1e-9);
    expect(Math.abs((1 - uniformSumCdf(halves, 5.9)) / tail - 1)).toBeGreaterThan(1e-3);
    const items = halves.map(
      (h, i): StackContributor => ({ name: `c${i}`, nominal: 0, lower: -h, upper: h, sensitivity: 1, distribution: 'uniform' }),
    );
    const p = exactProbabilities(items, 0, 3, undefined, 5.9);
    expect(Math.abs((p?.pAbove ?? 0) / tail - 1)).toBeLessThan(1e-9);
    expect(uniformSumCdf([0.5, 0.5], 0.2)).toBeCloseTo(1 - uniformSumCdf([0.5, 0.5], -0.2), 12);
  });

  it('pow with a non-positive base and a constant exponent has an exact finite gradient', () => {
    const parsed = parseStackExpression('pow(A, 2) + pow(A, 3)', ['A']);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const { value, gradient } = stackGradient(parsed.tree, [-3]);
    expect(value).toBe(9 - 27);
    expect(gradient[0]).toBeCloseTo(2 * -3 + 3 * 9, 12);
  });

  it('Monte Carlo acceptance carries pAbove when an upper limit is given; angle links are in degrees', () => {
    const contributors = [
      { name: 'a', nominal: 10, upper: 0.1, lower: -0.1, verified: true },
      { name: 'b', nominal: 5, upper: 0.1, lower: -0.1, verified: true },
    ];
    const run = execute(createEmptyDocument(), 'analyze_stackup', {
      contributors,
      upperSpecLimit: 15.2,
      methods: ['monteCarlo'],
      samples: 2000,
    });
    const data = run.data as { monteCarlo: { acceptance: { pAbove?: number } }; pAbove: number };
    expect(data.pAbove).toBeGreaterThan(0);
    expect(data.monteCarlo.acceptance.pAbove).toBeGreaterThan(0);
    const box = step(createEmptyDocument(), 'add_box', { size: [120, 80, 12] });
    const entityId = box.affected[0] as string;
    const angle = step(box.document, 'add_location_dimension', {
      entityId,
      from: [FRONT],
      to: [LEFT],
      measure: 'angle',
      tolerance: { type: 'plusMinus', upper: 0.5, lower: -0.5 },
    });
    const linked = execute(angle.document, 'analyze_stackup', { contributors: [{ name: 'phi', pmiId: angle.affected[0] }] }).data as {
      contributors: Array<{ unit: string }>;
    };
    expect(linked.contributors[0]?.unit).toBe('deg');
    const chain = execute(angle.document, 'stackup_at_temperature', {
      contributors: [
        {
          name: 'phi',
          pmiId: angle.affected[0],
          cte: { alpha: { value: 1e-5, unit: '1/K' }, referenceTemperature: { value: 20, unit: 'degC' } },
        },
      ],
      specTemperature: { value: 20, unit: 'degC' },
      temperatures: [{ value: 50, unit: 'degC' }],
    });
    expect((chain.data as { code: string }).code).toBe('TMC_STACKUP_INVALID');
  });

  it('fastener_tolerance validates sizes and bounds a fixed part by its own share', () => {
    const run = (p: Record<string, unknown>): ReturnType<typeof execute> =>
      execute(createEmptyDocument(), 'fastener_tolerance', {
        holeMmc: 6.6,
        fastenerMmc: 6,
        type: 'fixed',
        split: 0.25,
        statedPosition: 0.3,
        ...p,
      });
    expect(run({ holeMmc: 0 }).rejected).toBe(true);
    expect(run({ fastenerMmc: -1 }).rejected).toBe(true);
    expect((run({}).data as { statedWithinClearance: boolean }).statedWithinClearance).toBe(false);
    expect((run({ part: 2 }).data as { statedWithinClearance: boolean }).statedWithinClearance).toBe(true);
  });
});
