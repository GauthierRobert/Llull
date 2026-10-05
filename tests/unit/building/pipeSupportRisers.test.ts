import { describe, expect, it } from 'vitest';
import type { CadDocument, Vec3 } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { buildingErrors } from '@aec/validate';
import { riserRuns } from '@aec/industrial/routeSupport';
import type { PipeSupportRow } from '@aec/industrial/pipeSupportCheck';
import { check } from './steelFixtures';
import { step, twoLevels } from './steelFixtures';
import { supportsOf } from './pipeSupportFixtures';

/** Steel member on level-1 (elevation 0: absolute coordinates). */
const steel = (
  doc: CadDocument,
  role: 'column' | 'beam',
  profile: string,
  start: Vec3,
  end: Vec3,
): CadDocument => step(doc, 'add_steel_member', { role, profile, start, end, levelId: 'level-1' });

/** DN100 (Ø114.3) route; table span 4.3 m, free-end limit 2.15 m. */
const pipe = (points: Vec3[], doc: CadDocument = twoLevels()): CadDocument =>
  step(doc, 'add_pipe_run', { levelId: 'level-1', dn: 100, line: 'L-9', points });

/** Riser of 3.8 m between two elbows: z 1000 → 4800 at the origin. */
const INTERIOR: Vec3[] = [
  [-3000, 0, 1000],
  [0, 0, 1000],
  [0, 0, 4800],
  [3000, 0, 4800],
];

const rowOf = (doc: CadDocument, params: Record<string, unknown> = {}): PipeSupportRow => {
  const data = execute(doc, 'check_pipe_supports', params).data as { pipes: PipeSupportRow[] };
  return data.pipes[0] as PipeSupportRow;
};

const supportAt = (
  doc: CadDocument,
  type: string,
  at: Vec3,
  extra: Record<string, unknown> = {},
): CadDocument => step(doc, 'add_pipe_support', { pipeId: 'pipe-1', type, at: [at], ...extra });

/** HEA200 post 500 mm east of the riser. */
const withPost = (doc: CadDocument, x = 500, y = 0): CadDocument =>
  steel(doc, 'column', 'HEA200', [x, y, 0], [x, y, 6000]);

describe('riser runs', () => {
  it('finds runs steeper than 0.7 and at least 0.5 m, skipping fittings and flat pipe', () => {
    expect(riserRuns(INTERIOR)).toEqual([
      { startArc: 3000, endArc: 6800, length: 3800, from: [0, 0, 1000], to: [0, 0, 4800] },
    ]);
    expect(
      riserRuns([
        [0, 0, 0],
        [0, 0, 400],
        [3000, 0, 400],
      ]),
    ).toEqual([]);
    expect(
      riserRuns([
        [0, 0, 0],
        [3000, 0, 0],
      ]),
    ).toEqual([]);
  });

  it('treats a steep inclined run as a riser and merges consecutive steep segments', () => {
    const runs = riserRuns([
      [0, 0, 0],
      [0, 0, 0],
      [1000, 0, 1500],
      [1000, 0, 3000],
      [4000, 0, 3000],
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ from: [0, 0, 0], to: [1000, 0, 3000] });
    expect(runs[0]?.length).toBeCloseTo(Math.hypot(1000, 1500) + 1500, 6);
    // slope 0.6 is a sloped line, not a riser
    expect(
      riserRuns([
        [0, 0, 0],
        [4000, 0, 2400],
      ]),
    ).toEqual([]);
  });
});

