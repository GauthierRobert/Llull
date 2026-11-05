import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SKIP_RUN_ENV, requireTool, requireTools, skipRoot, toolFamily } from '../../requireTool';
import { parseRequired, summarize } from '../../requireToolTeardown';

const run = `unit-${process.pid}-${Date.now()}`;
const directory = join(skipRoot(), run);

afterEach(() => {
  delete process.env[SKIP_RUN_ENV];
  rmSync(directory, { recursive: true, force: true });
});

const recorded = (): Array<{ tool: string; family: string }> =>
  readdirSync(directory).flatMap((file) =>
    readFileSync(join(directory, file), 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as { tool: string; family: string }),
  );

describe('requireTool (TR-INT-13)', () => {
  it('returns false and records nothing when the tool is available', () => {
    process.env[SKIP_RUN_ENV] = run;
    expect(requireTool('calculix', true)).toBe(false);
    expect(() => readdirSync(directory)).toThrow();
  });

  it('returns the skip condition and records the tool and its family when it is missing', () => {
    process.env[SKIP_RUN_ENV] = run;
    expect(requireTool('native:llull-kernel', false)).toBe(true);
    expect(
      requireTools([
        ['python', false],
        ['calculix', true],
        ['oracle:xmllint', false],
      ]),
    ).toBe(true);
    expect(recorded()).toEqual([
      { tool: 'native:llull-kernel', family: 'native' },
      { tool: 'python', family: 'python' },
      { tool: 'oracle:xmllint', family: 'oracle' },
    ]);
    expect(toolFamily('native:llull-mesh')).toBe('native');
  });

  it('prints the skipped-by-tool counts and passes when no skipped tool is required', () => {
    const result = summarize([{ tool: 'calculix', family: 'calculix' }], parseRequired(undefined).entries);
    expect(result).toEqual({ line: 'skipped by tool: calculix 1, python 0, native 0', failure: null });
  });

  it('fails with TST_REQUIRED_TOOL_SKIPPED when a required tool caused a skip', () => {
    const records = [
      { tool: 'calculix', family: 'calculix' },
      { tool: 'native:llull-mesh', family: 'native' },
    ] as const;
    const result = summarize(records, parseRequired('calculix, python').entries);
    expect(result.failure).toContain('TST_REQUIRED_TOOL_SKIPPED');
    expect(result.failure).toContain('calculix');
    expect(result.failure).not.toContain('llull-mesh');
    expect(summarize(records, parseRequired('python').entries).failure).toBeNull();
    expect(summarize(records, parseRequired('calculix,python,native').entries).failure).toContain('llull-mesh');
  });

  it('records nothing when no run is active (no ad-hoc directory accumulates)', () => {
    delete process.env[SKIP_RUN_ENV];
    expect(requireTool('python', false)).toBe(true);
    expect(existsSync(join(skipRoot(), 'adhoc'))).toBe(false);
  });

  it('matches an exact tool id as well as a family, and a python capability id', () => {
    const records = [
      { tool: 'native:llull-mesh', family: 'native' },
      { tool: 'python:ocp', family: 'python' },
    ] as const;
    expect(parseRequired('native:llull-kernel').entries).toEqual(['native:llull-kernel']);
    expect(summarize(records, parseRequired('native:llull-kernel').entries).failure).toBeNull();
    expect(summarize(records, parseRequired('native:llull-mesh').entries).failure).toContain('native:llull-mesh');
    expect(summarize(records, parseRequired('python:ocp').entries).failure).toContain('python:ocp');
    expect(summarize(records, parseRequired('python').entries).failure).toContain('python:ocp');
  });

  it('reports unknown names instead of dropping them', () => {
    expect(parseRequired('Python, calculix:x, native:, pyton,native:llull-kernel,')).toEqual({
      entries: ['native:llull-kernel'],
      unknown: ['Python', 'calculix:x', 'native:', 'pyton'],
    });
  });
});
