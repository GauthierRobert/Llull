/** Plant 05 ISO M3: check_isometric (VC-ISO-16): one positive and one negative per rule of the table, coded refusals, purity, determinism, budget. */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';
import { fixturePcf } from './fabricationFixtures';
import { loadedL101 } from './isoM2Fixtures';

interface Issue {
  lineId: string;
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  ids: string[];
  paths: string[];
  remediation: string;
}
interface Check {
  ok: boolean;
  lines: string[];
  issues: Issue[];
  counts: { error: number; warning: number; info: number; total: number };
}

const check = (doc: CadDocument, params: Record<string, unknown> = { lineId: 'L-101' }): Check =>
  data<Check>(doc, 'check_isometric', params);
const codes = (result: Check): string[] => result.issues.map((issue) => issue.code);
const issueOf = (result: Check, code: string): Issue | undefined => result.issues.find((issue) => issue.code === code);

/** `text` with the `n`th (1-based) occurrence of `needle` replaced. */
function replaceNth(text: string, needle: string, replacement: string, n = 1): string {
  let at = -1;
  for (let k = 0; k < n; k++) at = text.indexOf(needle, at + 1);
  if (at < 0) throw new Error(`no ${n}th "${needle}" in the fixture`);
  return text.slice(0, at) + replacement + text.slice(at + needle.length);
}

const grade = (): CadDocument => apply(createEmptyDocument(), 'add_level', { name: 'Grade', elevation: 0 });
const legacy = (points: number[][], extra: Record<string, unknown> = {}, base: CadDocument = grade()): CadDocument =>
  apply(base, 'add_pipe_run', { points, dn: 100, line: 'L-1', service: 'cooling water', ...extra });
const withText = (text: string): CadDocument => loadedL101(text);

describe('a clean line', () => {
  it('is ok: only the unnumbered-weld warning and the review notice remain, each with code, ids and remediation', () => {
    const result = check(loadedL101());
    expect(result.ok).toBe(true);
    expect(codes(result)).toEqual(['ISO_WELDS_UNNUMBERED', 'ISO_REVIEW_REQUIRED']);
    expect(result.counts).toEqual({ error: 0, warning: 1, info: 1, total: 2 });
    expect(result.lines).toEqual(['L-101']);
    expect(issueOf(result, 'ISO_WELDS_UNNUMBERED')?.ids).toHaveLength(13);
    for (const issue of result.issues) {
      expect(issue.remediation.length).toBeGreaterThan(0);
      expect(issue.lineId).toBe('L-101');
    }
  });

  it('numbered welds clear the warning', () => {
    const numbered = apply(loadedL101(), 'number_welds', { lineId: 'L-101' });
    expect(codes(check(numbered))).toEqual(['ISO_REVIEW_REQUIRED']);
  });

  it('is a query: the same document back, nothing affected, the same answer twice', () => {
    const doc = loadedL101();
    const before = JSON.stringify(doc);
    const result = execute(doc, 'check_isometric', { lineId: 'L-101' });
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    expect(JSON.stringify(doc)).toBe(before);
    expect(JSON.stringify(execute(doc, 'check_isometric', { lineId: 'L-101' }).data)).toBe(JSON.stringify(result.data));
    expect(result.summary).toContain('ok');
  });
});

describe('ISO_WELDS_UNNUMBERED: an error for the final style only', () => {
  it('final style: not ok before number_welds, ok after', () => {
    const result = check(loadedL101(), { lineId: 'L-101', style: 'final' });
    expect(result.ok).toBe(false);
    expect(issueOf(result, 'ISO_WELDS_UNNUMBERED')?.severity).toBe('error');
    expect(check(apply(loadedL101(), 'number_welds', { lineId: 'L-101' }), { lineId: 'L-101', style: 'final' }).ok).toBe(true);
  });
});

describe('ISO_DISCONNECTED', () => {
  it('two connection points 0.5 mm apart are an error naming both components (and the gap splits the line)', () => {
    const near = check(withText(replaceNth(fixturePcf(), 'END-POINT 2500.0 0.0 3000.0 100 BW', 'END-POINT 2500.5 0.0 3000.0 100 BW', 4)));
    expect(near.ok).toBe(false);
    const found = near.issues.filter((issue) => issue.code === 'ISO_DISCONNECTED');
    expect(found.every((issue) => issue.severity === 'error')).toBe(true);
    expect(found.some((issue) => issue.ids.length === 2 && issue.message.includes('closer than 1 mm'))).toBe(true);
  });

  it('a component not reachable from the line start is listed', () => {
    const far =
      'PIPE\n    COMPONENT-IDENTIFIER 16\n    END-POINT 20000.0 0.0 0.0 100 BW\n    END-POINT 21000.0 0.0 0.0 100 BW\n    ITEM-CODE PIPE-100-S40\nMATERIALS\n';
    const result = check(withText(fixturePcf().replace('MATERIALS\n', far)));
    expect(issueOf(result, 'ISO_DISCONNECTED')?.ids).toEqual(['pcf:L-101:16']);
    expect(result.ok).toBe(false);
  });

  it('the fixture and a 0.1 mm rounding difference are connected', () => {
    expect(codes(check(loadedL101()))).not.toContain('ISO_DISCONNECTED');
    const rounded = replaceNth(fixturePcf(), 'END-POINT 2500.0 0.0 3000.0 100 BW', 'END-POINT 2500.04 0.0 3000.0 100 BW', 4);
    expect(codes(check(withText(rounded)))).not.toContain('ISO_DISCONNECTED');
  });
});