describe('riser verdict in check_pipe_supports', () => {
  it('fails an unguided riser between two elbows and an unsupported riser weight', () => {
    const row = rowOf(pipe(INTERIOR));
    expect(row.risers).toEqual([
      {
        fromZM: 1,
        toZM: 4.8,
        lengthM: 3.8,
        guides: 0,
        maxGuideSpacingM: 3.8,
        allowedSpacingM: 4.3,
        weightKn: expect.any(Number),
        weightBy: null,
        ok: false,
        issues: [
          expect.stringContaining(
            'no lateral guide (an unguided riser between two elbows may be 2.15 m at most)',
          ),
          expect.stringContaining('weight is carried by nothing'),
        ],
      },
    ]);
    expect(row.ok).toBe(false);
    expect(row.issues).toEqual(expect.arrayContaining(row.risers[0]?.issues ?? []));
    expect(row.notes).toEqual(['risers (3.80 m) are not counted in the spans']);
  });

  it('passes a guided riser whose weight is carried by a clamp, and reports the spacing', () => {
    let doc = withPost(pipe(INTERIOR));
    doc = supportAt(doc, 'guide', [0, 0, 2900]);
    expect(rowOf(doc).risers[0]).toMatchObject({ guides: 1, weightBy: null, ok: false });
    doc = supportAt(doc, 'shoe', [0, 0, 2000]);
    const row = rowOf(doc);
    expect(row.risers[0]).toMatchObject({
      guides: 1,
      maxGuideSpacingM: 1.9,
      weightBy: 'clamp',
      ok: true,
      issues: [],
    });
    // the horizontal legs still need their own supports: only the riser part is satisfied
    expect(row.issues.some((issue) => issue.includes('riser'))).toBe(false);
    expect(row.notes).toEqual(['risers (3.80 m) are not counted in the spans']);
  });

  it('lets an anchor guide and carry the riser weight at once', () => {
    const doc = supportAt(withPost(pipe(INTERIOR)), 'anchor', [0, 0, 2900]);
    expect(rowOf(doc).risers[0]).toMatchObject({ guides: 1, weightBy: 'clamp', ok: true });
  });

  it('accepts an attached support of the pipe near an elbow as the weight carrier', () => {
    let doc = supportAt(withPost(pipe(INTERIOR)), 'guide', [0, 0, 2900]);
    // beam under the lower leg 1.5 m from the elbow: IPE200 top of steel at the pipe underside
    doc = steel(doc, 'beam', 'IPE200', [-1500, -1000, 842.85], [-1500, 1000, 842.85]);
    doc = supportAt(doc, 'shoe', [-1500, 0, 1000]);
    expect(rowOf(doc).risers[0]).toMatchObject({ weightBy: 'elbow support', ok: true });
    // a support farther than overhangRatio × span (2.15 m) from the elbow does not
    let far = supportAt(withPost(pipe(INTERIOR)), 'guide', [0, 0, 2900]);
    far = steel(far, 'beam', 'IPE200', [-2900, -1000, 842.85], [-2900, 1000, 842.85]);
    far = supportAt(far, 'shoe', [-2900, 0, 1000]);
    expect(rowOf(far).risers[0]).toMatchObject({ weightBy: null, ok: false });
    // a loose overhangRatio accepts it
    expect(rowOf(far, { overhangRatio: 1 }).risers[0]?.weightBy).toBe('elbow support');
  });

  it('takes a riser that starts in equipment as carried at that end', () => {
    let doc = pipe([
      [0, 0, 500],
      [0, 0, 4500],
    ]);
    doc = step(doc, 'add_equipment', {
      name: 'Tank',
      location: [0, 0],
      size: [1000, 1000, 600],
      levelId: 'level-1',
    });
    const bare = rowOf(doc).risers[0];
    expect(bare).toMatchObject({ weightBy: 'carried end', guides: 0, ok: false });
    expect(bare?.issues[0]).toContain('end elbow is 4.00 m from the nearest lateral guide');
    const guided = rowOf(supportAt(withPost(doc), 'guide', [0, 0, 3000])).risers[0];
    expect(guided).toMatchObject({ guides: 1, maxGuideSpacingM: 2.5, ok: true });
  });

  it('fails a guide spacing above the table value between two carried ends', () => {
    let doc = pipe([
      [0, 0, 500],
      [0, 0, 6500],
    ]);
    doc = step(doc, 'add_level', { name: 'Top', elevation: 6000, height: 3000 });
    for (const levelId of ['level-1', 'level-3']) {
      doc = step(doc, 'add_equipment', {
        name: `Vessel ${levelId}`,
        location: [0, 0],
        size: [1000, 1000, 1000],
        levelId,
      });
    }
    const unguided = rowOf(doc);
    expect(unguided.endCarriers).toEqual(['equipment', 'equipment']);
    expect(unguided.risers[0]?.issues[0]).toContain(
      'lateral guide spacing 6.00 m exceeds 4.30 m allowed',
    );
    const guided = rowOf(supportAt(withPost(doc), 'guide', [0, 0, 3500]));
    expect(guided.risers[0]).toMatchObject({ guides: 1, maxGuideSpacingM: 3, ok: true });
    // the pipe verdict includes the riser: nothing else is wrong with this pipe
    expect(unguided.ok).toBe(false);
    expect(guided.ok).toBe(true);
    expect(guided.issues).toEqual([]);
    expect(
      rowOf(supportAt(withPost(doc), 'guide', [0, 0, 3500]), { spanFactor: 0.5 }).risers[0]
        ?.issues[0],
    ).toContain('lateral guide spacing 3.00 m exceeds 2.15 m allowed');
  });

  it('ignores an unattached guide, which also fails the pipe, and risers under 0.5 m', () => {
    const loose = supportAt(pipe(INTERIOR), 'guide', [0, 0, 2900]);
    const row = rowOf(loose);
    expect(row.unattached).toBe(1);
    expect(row.risers[0]).toMatchObject({ guides: 0, ok: false });
    expect(row.issues).toContain('support PS1 (guide) is attached to no steel member');
    const small = rowOf(
      pipe([
        [0, 0, 1000],
        [0, 0, 1400],
        [3000, 0, 1400],
      ]),
    );
    expect(small.risers).toEqual([]);
  });

  it('keeps risers out of the horizontal spans: a guide is no span support', () => {
    const doc = supportAt(withPost(pipe(INTERIOR)), 'guide', [0, 0, 2900]);
    const row = rowOf(doc);
    expect(row.supports).toBe(0);
    expect(row.basis).toBe('none');
    expect(row.issues[0]).toBe('no support: 6.00 m of pipe rest on nothing');
  });
});

describe('add_pipe_support on a riser', () => {
  it('brackets a guide to a column beside the pipe and draws a clamp with a bracket', () => {
    const result = execute(withPost(pipe(INTERIOR)), 'add_pipe_support', {
      pipeId: 'pipe-1',
      type: 'guide',
      at: [[0, 0, 2900]],
    });
    const [support] = supportsOf(result.document);
    expect(support).toMatchObject({
      type: 'guide',
      memberId: 'member-1',
      position: [0, 0, 2900],
      pedestalHeight: 0,
      rodLength: 0,
    });
    // 500 mm axis distance - 100 mm half of HEA200 (max(b, h) / 2) - 57.15 mm pipe radius
    expect(support?.standoff).toBeCloseTo(500 - 100 - 57.15, 6);
    expect(support?.standoffAngle).toBeCloseTo(0, 9);
    expect(result.affected).toEqual([
      'pipeSupport-1',
      'pipeSupport-1:clamp',
      'pipeSupport-1:bracket',
    ]);
    expect(result.summary).toContain('Added 1 guide(s) PS1 on pipe PL1, bearing on SC1');
    const bracket = result.document.entities['pipeSupport-1:bracket'];
    expect(bracket?.kind === 'box' ? bracket.size[1] : 0).toBeCloseTo(500 - 100 - 57.15 - 20, 6);
    expect(bracket?.position[0]).toBeCloseTo(57.15 + 20 + (500 - 100 - 57.15 - 20) / 2 + 0, 0);
    const data = result.data as { supports: Array<{ standoff: number }> };
    expect(data.supports[0]?.standoff).toBeCloseTo(342.85, 6);
  });

  it('aims the bracket at the member and picks a horizontal member at the clamp elevation', () => {
    let doc = steel(pipe(INTERIOR), 'column', 'HEA200', [0, 600, 0], [0, 600, 6000]);
    doc = supportAt(doc, 'anchor', [0, 0, 2000]);
    expect(supportsOf(doc)[0]?.standoffAngle).toBeCloseTo(Math.PI / 2, 9);
    // IPE300 along Y 500 mm east at z 2800 ± 150: reached at 2900 (within its section), not at 4000
    let beamDoc = steel(pipe(INTERIOR), 'beam', 'IPE300', [500, -2000, 2800], [500, 2000, 2800]);
    beamDoc = supportAt(beamDoc, 'guide', [0, 0, 2900]);
    expect(supportsOf(beamDoc)[0]).toMatchObject({ memberId: 'member-1' });
    const high = execute(beamDoc, 'add_pipe_support', {
      pipeId: 'pipe-1',
      type: 'guide',
      at: [[0, 0, 4000]],
    });
    expect(supportsOf(high.document)[1]?.memberId).toBeNull();
    expect(high.summary).toContain(
      'WARNING 1 unattached (no steel member below or beside the pipe',
    );
  });

  it('keeps the shortest bracket among several members and honours maxReach', () => {
    let doc = steel(pipe(INTERIOR), 'column', 'HEA200', [500, 0, 0], [500, 0, 6000]);
    doc = steel(doc, 'column', 'HEA200', [-450, 0, 0], [-450, 0, 6000]);
    doc = supportAt(doc, 'guide', [0, 0, 2900]);
    expect(supportsOf(doc)[0]?.memberId).toBe('member-2');
    expect(supportsOf(doc)[0]?.standoffAngle).toBeCloseTo(Math.PI, 9);
    const far = steel(pipe(INTERIOR), 'column', 'HEA200', [1200, 0, 0], [1200, 0, 6000]);
    expect(supportsOf(supportAt(far, 'guide', [0, 0, 2900]))[0]?.memberId).toBeNull();
    expect(supportsOf(supportAt(far, 'guide', [0, 0, 2900], { maxReach: 1100 }))[0]?.memberId).toBe(
      'member-1',
    );
  });

  it('refuses an explicit member that cannot take the bracket and a hanger on a riser', () => {
    const base = withPost(pipe(INTERIOR), 3000, 0);
    const tooFar = execute(base, 'add_pipe_support', {
      pipeId: 'pipe-1',
      type: 'guide',
      at: [[0, 0, 2900]],
      memberId: 'member-1',
    });
    expect(tooFar.document).toBe(base);
    expect(tooFar.summary).toContain('from the pipe surface (reach 500 mm)');
    const through = steel(pipe(INTERIOR), 'column', 'HEA200', [0, 50, 0], [0, 50, 6000]);
    expect(
      execute(through, 'add_pipe_support', {
        pipeId: 'pipe-1',
        type: 'guide',
        at: [[0, 0, 2900]],
        memberId: 'member-1',
      }).summary,
    ).toContain('would pass through the riser');
    const brace = steel(pipe(INTERIOR), 'beam', 'IPE300', [500, -500, 2000], [500, 500, 3500]);
    expect(
      execute(brace, 'add_pipe_support', {
        pipeId: 'pipe-1',
        type: 'guide',
        at: [[0, 0, 2900]],
        memberId: 'member-1',
      }).summary,
    ).toContain('is inclined');
    const above = withPost(pipe(INTERIOR));
    expect(
      execute(above, 'add_pipe_support', {
        pipeId: 'pipe-1',
        type: 'guide',
        at: [[0, 0, 2900]],
        memberId: 'member-1',
      }).document,
    ).not.toBe(above);
    const short = steel(pipe(INTERIOR), 'column', 'HEA200', [500, 0, 0], [500, 0, 1500]);
    expect(
      execute(short, 'add_pipe_support', {
        pipeId: 'pipe-1',
        type: 'guide',
        at: [[0, 0, 2900]],
        memberId: 'member-1',
      }).summary,
    ).toContain('spans z 0…1500 mm, not the riser elevation 2900 mm');
  });

  it('is skipped by automatic spacing and validated on load', () => {
    const doc = supportAt(withPost(pipe(INTERIOR)), 'guide', [0, 0, 2900]);
    const building = JSON.parse(JSON.stringify(doc.building));
    building.elements['pipeSupport-1'].standoff = -5;
    building.elements['pipeSupport-1'].standoffAngle = 'north';
    const errors = buildingErrors(building).join('\n');
    expect(errors).toContain('standoff must be >= 0');
    expect(errors).toContain('standoffAngle must be a finite number');
    expect(buildingErrors(JSON.parse(JSON.stringify(doc.building)))).toEqual([]);
  });
});

describe('riser supports in the steel check', () => {
  it('delivers no weight through a guide, and the riser weight through a clamp', () => {
    const guided = supportAt(withPost(pipe(INTERIOR)), 'guide', [0, 0, 2900]);
    const clamped = supportAt(withPost(pipe(INTERIOR)), 'shoe', [0, 0, 2900]);
    const lineOf = (doc: CadDocument): { supports: number; carriedKn: number } | undefined =>
      check(doc).loads.lines.find((line) => line.mark === 'PL1');
    expect(lineOf(guided)?.supports ?? 0).toBe(0);
    const carried = lineOf(clamped);
    expect(carried?.supports).toBe(1);
    expect(carried?.carriedKn).toBeGreaterThan(0.5);
  });
});