describe('ISO_OPEN_END: by connectivity on an imported line, from / to on a legacy pipe', () => {
  const withoutLastFlange = (): string =>
    fixturePcf().slice(0, fixturePcf().indexOf('FLANGE\n    COMPONENT-IDENTIFIER 15')) +
    fixturePcf().slice(fixturePcf().indexOf('MATERIALS'));

  it('an imported line whose branch ends in a plain pipe has one open end, a warning with the position', () => {
    const issue = issueOf(check(withText(withoutLastFlange())), 'ISO_OPEN_END');
    expect(issue?.severity).toBe('warning');
    expect(issue?.ids).toEqual(['pcf:L-101:14']);
    expect(issue?.message).toContain('7105 4000 1424');
  });

  it('a cap (or a flanged end) closes the line end', () => {
    const cap = withoutLastFlange().replace(
      'MATERIALS\n',
      'CAP\n    COMPONENT-IDENTIFIER 15\n    END-POINT 7105.0 4000.0 1424.0 100 BW\n    SKEY CPBW\n    ITEM-CODE CAP-100\nMATERIALS\n',
    );
    expect(codes(check(withText(cap)))).not.toContain('ISO_OPEN_END');
  });

  it('a legacy pipe reports its free ends once each through the network, not twice', () => {
    const result = check(
      legacy([
        [0, 0, 0],
        [3000, 0, 0],
      ]),
      { lineId: 'L-1' },
    );
    const open = result.issues.filter((issue) => issue.code === 'ISO_OPEN_END');
    expect(open).toHaveLength(2);
    expect(open.every((issue) => issue.severity === 'warning')).toBe(true);
  });
});

describe('ISO_SKEY_MISSING and ISO_ITEM_CODE_MISSING', () => {
  it('an elbow without SKEY is an error, a tee without item code a warning', () => {
    const noKey = check(withText(replaceNth(fixturePcf(), '    SKEY ELBW\n', '')));
    expect(issueOf(noKey, 'ISO_SKEY_MISSING')?.severity).toBe('error');
    expect(issueOf(noKey, 'ISO_SKEY_MISSING')?.ids).toHaveLength(1);
    expect(noKey.ok).toBe(false);
    const noItem = check(withText(replaceNth(fixturePcf(), '    ITEM-CODE TEE-100-S40\n', '')));
    expect(issueOf(noItem, 'ISO_ITEM_CODE_MISSING')?.severity).toBe('warning');
    expect(noItem.ok).toBe(true);
  });

  it('the fixture has neither', () => {
    expect(codes(check(loadedL101()))).not.toContain('ISO_SKEY_MISSING');
    expect(codes(check(loadedL101()))).not.toContain('ISO_ITEM_CODE_MISSING');
  });
});

describe('spool limits: ISO_SPOOL_TOO_LARGE and ISO_SPOOL_TOO_HEAVY', () => {
  it('an envelope under the spool size is an error naming the spool', () => {
    const doc = apply(loadedL101(), 'set_fabrication_rules', {
      maxSpoolLengthMm: 6000,
      maxSpoolWidthMm: 3000,
      maxSpoolHeightMm: 3000,
      source: 'test shipping envelope',
    });
    const result = check(doc);
    expect(issueOf(result, 'ISO_SPOOL_TOO_LARGE')?.ids).toEqual(['L-101-SP02']);
    expect(result.ok).toBe(false);
  });

  it('a weight over the limit is ISO_SPOOL_TOO_HEAVY; an ample limit is clean', () => {
    const heavy = withText(replaceNth(fixturePcf(), '    ITEM-CODE PIPE-100-S40\n', '    ITEM-CODE PIPE-100-S40\n    WEIGHT 400\n'));
    const limited = apply(heavy, 'set_fabrication_rules', { maxSpoolWeightKg: 100, source: 'test crane' });
    expect(issueOf(check(limited), 'ISO_SPOOL_TOO_HEAVY')?.ids).toEqual(['L-101-SP01']);
    const ample = apply(heavy, 'set_fabrication_rules', { maxSpoolWeightKg: 5000, maxSpoolLengthMm: 20000, source: 'test crane' });
    expect(codes(check(ample))).not.toContain('ISO_SPOOL_TOO_HEAVY');
    expect(codes(check(ample))).not.toContain('ISO_SPOOL_TOO_LARGE');
  });
});

describe('ISO_CUT_LENGTH_SHORT', () => {
  it('a stored gap that eats a short piece is an error; a 3 mm gap is clean; no stored gap means no cut rule', () => {
    const big = apply(loadedL101(), 'set_fabrication_rules', { weldGapMm: 700, source: 'test' });
    const result = check(big);
    expect(issueOf(result, 'ISO_CUT_LENGTH_SHORT')?.severity).toBe('error');
    expect(issueOf(result, 'ISO_CUT_LENGTH_SHORT')?.ids.length).toBeGreaterThan(0);
    expect(codes(check(apply(loadedL101(), 'set_fabrication_rules', { weldGapMm: 3, source: 'test' })))).not.toContain(
      'ISO_CUT_LENGTH_SHORT',
    );
    expect(codes(check(loadedL101()))).not.toContain('ISO_CUT_LENGTH_SHORT');
  });

  it('a field-fit weld without a stored allowance leaves the cut rule out instead of guessing', () => {
    const fitted = apply(
      apply(loadedL101(), 'add_field_weld', { lineId: 'L-101', at: [3500, 0, 3000], type: 'field_fit' }),
      'set_fabrication_rules',
      { weldGapMm: 700, source: 'test' },
    );
    expect(codes(check(fitted))).not.toContain('ISO_CUT_LENGTH_SHORT');
  });
});

describe('legacy lines: derived fittings and unverified catalogue rows', () => {
  const corner = [
    [0, 0, 0],
    [5000, 0, 0],
    [5000, 5000, 0],
  ];

  it('derived elbows are a warning naming them', () => {
    const result = check(legacy(corner), { lineId: 'L-1' });
    expect(issueOf(result, 'ISO_LEGACY_FITTINGS_DERIVED')?.severity).toBe('warning');
    expect(issueOf(result, 'ISO_LEGACY_FITTINGS_DERIVED')?.ids).toHaveLength(1);
    expect(codes(result)).not.toContain('ISO_UNVERIFIED_CATALOGUE');
    expect(result.ok).toBe(true);
  });

  it('a size the catalogue does not know is flagged unverified and cannot be hidden', () => {
    const result = check(legacy(corner, { dn: 123, diameter: 130 }), { lineId: 'L-1' });
    expect(issueOf(result, 'ISO_UNVERIFIED_CATALOGUE')?.severity).toBe('warning');
  });

  it('a line whose elbows overlap cannot be read: it is an error finding with its own code, not a refusal', () => {
    const tight = legacy([
      [0, 0, 0],
      [3000, 0, 0],
      [3000, 100, 0],
      [6000, 100, 0],
    ]);
    const result = check(tight, { lineId: 'L-1' });
    expect(result.ok).toBe(false);
    expect(issueOf(result, 'ISO_SEGMENT_TOO_SHORT')?.severity).toBe('error');
  });
});

describe('ISO_SHEET_OVERFLOW', () => {
  const staircase = (steps: number): number[][] => {
    const points = [[0, 0, 0]];
    for (let k = 0; k < steps; k++) {
      const last = points[points.length - 1] as number[];
      points.push(k % 2 === 0 ? [(last[0] as number) + 3000, last[1] as number, 0] : [last[0] as number, (last[1] as number) + 3000, 0]);
    }
    return points;
  };

  it('a 40 piece staircase does not fit an A4 sheet; the fixture does', () => {
    const doc = legacy(staircase(40));
    expect(issueOf(check(doc, { lineId: 'L-1', paper: 'A4' }), 'ISO_SHEET_OVERFLOW')?.severity).toBe('warning');
    expect(codes(check(loadedL101(), { lineId: 'L-101', paper: 'A4' }))).not.toContain('ISO_SHEET_OVERFLOW');
  });
});

describe('scope and refusals', () => {
  it('without lineId every line is checked, in line order (imported, then legacy)', () => {
    const both = legacy(
      [
        [0, 0, 0],
        [3000, 0, 0],
      ],
      {},
      apply(loadedL101(), 'add_level', { name: 'Grade', elevation: 0 }),
    );
    const result = check(both, {});
    expect(result.lines).toEqual(['L-101', 'L-1']);
    expect([...new Set(result.issues.map((issue) => issue.lineId))]).toEqual(['L-101', 'L-1']);
  });

  it('an unknown line and a document without piping are refused with their codes, the document untouched', () => {
    expectRefusal(loadedL101(), 'check_isometric', { lineId: 'NOPE' }, 'ISO_LINE_NOT_FOUND', 'lineId');
    expectRefusal(createEmptyDocument(), 'check_isometric', {}, 'ISO_NO_PIPING');
  });

  it('an invalid paper is rejected by the schema', () => {
    const result = execute(loadedL101(), 'check_isometric', { lineId: 'L-101', paper: 'B7' });
    expect(result.rejected).toBe(true);
    expect(result.affected).toEqual([]);
  });
});

describe('budget', () => {
  it('a document with 120 legacy lines is checked well inside the 1 s of the 500 line budget (bound 3 x 1 s)', () => {
    let doc = grade();
    for (let k = 0; k < 120; k++)
      doc = legacy(
        [
          [0, k * 500, 0],
          [3000, k * 500, 0],
          [3000, k * 500 + 2000, 0],
        ],
        { line: `L-${k}` },
        doc,
      );
    const started = performance.now();
    const result = check(doc, {});
    expect(performance.now() - started).toBeLessThan(3000);
    expect(result.lines).toHaveLength(120);
  });
});
